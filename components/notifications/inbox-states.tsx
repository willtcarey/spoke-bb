import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

type LoginFlow = {
  flowId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  intervalSeconds: number;
};

export function OAuthConnect({ onConnected }: { onConnected: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [flow, setFlow] = useState<LoginFlow | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (flow === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await rpc.call("oauth_poll", { flowId: flow.flowId });
        if (cancelled) return;
        if (result.status === "pending") {
          timer = setTimeout(poll, (result.retryAfterSeconds ?? flow.intervalSeconds) * 1000);
          return;
        }
        if (result.status === "complete") {
          setFlow(null);
          setError(null);
          onConnected();
          return;
        }
        setFlow(null);
        setError(result.message ?? "GitHub login did not complete.");
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    timer = setTimeout(poll, flow.intervalSeconds * 1000);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [flow, onConnected, rpc]);

  const start = async () => {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const next = await rpc.call("oauth_start");
      setFlow(next);
      navigate.openUrl(next.verificationUri);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-primary/20 bg-primary/[0.04] shadow-sm">
      <div className="flex gap-4 p-5">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <Icon name="Github" className="size-5" />
        </div>
        <div className="min-w-0 flex-1 text-sm">
          <p className="text-base font-semibold tracking-tight">Connect your GitHub inbox</p>
          {flow === null ? (
            <>
              <p className="mt-1 max-w-xl text-muted-foreground">Authorize Spoke once, then pull requests and issues that need you will appear here automatically.</p>
              <Button className="mt-4" size="sm" disabled={starting} onClick={() => void start()}>
                <Icon name="Github" className="size-4" />
                {starting ? "Starting…" : "Continue with GitHub"}
              </Button>
            </>
          ) : (
            <div className="mt-3">
              <p className="text-muted-foreground">Enter this one-time code in the GitHub tab:</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <div className="rounded-lg border border-primary/20 bg-background px-4 py-2 font-mono text-lg font-semibold tracking-widest text-primary shadow-xs">
                  {flow.userCode}
                </div>
                <Button variant="outline" size="sm" onClick={() => navigate.openUrl(flow.verificationUri)}>
                  Open GitHub
                  <Icon name="ExternalLink" className="size-4" />
                </Button>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">Waiting for authorization…</p>
            </div>
          )}
          {error === null ? null : <p role="alert" className="mt-3 text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  );
}

export function InboxEmptyState({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-xl border border-dashed border-primary/25 bg-primary/[0.025] px-4 py-12 text-center text-sm text-muted-foreground">
      <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon name="CircleCheck" className="size-5" />
      </div>
      <p>{children}</p>
    </div>
  );
}
