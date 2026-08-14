import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader, Play, RefreshCw, Square, Stethoscope } from "lucide-react";
import { fetchAPI } from "$lib/api";
import { Alert, AlertDescription } from "$lib/components/ui/alert";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { useI18n } from "$lib/i18n";

type ServiceStatus = {
  lifecycle: string;
  version: string;
  pid: number;
  platform: string;
  arch: string;
  uptimeSeconds: number;
  host: string;
  port: number;
  database: { ready: boolean; error: string | null };
  embedding: {
    ready: boolean;
    initializing: boolean;
    model: string;
    dimensions: number;
    backend: string;
    cacheDir: string;
    error: string | null;
    bundle: {
      present: boolean;
      valid: boolean;
      required: boolean;
      root: string;
      error: string | null;
    };
    lastSelfTest: { at: string; dimensions: number; finite: boolean } | null;
  };
  autoCaptureProvider: { ready: boolean; mode?: string; issues?: string[] };
};

type TagMigrationStatus = {
  pending: number;
  active: number;
  deferred: number;
  nextAttemptAt: number | null;
  lastError: string | null;
};

export function SystemView() {
  const { t } = useI18n();
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [tagMigration, setTagMigration] = useState<TagMigrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [result, migrationResult] = await Promise.all([
      fetchAPI<{ status: ServiceStatus }>("/api/system/status"),
      fetchAPI<TagMigrationStatus>("/api/migration/tags/status"),
    ]);
    if (result.success && result.data?.status) {
      setStatus(result.data.status);
      setMessage(null);
    } else {
      setStatus(null);
      setMessage(result.error || "Unable to read service status.");
    }
    setTagMigration(migrationResult.success && migrationResult.data ? migrationResult.data : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  async function runAction(action: "start" | "stop" | "restart") {
    setWorking(true);
    setMessage(null);
    const native = window.opencodeMemDesktop?.service;
    const result = native
      ? await native[action]()
      : { success: false, output: "Service controls are available in the desktop app." };
    setMessage(result.success ? "Service action sent." : result.output || "Service action failed.");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await load();
    setWorking(false);
  }

  async function selfTest() {
    setWorking(true);
    setMessage(null);
    const result = await fetchAPI<{ result: { dimensions: number; finite: boolean } }>(
      "/api/model/self-test",
      { method: "POST" }
    );
    setMessage(
      result.success
        ? `Embedding self-test passed (${result.data?.result.dimensions ?? 0} dimensions).`
        : result.error || "Embedding self-test failed."
    );
    await load();
    setWorking(false);
  }

  const autoCaptureMode = status?.autoCaptureProvider.ready
    ? status.autoCaptureProvider.mode === "opencode-session"
      ? "inherits the triggering OpenCode session model"
      : status.autoCaptureProvider.mode || "ready"
    : "not configured";

  if (loading && !status) {
    return <div className="p-6 text-sm text-muted-foreground">Loading service status...</div>;
  }

  return (
    <section className="space-y-4">
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Current-user Background Task</h2>
            <Badge variant={status?.lifecycle === "ready" ? "default" : "secondary"}>
              {status?.lifecycle || "unknown"}
            </Badge>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-muted-foreground">Endpoint</dt>
              <dd>{status ? `${status.host}:${status.port}` : "-"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">PID</dt>
              <dd>{status?.pid || "-"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Version</dt>
              <dd>{status?.version || "-"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Database</dt>
              <dd>{status?.database.ready ? "ready" : "not ready"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Task Scheduler entry</dt>
              <dd>OpenCodeMemoryService</dd>
            </div>
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={working}
              onClick={() => void runAction("start")}
            >
              <Play className="size-3.5" />
              Start
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={working}
              onClick={() => void runAction("stop")}
            >
              <Square className="size-3.5" />
              Stop
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={working}
              onClick={() => void runAction("restart")}
            >
              <RefreshCw className="size-3.5" />
              Restart
            </Button>
          </div>
        </div>
        <div className="space-y-4 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Embedding Model</h2>
            {status?.embedding.initializing ? (
              <Loader className="size-4 animate-spin" />
            ) : (
              <Badge variant={status?.embedding.ready ? "default" : "destructive"}>
                {status?.embedding.ready ? "ready" : "error"}
              </Badge>
            )}
          </div>
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-muted-foreground">Model</dt>
              <dd className="break-all">{status?.embedding.model || "-"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Dimensions / backend</dt>
              <dd>
                {status?.embedding.dimensions || "-"} / {status?.embedding.backend || "-"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Bundle</dt>
              <dd>
                {status?.embedding.bundle.valid
                  ? "verified"
                  : status?.embedding.bundle.error || "not configured"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Cache</dt>
              <dd className="break-all">{status?.embedding.cacheDir || "-"}</dd>
            </div>
          </dl>
          <Button size="sm" disabled={working} onClick={() => void selfTest()}>
            <Stethoscope className="size-3.5" />
            Run self-test
          </Button>
        </div>
      </div>
      <div className="space-y-2 rounded-xl border border-border bg-card p-4 text-sm">
        <h2 className="font-medium">OpenCode Integration</h2>
        <p className="text-muted-foreground">
          The local bridge is installed in the global OpenCode plugin directory. The background
          runtime is a current-user Task Scheduler task named <code>OpenCodeMemoryService</code>,
          not a Windows service shown in services.msc. A windowless host keeps the Node.js service
          hidden while it runs, and the task can be managed here.
        </p>
        <p>
          Auto-capture model: <strong>{autoCaptureMode}</strong>
        </p>
        <p className="text-muted-foreground">
          The bridge explicitly reuses the provider and model from the conversation that triggered
          capture. If OpenCode does not expose that model metadata, capture is skipped instead of
          falling back to a different default model.
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void window.opencodeMemDesktop?.openBrowser()}
          >
            <ExternalLink className="size-3.5" />
            Open in browser
          </Button>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            <RefreshCw className="size-3.5" />
            Refresh
          </Button>
        </div>
      </div>
      <div className="space-y-3 rounded-xl border border-border bg-card p-4 text-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-medium">{t("tag-migration-title")}</h2>
          <Badge variant={tagMigration?.pending ? "secondary" : "default"}>
            {tagMigration?.pending ? t("tag-migration-pending") : t("tag-migration-current")}
          </Badge>
        </div>
        <p className="text-muted-foreground">{t("tag-migration-description")}</p>
        {tagMigration ? (
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">{t("tag-migration-waiting")}</dt>
              <dd>{tagMigration.pending}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("tag-migration-active")}</dt>
              <dd>{tagMigration.active}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("tag-migration-deferred")}</dt>
              <dd>{tagMigration.deferred}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-muted-foreground">{t("tag-migration-unavailable")}</p>
        )}
        {tagMigration?.lastError ? (
          <p className="break-words text-xs text-muted-foreground">
            {t("tag-migration-last-error", { error: tagMigration.lastError })}
          </p>
        ) : null}
      </div>
    </section>
  );
}
