import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const notificationSchema = z.object({
  id: z.string(),
  repository: z.string(),
  repositoryUrl: z.string().url(),
  title: z.string(),
  type: z.enum(["pull_request", "issue", "other"]),
  status: z.enum(["open", "closed", "merged"]).nullable(),
  reason: z.string(),
  url: z.string().url().nullable(),
  unread: z.boolean(),
  updatedAt: z.string(),
  firstSeenAt: z.string(),
});
export type Notification = z.infer<typeof notificationSchema>;

const stateSchema = z.object({
  notifications: z.array(notificationSchema),
  counts: z.object({ pullRequests: z.number().int().nonnegative(), issues: z.number().int().nonnegative() }),
  configured: z.boolean(),
  syncing: z.boolean(),
  lastSyncedAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type NotificationState = z.infer<typeof stateSchema>;

export const rpcContract = defineRpcContract({
  notifications_state: { input: z.null(), output: stateSchema },
  notifications_archive: {
    input: z.object({ id: z.string().min(1).max(100) }).strict(),
    output: z.object({ archived: z.boolean() }),
  },
  notifications_mark_read: {
    input: z.object({ id: z.string().min(1).max(100) }).strict(),
    output: z.object({ markedRead: z.boolean() }),
  },
  notifications_sync: { input: z.null(), output: stateSchema },
  notifications_investigate: {
    input: z.object({ id: z.string().min(1).max(100) }).strict(),
    output: z.object({ threadId: z.string(), projectId: z.string() }),
  },
  oauth_start: {
    input: z.null(),
    output: z.object({
      flowId: z.string(),
      userCode: z.string(),
      verificationUri: z.string().url(),
      expiresAt: z.string(),
      intervalSeconds: z.number().int().positive(),
    }),
  },
  oauth_poll: {
    input: z.object({ flowId: z.string().uuid() }).strict(),
    output: z.object({
      status: z.enum(["pending", "complete", "expired", "denied", "error"]),
      retryAfterSeconds: z.number().int().nonnegative().nullable(),
      message: z.string().nullable(),
    }),
  },
});

const githubNotificationSchema = z.object({
  id: z.string(),
  unread: z.boolean(),
  reason: z.string(),
  updated_at: z.string(),
  subject: z.object({
    title: z.string(),
    url: z.string().nullable(),
    type: z.string(),
  }),
  repository: z.object({
    full_name: z.string(),
    html_url: z.string().url(),
  }),
});
type GithubNotification = z.infer<typeof githubNotificationSchema>;
type NotificationStatus = Notification["status"];

const githubSubjectSchema = z.object({
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable().optional(),
});

type DeviceFlow = {
  deviceCode: string;
  expiresAt: number;
  intervalSeconds: number;
  nextPollAt: number;
};

const NOTIFICATIONS_CHANGED = "notifications-changed";
const GITHUB_CLIENT_ID = "Ov23liseV7v7LbRDbOLY";
const DEFAULT_POLL_SECONDS = 60;
const MAX_PAGES = 10;

function notificationType(type: string): Notification["type"] {
  if (type === "PullRequest") return "pull_request";
  if (type === "Issue") return "issue";
  return "other";
}

function notificationStatus(value: unknown): NotificationStatus {
  return value === "open" || value === "closed" || value === "merged" ? value : null;
}

function webUrl(notification: GithubNotification): string | null {
  if (notification.subject.url === null) return notification.repository.html_url;
  const number = notification.subject.url.match(/\/(?:pulls|issues)\/(\d+)$/)?.[1];
  if (number === undefined) return notification.repository.html_url;
  const segment = notification.subject.type === "PullRequest" ? "pull" : "issues";
  return `${notification.repository.html_url}/${segment}/${number}`;
}

function nextPage(link: string | null): string | null {
  if (link === null) return null;
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

function githubRepositorySlug(remoteUrl: string | null): string | null {
  if (remoteUrl === null) return null;
  const withoutSuffix = remoteUrl.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const match = withoutSuffix.match(
    /^(?:https?:\/\/github\.com\/|ssh:\/\/(?:git@)?github\.com(?::\d+)?\/|git@github\.com:)([^/\s]+)\/([^/#\s]+)$/i,
  );
  return match === null ? null : `${match[1]}/${match[2]}`.toLowerCase();
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    token: { type: "string", label: "GitHub personal access token", secret: true },
    pollInterval: {
      type: "select",
      label: "Polling interval",
      options: ["60", "120", "300"],
      default: "60",
    },
  });

  // Stay healthy while disconnected so the sidebar panel remains available;
  // the panel itself owns the OAuth setup flow.
  const initialSettings = await settings.get();

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        repository_url TEXT NOT NULL,
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        reason TEXT NOT NULL,
        url TEXT,
        unread INTEGER NOT NULL,
        github_updated_at TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE INDEX notifications_inbox ON notifications (archived_at, github_updated_at DESC);
      CREATE TABLE sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        etag TEXT,
        last_synced_at TEXT,
        last_error TEXT,
        poll_seconds INTEGER NOT NULL DEFAULT 60
      );
      INSERT INTO sync_state (id) VALUES (1);
    `,
    "ALTER TABLE notifications ADD COLUMN status TEXT;",
    "UPDATE sync_state SET etag = NULL;",
    "ALTER TABLE notifications ADD COLUMN status_etag TEXT;",
  ]);

  let syncInFlight: Promise<void> | null = null;
  let configured = Boolean(initialSettings.token);
  const deviceFlows = new Map<string, DeviceFlow>();

  function readState(): NotificationState {
    const rows = db.prepare(`
      SELECT id, repository, repository_url, title, type, status, reason, url, unread,
             github_updated_at, first_seen_at
      FROM notifications
      WHERE archived_at IS NULL
      ORDER BY github_updated_at DESC
      LIMIT 500
    `).all() as Array<Record<string, unknown>>;
    const notifications = rows.map((row) => ({
      id: String(row.id),
      repository: String(row.repository),
      repositoryUrl: String(row.repository_url),
      title: String(row.title),
      type: notificationType(String(row.type) === "pull_request" ? "PullRequest" : String(row.type) === "issue" ? "Issue" : "Other"),
      status: notificationStatus(row.status),
      reason: String(row.reason),
      url: row.url === null ? null : String(row.url),
      unread: row.unread === 1,
      updatedAt: String(row.github_updated_at),
      firstSeenAt: String(row.first_seen_at),
    }));
    const counts = db.prepare(`
      SELECT
        SUM(CASE WHEN type = 'pull_request' AND unread = 1 THEN 1 ELSE 0 END) AS pull_requests,
        SUM(CASE WHEN type = 'issue' AND unread = 1 THEN 1 ELSE 0 END) AS issues
      FROM notifications WHERE archived_at IS NULL
    `).get() as { pull_requests: number | null; issues: number | null };
    const sync = db.prepare("SELECT last_synced_at, last_error FROM sync_state WHERE id = 1").get() as {
      last_synced_at: string | null;
      last_error: string | null;
    };
    return {
      notifications,
      counts: { pullRequests: counts.pull_requests ?? 0, issues: counts.issues ?? 0 },
      configured,
      syncing: syncInFlight !== null,
      lastSyncedAt: sync.last_synced_at,
      lastError: sync.last_error,
    };
  }

  const upsert = db.prepare(`
    INSERT INTO notifications (
      id, repository, repository_url, title, type, status, reason, url, unread,
      github_updated_at, first_seen_at, synced_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      repository = excluded.repository,
      repository_url = excluded.repository_url,
      title = excluded.title,
      type = excluded.type,
      status = COALESCE(excluded.status, notifications.status),
      reason = excluded.reason,
      url = excluded.url,
      unread = excluded.unread,
      archived_at = CASE
        WHEN excluded.github_updated_at > notifications.github_updated_at THEN NULL
        ELSE notifications.archived_at
      END,
      github_updated_at = excluded.github_updated_at,
      synced_at = excluded.synced_at
  `);

  const persistSync = db.transaction((notifications: GithubNotification[], etag: string | null, pollSeconds: number, complete: boolean) => {
    const now = new Date().toISOString();
    if (complete) db.prepare("UPDATE notifications SET unread = 0").run();
    for (const notification of notifications) {
      upsert.run(
        notification.id,
        notification.repository.full_name,
        notification.repository.html_url,
        notification.subject.title,
        notificationType(notification.subject.type),
        null,
        notification.reason,
        webUrl(notification),
        notification.unread ? 1 : 0,
        notification.updated_at,
        now,
        now,
      );
    }
    db.prepare(`
      UPDATE sync_state
      SET etag = ?, last_synced_at = ?, last_error = NULL, poll_seconds = ?
      WHERE id = 1
    `).run(etag, now, pollSeconds);
  });

  async function refreshStoredStatuses(headers: Record<string, string>): Promise<void> {
    const rows = db.prepare(`
      SELECT id, repository, type, url, status_etag
      FROM notifications
      WHERE archived_at IS NULL AND type IN ('pull_request', 'issue') AND url IS NOT NULL
      LIMIT 500
    `).all() as Array<{
      id: string;
      repository: string;
      type: "pull_request" | "issue";
      url: string;
      status_etag: string | null;
    }>;
    const updateStatus = db.prepare("UPDATE notifications SET status = ?, status_etag = ? WHERE id = ?");
    const failures = new Map<string, number>();
    const recordFailure = (reason: string) => failures.set(reason, (failures.get(reason) ?? 0) + 1);

    for (let offset = 0; offset < rows.length; offset += 8) {
      await Promise.all(rows.slice(offset, offset + 8).map(async (row) => {
        const number = row.url.match(/\/(?:pull|issues)\/(\d+)(?:$|[?#])/)?.[1];
        if (number === undefined) return;
        const endpoint = `https://api.github.com/repos/${row.repository}/${row.type === "pull_request" ? "pulls" : "issues"}/${number}`;
        const detailHeaders = { ...headers };
        if (row.status_etag !== null) detailHeaders["If-None-Match"] = row.status_etag;

        try {
          const response = await fetch(endpoint, { headers: detailHeaders });
          if (response.status === 304) return;
          if (!response.ok) {
            recordFailure(`HTTP ${response.status}`);
            return;
          }
          const subject = githubSubjectSchema.parse(await response.json());
          const status: NotificationStatus = row.type === "pull_request" && subject.merged_at
            ? "merged"
            : subject.state;
          updateStatus.run(status, response.headers.get("etag"), row.id);
        } catch (cause) {
          recordFailure(cause instanceof z.ZodError ? "invalid response" : "request error");
        }
      }));
    }

    const failed = [...failures.values()].reduce((total, count) => total + count, 0);
    if (failed > 0) {
      const summary = [...failures].map(([reason, count]) => `${reason}: ${count}`).join(", ");
      bb.log.warn(`Could not refresh state for ${failed} GitHub notification${failed === 1 ? "" : "s"} (${summary}).`);
    }
  }

  async function performSync(): Promise<void> {
    const { token } = await settings.get();
    if (!token) throw new Error("Configure a GitHub personal access token first.");

    const sync = db.prepare("SELECT etag FROM sync_state WHERE id = 1").get() as { etag: string | null };
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bb-github-notifications-plugin",
    };
    if (sync.etag !== null) headers["If-None-Match"] = sync.etag;

    let url: string | null = "https://api.github.com/notifications?all=false&participating=false&per_page=100";
    const notifications: GithubNotification[] = [];
    let etag: string | null = sync.etag;
    let pollSeconds = DEFAULT_POLL_SECONDS;

    for (let page = 0; url !== null && page < MAX_PAGES; page += 1) {
      const pageHeaders = { ...headers };
      if (page > 0) delete pageHeaders["If-None-Match"];
      const response = await fetch(url, { headers: pageHeaders });
      if (page === 0 && response.status === 304) {
        const now = new Date().toISOString();
        db.prepare("UPDATE sync_state SET last_synced_at = ?, last_error = NULL WHERE id = 1").run(now);
        const detailHeaders = { ...headers };
        delete detailHeaders["If-None-Match"];
        await refreshStoredStatuses(detailHeaders);
        return;
      }
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(`GitHub notifications request failed (${response.status})${detail ? `: ${detail}` : ""}`);
      }
      if (page === 0) {
        etag = response.headers.get("etag");
        const suggested = Number(response.headers.get("x-poll-interval"));
        if (Number.isFinite(suggested)) pollSeconds = Math.max(DEFAULT_POLL_SECONDS, suggested);
      }
      notifications.push(...z.array(githubNotificationSchema).parse(await response.json()));
      url = nextPage(response.headers.get("link"));
    }

    const detailHeaders = { ...headers };
    delete detailHeaders["If-None-Match"];
    persistSync(notifications, etag, pollSeconds, url === null);
    await refreshStoredStatuses(detailHeaders);
  }

  async function syncNow(): Promise<void> {
    if (syncInFlight !== null) return syncInFlight;
    bb.realtime.publish(NOTIFICATIONS_CHANGED, { syncing: true });
    syncInFlight = performSync()
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        db.prepare("UPDATE sync_state SET last_error = ? WHERE id = 1").run(message);
        throw cause;
      })
      .finally(() => {
        syncInFlight = null;
        bb.realtime.publish(NOTIFICATIONS_CHANGED, { syncing: false });
      });
    return syncInFlight;
  }

  async function markNotificationRead(id: string): Promise<{ markedRead: boolean }> {
    const result = db.prepare(`
      UPDATE notifications SET unread = 0
      WHERE id = ? AND unread = 1 AND archived_at IS NULL
    `).run(id);
    const markedRead = result.changes > 0;
    if (!markedRead) return { markedRead };

    bb.realtime.publish(NOTIFICATIONS_CHANGED, { markedRead: id });

    const { token } = await settings.get();
    if (token) {
      try {
        const response = await fetch(`https://api.github.com/notifications/threads/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "bb-github-notifications-plugin",
          },
        });
        if (!response.ok) {
          bb.log.warn(`Could not mark GitHub notification ${id} as read (${response.status}).`);
        }
      } catch (cause) {
        bb.log.warn(`Could not mark GitHub notification ${id} as read: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }

    return { markedRead };
  }

  async function investigateNotification(id: string) {
    const notification = db.prepare(`
      SELECT repository, title, type, url
      FROM notifications
      WHERE id = ? AND archived_at IS NULL
    `).get(id) as { repository: string; title: string; type: string; url: string | null } | undefined;

    if (notification === undefined) throw new Error("That notification is no longer in the inbox.");
    if (notification.type !== "pull_request" || notification.url === null) {
      throw new Error("Only pull request notifications can be investigated.");
    }

    const repository = notification.repository.toLowerCase();
    const projects = await bb.sdk.projects.list();
    const project = projects.find((candidate) => githubRepositorySlug(candidate.gitRemoteUrl) === repository);
    if (project === undefined) {
      throw new Error(`No BB project has a GitHub remote for ${notification.repository}. Add the repository as a project first.`);
    }

    const defaults = await bb.sdk.projects.defaultExecutionOptions({ projectId: project.id });
    const hostId = project.sources.find((source) => source.isDefault)?.hostId ?? project.sources[0]?.hostId;
    const providers = await bb.sdk.providers.list(hostId === undefined ? {} : { hostId });
    const candidates = [
      ...providers.filter((provider) => provider.id === defaults?.providerId),
      ...providers.filter((provider) => provider.id !== defaults?.providerId),
    ];

    let execution: { providerId: string; model: string; reasoningLevel: NonNullable<typeof defaults>["reasoningLevel"] } | null = null;
    for (const provider of candidates) {
      if (!provider.available || provider.capabilities.modelCatalogScope !== "host") continue;
      try {
        const catalog = hostId === undefined
          ? await bb.sdk.providers.models({ providerId: provider.id })
          : await bb.sdk.providers.models({ providerId: provider.id, hostId });
        const preferredModel = provider.id === defaults?.providerId
          ? catalog.models.find((model) => model.model === defaults.model || model.id === defaults.model)
          : undefined;
        const model = preferredModel ?? catalog.models.find((candidate) => candidate.isDefault) ?? catalog.models[0];
        if (model === undefined) continue;
        const supportedReasoning = model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort);
        const reasoningLevel = provider.id === defaults?.providerId && supportedReasoning.includes(defaults.reasoningLevel)
          ? defaults.reasoningLevel
          : model.defaultReasoningEffort;
        execution = { providerId: provider.id, model: model.model, reasoningLevel };
        break;
      } catch (cause) {
        bb.log.warn(`Could not load ${provider.displayName} models for PR review: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    if (execution === null) {
      throw new Error("No agent provider with available models can start this review. Connect a provider on the project's machine and try again.");
    }

    const thread = await bb.sdk.threads.spawn({
      projectId: project.id,
      environment: { type: "project-default" },
      providerId: execution.providerId,
      model: execution.model,
      reasoningLevel: execution.reasoningLevel,
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        reasoningLevel: "explicit",
      },
      title: `Review PR: ${notification.title}`,
      prompt: [
        `Review this GitHub pull request notification: ${notification.url}`,
        `Repository: ${notification.repository}`,
        `Title: ${notification.title}`,
        "Inspect the pull request, its changes, discussion, review state, and CI status. Summarize what needs attention, identify risks or blockers, and recommend the next action. Do not modify code unless I ask you to after the investigation.",
      ].join("\n\n"),
    });

    return { threadId: thread.id, projectId: project.id };
  }

  async function startDeviceFlow() {
    const response = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        // Repository access is required to read state for private pull requests and issues.
        scope: "notifications repo",
      }),
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const failure = z.object({ error_description: z.string().optional() }).safeParse(payload);
      const detail = failure.success ? failure.data.error_description : undefined;
      throw new Error(detail ?? `GitHub login could not start (${response.status}).`);
    }
    const result = z.object({
      device_code: z.string(),
      user_code: z.string(),
      verification_uri: z.string().url(),
      expires_in: z.number().int().positive(),
      interval: z.number().int().positive().default(5),
    }).parse(payload);
    const flowId = randomUUID();
    const expiresAt = Date.now() + result.expires_in * 1000;
    deviceFlows.set(flowId, {
      deviceCode: result.device_code,
      expiresAt,
      intervalSeconds: result.interval,
      nextPollAt: Date.now() + result.interval * 1000,
    });
    return {
      flowId,
      userCode: result.user_code,
      verificationUri: result.verification_uri,
      expiresAt: new Date(expiresAt).toISOString(),
      intervalSeconds: result.interval,
    };
  }

  async function pollDeviceFlow(flowId: string) {
    const flow = deviceFlows.get(flowId);
    if (flow === undefined) {
      return { status: "expired" as const, retryAfterSeconds: null, message: "This login session is no longer available." };
    }
    if (Date.now() >= flow.expiresAt) {
      deviceFlows.delete(flowId);
      return { status: "expired" as const, retryAfterSeconds: null, message: "The GitHub login code expired." };
    }
    if (Date.now() < flow.nextPollAt) {
      return {
        status: "pending" as const,
        retryAfterSeconds: Math.max(1, Math.ceil((flow.nextPollAt - Date.now()) / 1000)),
        message: null,
      };
    }

    flow.nextPollAt = Date.now() + flow.intervalSeconds * 1000;
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        device_code: flow.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    if (!response.ok) throw new Error(`GitHub login failed (${response.status}).`);
    const result = z.object({
      access_token: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
      interval: z.number().int().positive().optional(),
    }).parse(await response.json());

    if (result.access_token !== undefined) {
      deviceFlows.delete(flowId);
      configured = true;
      await settings.experimental_set({ token: result.access_token });
      bb.realtime.publish(NOTIFICATIONS_CHANGED, { configured: true });
      return { status: "complete" as const, retryAfterSeconds: null, message: null };
    }
    if (result.error === "authorization_pending") {
      return { status: "pending" as const, retryAfterSeconds: flow.intervalSeconds, message: null };
    }
    if (result.error === "slow_down") {
      flow.intervalSeconds = (result.interval ?? flow.intervalSeconds) + 5;
      flow.nextPollAt = Date.now() + flow.intervalSeconds * 1000;
      return { status: "pending" as const, retryAfterSeconds: flow.intervalSeconds, message: null };
    }

    deviceFlows.delete(flowId);
    if (result.error === "access_denied") {
      return { status: "denied" as const, retryAfterSeconds: null, message: result.error_description ?? "GitHub login was cancelled." };
    }
    if (result.error === "expired_token") {
      return { status: "expired" as const, retryAfterSeconds: null, message: result.error_description ?? "The GitHub login code expired." };
    }
    return {
      status: "error" as const,
      retryAfterSeconds: null,
      message: result.error_description ?? "GitHub returned an unknown login error.",
    };
  }

  bb.rpc.register(rpcContract, {
    notifications_state: () => readState(),
    notifications_archive: ({ id }) => {
      const result = db.prepare(`
        UPDATE notifications SET archived_at = ? WHERE id = ? AND archived_at IS NULL
      `).run(new Date().toISOString(), id);
      const archived = result.changes > 0;
      if (archived) bb.realtime.publish(NOTIFICATIONS_CHANGED, { archived: id });
      return { archived };
    },
    notifications_mark_read: ({ id }) => markNotificationRead(id),
    notifications_sync: async () => {
      await syncNow();
      return readState();
    },
    notifications_investigate: ({ id }) => investigateNotification(id),
    oauth_start: () => startDeviceFlow(),
    oauth_poll: ({ flowId }) => pollDeviceFlow(flowId),
  });

  bb.background.service("github-notifications-poller", {
    async start(signal) {
      while (!signal.aborted) {
        const { token, pollInterval } = await settings.get();
        if (token) {
          try {
            await syncNow();
          } catch (cause) {
            bb.log.warn(cause instanceof Error ? cause.message : String(cause));
          }
        }
        const state = db.prepare("SELECT poll_seconds FROM sync_state WHERE id = 1").get() as { poll_seconds: number };
        const configuredSeconds = Number(pollInterval) || DEFAULT_POLL_SECONDS;
        await sleep(Math.max(configuredSeconds, state.poll_seconds) * 1000, signal);
      }
    },
  });

  settings.onChange((next) => {
    configured = Boolean(next.token);
    bb.realtime.publish(NOTIFICATIONS_CHANGED, { configured });
    if (!configured) return;
    void syncNow().catch((cause: unknown) => {
      bb.log.warn(cause instanceof Error ? cause.message : String(cause));
    });
  });

  bb.log.info("loaded");
}
