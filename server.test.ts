import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { type NotificationState } from "./server";

type SubjectKind = "PullRequest" | "Issue";

function githubNotification(id: string, kind: SubjectKind) {
  const number = kind === "PullRequest" ? 12 : 34;
  return {
    id,
    unread: true,
    reason: "subscribed",
    updated_at: "2025-01-01T00:00:00Z",
    subject: {
      title: kind === "PullRequest" ? "Ship the feature" : "Fix the bug",
      url: `https://api.github.com/repos/acme/widgets/${kind === "PullRequest" ? "pulls" : "issues"}/${number}`,
      type: kind,
    },
    repository: {
      full_name: "acme/widgets",
      html_url: "https://github.com/acme/widgets",
    },
  };
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub release links", () => {
  it("links release notifications to the release page", async () => {
    const releaseNotification = {
      id: "release-1",
      unread: true,
      reason: "subscribed",
      updated_at: "2025-01-01T00:00:00Z",
      subject: {
        title: "Version 2.0.0",
        url: "https://api.github.com/repos/acme/widgets/releases/123",
        type: "Release",
      },
      repository: {
        full_name: "acme/widgets",
        html_url: "https://github.com/acme/widgets",
      },
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/notifications?")) {
        return Response.json([releaseNotification]);
      }
      expect(url).toBe("https://api.github.com/repos/acme/widgets/releases/123");
      return Response.json({ html_url: "https://github.com/acme/widgets/releases/tag/v2.0.0" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { bb, harness } = createFakePluginHost({
      pluginId: "github-notifications",
      settings: { token: "github-token" },
    });
    await plugin(bb);

    const state = await harness.behavior.callRpc("notifications_sync", null) as NotificationState;
    expect(state.notifications[0]?.url).toBe("https://github.com/acme/widgets/releases/tag/v2.0.0");

    await harness.lifecycle.dispose();
  });
});

describe("pull request reviews", () => {
  it("lets BB resolve the matched project's remembered execution defaults", async () => {
    const notification = githubNotification("pr-review", "PullRequest");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/notifications?")) {
        return Response.json([notification]);
      }
      return Response.json({ state: "open", merged_at: null, draft: false });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { bb, harness } = createFakePluginHost({
      pluginId: "github-notifications",
      settings: { token: "github-token" },
      sdk: {
        projects: {
          list: async () => [{
            id: "integrity-finance",
            gitRemoteUrl: "git@github.com:acme/widgets.git",
          }],
        },
        threads: {
          spawn: async () => ({ id: "review-thread" }),
        },
      },
    });
    await plugin(bb);
    await harness.behavior.callRpc("notifications_sync", null);

    await expect(harness.behavior.callRpc("notifications_investigate", { id: "pr-review" })).resolves.toEqual({
      threadId: "review-thread",
      projectId: "integrity-finance",
    });
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([[
      {
        projectId: "integrity-finance",
        environment: { type: "project-default" },
        title: "Review PR: Ship the feature",
        prompt: [
          "Review this GitHub pull request notification: https://github.com/acme/widgets/pull/12",
          "Repository: acme/widgets",
          "Title: Ship the feature",
          "Inspect the pull request, its changes, discussion, review state, and CI status. Summarize what needs attention, identify risks or blockers, and recommend the next action. Do not modify code unless I ask you to after the investigation.",
        ].join("\n\n"),
        origin: "plugin",
        originPluginId: "github-notifications",
      },
    ]]);
    expect(harness.sdk.callsTo("projects.defaultExecutionOptions")).toEqual([]);
    expect(harness.sdk.callsTo("providers.list")).toEqual([]);
    expect(harness.sdk.callsTo("providers.models")).toEqual([]);

    await harness.lifecycle.dispose();
  });
});

describe("GitHub subject status sync", () => {
  it("refreshes stored pull request and issue statuses when the notifications feed is unchanged", async () => {
    const notifications = [githubNotification("pr-1", "PullRequest"), githubNotification("issue-1", "Issue")];
    let feedRequests = 0;
    const subjectRequests = new Map<string, number>();

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/notifications?")) {
        feedRequests += 1;
        if (feedRequests === 1) {
          return Response.json(notifications, { headers: { etag: '"feed-v1"' } });
        }
        expect(header(init, "If-None-Match")).toBe('"feed-v1"');
        return new Response(null, { status: 304 });
      }

      const requestNumber = (subjectRequests.get(url) ?? 0) + 1;
      subjectRequests.set(url, requestNumber);
      const isPullRequest = url.includes("/pulls/");
      if (requestNumber === 1) {
        expect(header(init, "If-None-Match")).toBeNull();
        return Response.json(
          { state: "open", ...(isPullRequest ? { merged_at: null, draft: true } : {}) },
          { headers: { etag: `"${isPullRequest ? "pr" : "issue"}-v1"` } },
        );
      }

      expect(header(init, "If-None-Match")).toBe(`"${isPullRequest ? "pr" : "issue"}-v1"`);
      return Response.json(
        { state: "closed", ...(isPullRequest ? { merged_at: "2025-01-02T00:00:00Z", draft: false } : {}) },
        { headers: { etag: `"${isPullRequest ? "pr" : "issue"}-v2"` } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { bb, harness } = createFakePluginHost({
      pluginId: "github-notifications",
      settings: { token: "github-token" },
    });
    await plugin(bb);

    const first = await harness.behavior.callRpc("notifications_sync", null) as NotificationState;
    expect(first.notifications.map(({ type, status, draft }) => ({ type, status, draft }))).toEqual([
      { type: "pull_request", status: "open", draft: true },
      { type: "issue", status: "open", draft: null },
    ]);

    const second = await harness.behavior.callRpc("notifications_sync", null) as NotificationState;
    expect(second.notifications.map(({ type, status, draft }) => ({ type, status, draft }))).toEqual([
      { type: "pull_request", status: "merged", draft: false },
      { type: "issue", status: "closed", draft: null },
    ]);
    expect(subjectRequests).toEqual(new Map([
      ["https://api.github.com/repos/acme/widgets/pulls/12", 2],
      ["https://api.github.com/repos/acme/widgets/issues/34", 2],
    ]));

    await harness.lifecycle.dispose();
  });
});
