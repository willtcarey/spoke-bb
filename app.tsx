import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  UrlLink,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import type { Notification, NotificationState, rpcContract } from "./server";
import { InboxEmptyState, OAuthConnect } from "@/components/notifications/inbox-states";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type Filter = "all" | Notification["type"];

function useNotifications() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [state, setState] = useState<NotificationState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useBbNavigate();
  const [refreshing, setRefreshing] = useState(false);
  const [investigatingId, setInvestigatingId] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    rpc.call("notifications_state").then((next) => {
      setState(next);
      setError(null);
    }, report);
  }, [report, rpc]);

  useEffect(refetch, [refetch]);
  useEffect(() => {
    if (connection === "connected") refetch();
  }, [connection, refetch]);
  useRealtime("notifications-changed", refetch);

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      setState(await rpc.call("notifications_sync"));
      setError(null);
    } catch (cause) {
      report(cause);
      refetch();
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, report, refetch, rpc]);

  const archive = useCallback(async (id: string) => {
    try {
      await rpc.call("notifications_archive", { id });
      refetch();
    } catch (cause) {
      report(cause);
    }
  }, [report, refetch, rpc]);

  const markRead = useCallback(async (id: string) => {
    setState((current) => {
      if (current === null) return current;
      const notification = current.notifications.find((item) => item.id === id);
      if (notification === undefined || !notification.unread) return current;
      return {
        ...current,
        notifications: current.notifications.map((item) => item.id === id ? { ...item, unread: false } : item),
        counts: {
          pullRequests: current.counts.pullRequests - (notification.type === "pull_request" ? 1 : 0),
          issues: current.counts.issues - (notification.type === "issue" ? 1 : 0),
        },
      };
    });
    try {
      await rpc.call("notifications_mark_read", { id });
      setError(null);
      refetch();
    } catch (cause) {
      report(cause);
      refetch();
    }
  }, [report, refetch, rpc]);

  const investigate = useCallback(async (id: string) => {
    if (investigatingId !== null) return;
    setInvestigatingId(id);
    setError(null);
    try {
      const { threadId } = await rpc.call("notifications_investigate", { id });
      navigate.toThread(threadId);
    } catch (cause) {
      report(cause);
    } finally {
      setInvestigatingId(null);
    }
  }, [investigatingId, navigate, report, rpc]);

  return { state, error, refreshing, investigatingId, refresh, archive, markRead, investigate, refetch };
}

function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn(
      "inline-flex h-5 items-center rounded-full border border-border bg-secondary px-2 text-[11px] font-medium text-secondary-foreground",
      className,
    )}>
      {children}
    </span>
  );
}

function CountBadge({ count, active }: { count: number; active: boolean }) {
  return (
    <span className={cn(
      "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
      active ? "bg-primary text-primary-foreground" : "bg-background/80 text-muted-foreground",
    )}>
      {count}
    </span>
  );
}

function relativeTime(value: string): string {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
}

const reasonLabels: Record<string, string> = {
  assign: "Assigned",
  author: "Author",
  ci_activity: "CI activity",
  comment: "Comment",
  invitation: "Invitation",
  manual: "Subscribed",
  mention: "Mentioned",
  review_requested: "Review requested",
  security_alert: "Security alert",
  state_change: "State changed",
  subscribed: "Subscribed",
  team_mention: "Team mentioned",
};

function NotificationRow({ notification, archive, markRead, investigate, investigating }: {
  notification: Notification;
  archive: () => void;
  markRead: () => void;
  investigate: () => void;
  investigating: boolean;
}) {
  const isPullRequest = notification.type === "pull_request";
  const isIssue = notification.type === "issue";
  const icon = isPullRequest ? "GitPullRequest" : isIssue ? "CircleDot" : "Mail";
  const typeLabel = isPullRequest ? "Pull request" : isIssue ? "Issue" : "Notification";
  const statusLabel = notification.status === "open" ? "Open" : notification.status === "merged" ? "Merged" : notification.status === "closed" ? "Closed" : null;
  const statusIcon = notification.status === "merged" ? "GitMerge" : notification.status === "closed" ? "CircleX" : "Circle";
  return (
    <li className={cn(
      "group relative flex gap-3.5 px-4 py-3 transition-colors hover:bg-state-hover/60",
      notification.unread && "bg-blue-500/10 hover:bg-blue-500/15",
    )}>
      {notification.unread ? (
        <span className="absolute inset-y-3 left-0 w-0.5 rounded-r-full bg-blue-500" aria-hidden="true" />
      ) : null}
      <div className="flex size-9 shrink-0 items-center justify-center text-muted-foreground">
        <Icon name={icon} className="size-[18px]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            {notification.url === null ? (
              <span className={cn("leading-5", notification.unread ? "font-semibold" : "font-medium")}>{notification.title}</span>
            ) : (
              <UrlLink
                href={notification.url}
                className={cn("leading-5 decoration-primary/50 underline-offset-2 hover:text-primary hover:underline", notification.unread ? "font-semibold" : "font-medium")}
                onClick={notification.unread ? markRead : undefined}
              >
                {notification.title}
              </UrlLink>
            )}
          </div>
          {isPullRequest ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 px-2"
              disabled={investigating}
              onClick={investigate}
            >
              {investigating ? "Starting…" : "Review"}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="-mr-1 size-7 shrink-0 text-muted-foreground opacity-60 hover:text-foreground group-hover:opacity-100"
            aria-label={`Archive ${notification.title}`}
            onClick={archive}
          >
            <Icon name="Archive" className="size-4" />
          </Button>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <UrlLink href={notification.repositoryUrl} className="max-w-64 truncate font-medium text-foreground/70 hover:text-primary hover:underline">
            {notification.repository}
          </UrlLink>
          <span className="text-border" aria-hidden="true">/</span>
          <span>{relativeTime(notification.updatedAt)}</span>
          <Badge className="h-4 px-1.5 text-[10px]">
            {typeLabel}
          </Badge>
          {statusLabel === null ? null : (
            <Badge className={cn(
              "h-4 gap-1 px-1.5 text-[10px]",
              notification.status === "open" && "border-green-500/25 bg-green-500/10 text-green-700 dark:text-green-400",
              notification.status === "merged" && "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-400",
              notification.status === "closed" && "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400",
            )}>
              <Icon name={statusIcon} className="size-2.5" />
              {statusLabel}
            </Badge>
          )}
          <span>{reasonLabels[notification.reason] ?? notification.reason.replaceAll("_", " ")}</span>
        </div>
      </div>
    </li>
  );
}

function NotificationsPage() {
  const { state, error, refreshing, investigatingId, refresh, archive, markRead, investigate, refetch } = useNotifications();
  const [filter, setFilter] = useState<Filter>("all");
  const notifications = useMemo(() => {
    if (state === null || filter === "all") return state?.notifications ?? [];
    return state.notifications.filter((notification) => notification.type === filter);
  }, [filter, state]);
  const filterCounts = useMemo(() => ({
    all: state?.notifications.length ?? 0,
    pull_request: state?.notifications.filter((item) => item.type === "pull_request").length ?? 0,
    issue: state?.notifications.filter((item) => item.type === "issue").length ?? 0,
  }), [state]);
  const unreadCount = state?.notifications.filter((item) => item.unread).length ?? 0;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-4xl px-4 pb-8 pt-5 md:px-6 md:pt-7">
        <header className="relative overflow-hidden rounded-xl border border-primary/15 bg-card shadow-sm">
          <div className="absolute inset-y-0 left-0 w-1 bg-primary" aria-hidden="true" />
          <div className="flex flex-wrap items-center justify-between gap-5 px-5 py-5 md:px-6">
            <div className="flex min-w-0 items-center gap-3.5">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
                <Icon name="Github" className="size-5" />
              </div>
              <div>
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <h1 className="text-lg font-semibold tracking-tight">Your inbox</h1>
                  {unreadCount > 0 ? (
                    <Badge className="border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-400">{unreadCount} unread</Badge>
                  ) : null}
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground">Pull requests and issues that need your attention.</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {state?.configured ? (
                <div className="hidden items-center gap-4 border-r border-border pr-4 text-xs sm:flex">
                  <div><span className="font-semibold text-foreground">{state.counts.pullRequests}</span> <span className="text-muted-foreground">reviews</span></div>
                  <div><span className="font-semibold text-foreground">{state.counts.issues}</span> <span className="text-muted-foreground">issues</span></div>
                </div>
              ) : null}
              <Button variant="outline" size="sm" disabled={refreshing || state?.syncing || !state?.configured} onClick={() => void refresh()}>
                <Icon name="ArrowReloadHorizontal" className={cn("size-4", (refreshing || state?.syncing) && "animate-spin")} />
                Refresh
              </Button>
            </div>
          </div>
        </header>

        {!state?.configured ? <OAuthConnect onConnected={refetch} /> : null}
        {error !== null ? (
          <div role="alert" className="mt-4 rounded-lg border border-destructive/20 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive">{error}</div>
        ) : null}
        {state?.lastError && error === null ? (
          <div role="alert" className="mt-4 rounded-lg border border-destructive/20 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive">Last sync failed: {state.lastError}</div>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 rounded-lg border border-border bg-secondary/70 p-1">
            {([
              ["all", "All"],
              ["pull_request", "Reviews"],
              ["issue", "Issues"],
            ] as const).map(([value, label]) => (
              <Button
                key={value}
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 gap-1.5 px-2.5",
                  filter === value && "bg-card text-foreground shadow-xs hover:bg-card",
                )}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
                <CountBadge count={filterCounts[value]} active={filter === value} />
              </Button>
            ))}
          </div>
          {state?.lastSyncedAt ? (
            <p className="text-xs text-muted-foreground">Updated {relativeTime(state.lastSyncedAt)}</p>
          ) : null}
        </div>

        <div className="mt-3">
          {state === null ? (
            <InboxEmptyState>Loading your local inbox…</InboxEmptyState>
          ) : notifications.length === 0 ? (
            <InboxEmptyState>
              {state.notifications.length === 0 ? "You’re all caught up. Nothing needs your attention." : "No notifications match this filter."}
            </InboxEmptyState>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              {notifications.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  archive={() => void archive(notification.id)}
                  markRead={() => void markRead(notification.id)}
                  investigate={() => void investigate(notification.id)}
                  investigating={investigatingId === notification.id}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function SidebarCounts() {
  const { state } = useNotifications();
  if (state === null || (state.counts.pullRequests === 0 && state.counts.issues === 0)) return null;
  return (
    <div className="flex items-center justify-end gap-1" aria-label={`${state.counts.pullRequests} pull request reviews and ${state.counts.issues} issues`}>
      {state.counts.pullRequests > 0 ? (
        <span className="inline-flex h-4 min-w-5 items-center justify-center gap-0.5 rounded-full bg-primary/15 px-1 text-[10px] font-semibold text-primary" title="Pull request reviews">
          <Icon name="GitPullRequest" className="size-2.5" />
          {state.counts.pullRequests}
        </span>
      ) : null}
      {state.counts.issues > 0 ? (
        <span className="inline-flex h-4 min-w-4 items-center justify-center gap-0.5 rounded-full bg-primary/15 px-1 text-[10px] font-semibold text-primary" title="Issues">
          <Icon name="CircleDot" className="size-2.5" />
          {state.counts.issues}
        </span>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "notifications",
    title: "Spoke",
    icon: "Github",
    path: "notifications",
    component: NotificationsPage,
    experimental_sidebarAccessory: SidebarCounts,
  });
});
