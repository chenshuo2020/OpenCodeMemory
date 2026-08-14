import { createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tool, type Plugin } from "@opencode-ai/plugin";

type ConnectionConfig = {
  baseUrl?: string;
  tokenFile?: string;
};

type BridgeContext = {
  directory?: string;
  client?: any;
};

type CaptureModel = {
  providerID: string;
  modelID: string;
};

const INTERNAL_CAPTURE_TITLE = "OpenCode Memory Auto Capture";
const INTERNAL_TAG_MIGRATION_TITLE = "OpenCode Memory Tag Migration";
const INTERNAL_SESSION_RETENTION_MS = 5 * 60 * 1000;
const TAG_MIGRATION_MAX_PER_RUN = 8;
const TAG_MIGRATION_BETWEEN_ITEMS_MS = 250;
const TAG_MIGRATION_CONTINUATION_MS = 2_000;
const TAG_MIGRATION_RETRY_MS = 60_000;
const TAG_MIGRATION_MIN_RETRY_MS = 1_000;
const INTERNAL_SESSIONS = new Set<string>();
const INTERNAL_SESSION_RELEASE_TIMERS = new Map<string, ReturnType<typeof setTimeout>>();
const ACTIVE_CAPTURE_SESSIONS = new Set<string>();
const LAST_CAPTURE_FINGERPRINTS = new Map<string, string>();
const SESSION_MODELS = new Map<string, CaptureModel>();
const TAG_MIGRATION_WORKER_ID = `opencode-mem-bridge-${process.pid}-${randomUUID()}`;
let tagMigrationRunning = false;
let tagMigrationRetryTimer: ReturnType<typeof setTimeout> | null = null;

type TagMigrationClaim = {
  claimId: string;
  memoryId: string;
  content: string;
  projectPath?: string;
  projectName?: string;
  remaining: number;
};

type TagMigrationStatus = {
  pending: number;
  active: number;
  deferred: number;
  nextAttemptAt?: number | null;
  lastError: string | null;
};

function normalizeCaptureModel(value: any): CaptureModel | undefined {
  if (!value?.providerID || !value?.modelID) return undefined;
  return {
    providerID: String(value.providerID),
    modelID: String(value.modelID),
  };
}

function markInternalSession(sessionID: string): void {
  const pendingRelease = INTERNAL_SESSION_RELEASE_TIMERS.get(sessionID);
  if (pendingRelease) clearTimeout(pendingRelease);
  INTERNAL_SESSION_RELEASE_TIMERS.delete(sessionID);
  INTERNAL_SESSIONS.add(sessionID);
}

function releaseInternalSessionLater(sessionID: string): void {
  const pendingRelease = INTERNAL_SESSION_RELEASE_TIMERS.get(sessionID);
  if (pendingRelease) clearTimeout(pendingRelease);
  const timer = setTimeout(() => {
    INTERNAL_SESSIONS.delete(sessionID);
    INTERNAL_SESSION_RELEASE_TIMERS.delete(sessionID);
  }, INTERNAL_SESSION_RETENTION_MS);
  timer.unref?.();
  INTERNAL_SESSION_RELEASE_TIMERS.set(sessionID, timer);
}

function extractSessionTitle(response: any): string | undefined {
  const value = response?.data ?? response;
  return typeof value?.title === "string" ? value.title : undefined;
}

async function isInternalCaptureSession(ctx: BridgeContext, sessionID: string): Promise<boolean> {
  if (INTERNAL_SESSIONS.has(sessionID)) return true;
  if (typeof ctx.client?.session?.get !== "function") return false;

  try {
    const response = await ctx.client.session.get({ path: { id: sessionID } });
    const title = extractSessionTitle(response);
    if (title !== INTERNAL_CAPTURE_TITLE && title !== INTERNAL_TAG_MIGRATION_TITLE) return false;
    markInternalSession(sessionID);
    return true;
  } catch {
    return false;
  }
}

function readConnection(): Required<ConnectionConfig> {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const configPath = join(localAppData, "OpenCodeMemory", "connection.json");
  let config: ConnectionConfig = {};
  try {
    if (existsSync(configPath))
      config = JSON.parse(readFileSync(configPath, "utf8")) as ConnectionConfig;
  } catch {
    // Fall back to the stable default below.
  }
  return {
    baseUrl: (
      process.env.OPENCODE_MEM_SERVICE_URL ||
      config.baseUrl ||
      "http://127.0.0.1:4747"
    ).replace(/\/$/, ""),
    tokenFile: config.tokenFile || join(homedir(), ".opencode-mem", ".auth-token"),
  };
}

function readToken(tokenFile: string): string {
  try {
    return readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

async function rpc<T>(path: string, init: RequestInit = {}): Promise<T> {
  const connection = readConnection();
  const token = readToken(connection.tokenFile);
  const response = await fetch(`${connection.baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-opencode-mem-token": token,
      ...(init.headers || {}),
    },
    signal: init.signal || AbortSignal.timeout(30000),
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(body?.error || `Memory service returned HTTP ${response.status}`);
  return body;
}

async function logBridge(
  ctx: BridgeContext,
  level: "info" | "warn",
  message: string
): Promise<void> {
  try {
    await ctx.client?.app?.log?.({
      body: { service: "opencode-mem-bridge", level, message },
    });
  } catch {
    // Logging must never break OpenCode hooks.
  }
}

async function logServiceError(ctx: BridgeContext, message: string): Promise<void> {
  await logBridge(ctx, "warn", message);
}

function getCaptureModel(messages: any[]): CaptureModel | undefined {
  for (const message of [...messages].reverse()) {
    const info = message?.info;
    if (!info) continue;

    // Assistant messages record the model used for the actual response at the
    // top level. Ignore compaction/summary messages because they may use a
    // different small model than the conversation that triggered capture.
    if (
      info.role === "assistant" &&
      info.summary !== true &&
      info.mode !== "compaction" &&
      info.providerID &&
      info.modelID
    ) {
      return normalizeCaptureModel(info);
    }

    // User messages record the selected model as a nested model object.
    if (info.role === "user" && info.model?.providerID && info.model?.modelID) {
      return normalizeCaptureModel(info.model);
    }
  }

  return undefined;
}

function textFromParts(parts: any[]): string {
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function isMemoryInjection(parts: any[]): boolean {
  return parts.some((part) => part?.synthetic === true && part?.text?.includes("<memory_context>"));
}

async function injectContext(ctx: BridgeContext, sessionID: string, output: any): Promise<void> {
  if (!Array.isArray(output.parts) || isMemoryInjection(output.parts)) return;
  const result = await rpc<{ success: boolean; context?: string; error?: string }>(
    "/api/plugin/context",
    {
      method: "POST",
      body: JSON.stringify({ directory: ctx.directory || process.cwd(), sessionID, limit: 3 }),
    }
  );
  if (!result.success || !result.context) return;
  output.parts.unshift({
    id: `prt-memory-context-${Date.now()}`,
    sessionID,
    messageID: output.message?.id,
    type: "text",
    text: result.context,
    synthetic: true,
  });
}

async function captureSession(
  ctx: BridgeContext,
  sessionID: string,
  onModelResolved?: (model: CaptureModel) => void
): Promise<void> {
  if (
    !ctx.client?.session?.messages ||
    !ctx.client?.session?.create ||
    !ctx.client?.session?.prompt
  ) {
    return;
  }
  const messagesResponse = await ctx.client.session.messages({ path: { id: sessionID } });
  const messages = messagesResponse?.data || [];
  const captureModel = getCaptureModel(messages) || SESSION_MODELS.get(sessionID);
  // Tag migration does not depend on whether this idle event produces a new
  // capture. Resolve the model before duplicate/empty-transcript checks so a
  // quiet existing conversation can still wake the background migration queue.
  if (captureModel) onModelResolved?.(captureModel);
  const transcript = messages
    .slice(-12)
    .map((message: any) => {
      const role = message?.info?.role || "unknown";
      return `${role.toUpperCase()}: ${textFromParts(message.parts || [])}`;
    })
    .filter((line: string) => line.length > 8)
    .join("\n\n")
    .slice(-24000);
  if (!transcript) return;
  const transcriptFingerprint = createHash("sha256").update(transcript).digest("hex");
  if (LAST_CAPTURE_FINGERPRINTS.get(sessionID) === transcriptFingerprint) {
    await logBridge(
      ctx,
      "info",
      `Automatic capture skipped for ${sessionID}: transcript is unchanged`
    );
    return;
  }
  if (!captureModel) {
    await logBridge(
      ctx,
      "warn",
      `Automatic capture skipped for ${sessionID}: the source session model could not be determined`
    );
    return;
  }

  const created = await ctx.client.session.create({ body: { title: INTERNAL_CAPTURE_TITLE } });
  const captureSessionID = created?.data?.id || created?.id;
  if (!captureSessionID) return;
  markInternalSession(captureSessionID);
  try {
    await logBridge(
      ctx,
      "info",
      `Automatic capture for ${sessionID} using ${captureModel.providerID}/${captureModel.modelID}`
    );
    await ctx.client.session.prompt({
      path: { id: captureSessionID },
      body: {
        model: captureModel,
        parts: [
          {
            type: "text",
            text: `Summarize the following technical work in concise markdown. Skip casual content.\n\n${transcript}`,
          },
        ],
      },
    });
    const generated = await ctx.client.session.messages({ path: { id: captureSessionID } });
    const assistantText = (generated?.data || [])
      .filter((message: any) => message?.info?.role === "assistant")
      .map((message: any) => textFromParts(message.parts || []))
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (!assistantText) return;
    const saved = await rpc<{ success: boolean; error?: string }>("/api/plugin/capture", {
      method: "POST",
      body: JSON.stringify({
        directory: ctx.directory || process.cwd(),
        content: assistantText,
        type: "analysis",
        sessionID,
      }),
    });
    if (!saved?.success) {
      throw new Error(saved?.error || "Memory service rejected automatic capture");
    }
    LAST_CAPTURE_FINGERPRINTS.set(sessionID, transcriptFingerprint);
    await logBridge(
      ctx,
      "info",
      `Automatic capture saved for ${sessionID} using ${captureModel.providerID}/${captureModel.modelID}`
    );
  } finally {
    if (typeof ctx.client.session.delete === "function") {
      await ctx.client.session.delete({ path: { id: captureSessionID } }).catch(() => {});
    }
    // OpenCode can emit session.idle shortly after the transient session is
    // deleted. Keep the ID marked briefly so that delayed events cannot start
    // a recursive capture chain.
    releaseInternalSessionLater(captureSessionID);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeTechnicalTags(values: unknown[]): string[] {
  const tags: string[] = [];
  for (const value of values) {
    const tag = String(value ?? "")
      .trim()
      .replace(/^[-*\d.)\s]+/, "")
      .replace(/^["'`]+|["'`.,;:]+$/g, "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^\p{L}\p{N}#+._/-]/gu, "")
      .slice(0, 48);
    if (!tag || tags.includes(tag)) continue;
    tags.push(tag);
    if (tags.length >= 4) break;
  }
  return tags;
}

function parseTechnicalTags(text: string): string[] {
  const candidates = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  const object = text.match(/\{[\s\S]*\}/)?.[0];
  if (object) candidates.push(object);
  const array = text.match(/\[[\s\S]*\]/)?.[0];
  if (array) candidates.push(array);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed)) {
        const tags = normalizeTechnicalTags(parsed);
        if (tags.length > 0) return tags;
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { tags?: unknown[] }).tags)
      ) {
        const tags = normalizeTechnicalTags((parsed as { tags: unknown[] }).tags);
        if (tags.length > 0) return tags;
      }
    } catch {
      // Some providers return a comma-separated list despite the JSON request.
    }
  }

  return normalizeTechnicalTags(text.split(/[\n,]/));
}

function scheduleTagMigration(ctx: BridgeContext, model: CaptureModel, delayMs: number): void {
  if (tagMigrationRetryTimer) return;
  const timer = setTimeout(() => {
    tagMigrationRetryTimer = null;
    void runTagMigration(ctx, model);
  }, delayMs);
  timer.unref?.();
  tagMigrationRetryTimer = timer;
}

async function scheduleTagMigrationFromStatus(
  ctx: BridgeContext,
  model: CaptureModel,
  attempted: number,
  queueFailed: boolean
): Promise<void> {
  try {
    const result = await rpc<{
      success: boolean;
      data?: TagMigrationStatus;
      error?: string;
    }>("/api/migration/tags/status");
    if (!result.success) throw new Error(result.error || "Tag migration status request failed");

    const status = result.data;
    if (!status || status.pending <= 0) return;

    let delayMs = TAG_MIGRATION_RETRY_MS;
    if (status.deferred > 0 && typeof status.nextAttemptAt === "number") {
      // Use the service's earliest backoff deadline instead of repeatedly
      // polling every minute while a provider is unavailable.
      delayMs = Math.max(TAG_MIGRATION_MIN_RETRY_MS, status.nextAttemptAt - Date.now());
    } else if (attempted >= TAG_MIGRATION_MAX_PER_RUN && status.active === 0) {
      // There is more immediately eligible work; continue in a small batch so
      // one idle event cannot monopolize the OpenCode plugin process.
      delayMs = TAG_MIGRATION_CONTINUATION_MS;
    }
    scheduleTagMigration(ctx, model, delayMs);
  } catch (error) {
    await logServiceError(ctx, `Automatic tag migration status check failed: ${String(error)}`);
    // A service restart or upgrade can temporarily make the status endpoint
    // unavailable. If this run had work or failed to contact the queue, retry
    // once the bridge is still alive instead of waiting for another user chat.
    if (queueFailed || attempted > 0) {
      scheduleTagMigration(ctx, model, TAG_MIGRATION_RETRY_MS);
    }
  }
}

async function createTechnicalTags(
  ctx: BridgeContext,
  model: CaptureModel,
  claim: TagMigrationClaim
): Promise<string[]> {
  if (
    !ctx.client?.session?.create ||
    !ctx.client?.session?.prompt ||
    !ctx.client?.session?.messages
  ) {
    throw new Error("OpenCode session API is unavailable for tag migration");
  }

  const created = await ctx.client.session.create({
    body: { title: INTERNAL_TAG_MIGRATION_TITLE },
  });
  const migrationSessionID = created?.data?.id || created?.id;
  if (!migrationSessionID) throw new Error("OpenCode did not return a tag migration session id");
  markInternalSession(migrationSessionID);

  try {
    await ctx.client.session.prompt({
      path: { id: migrationSessionID },
      body: {
        model,
        parts: [
          {
            type: "text",
            text:
              "Generate 2 to 4 concise lower-case technical tags for the stored coding memory below. " +
              "Do not repeat the memory and do not add explanations. Return only JSON in this exact shape: " +
              '{"tags":["tag-one","tag-two"]}.\n\n' +
              `Memory:\n${claim.content}`,
          },
        ],
      },
    });
    const generated = await ctx.client.session.messages({ path: { id: migrationSessionID } });
    const assistantText = (generated?.data || [])
      .filter((message: any) => message?.info?.role === "assistant")
      .map((message: any) => textFromParts(message.parts || []))
      .filter(Boolean)
      .join("\n")
      .trim();
    const tags = parseTechnicalTags(assistantText);
    if (tags.length === 0) throw new Error("The model returned no usable technical tags");
    return tags;
  } finally {
    if (typeof ctx.client.session.delete === "function") {
      await ctx.client.session.delete({ path: { id: migrationSessionID } }).catch(() => {});
    }
    releaseInternalSessionLater(migrationSessionID);
  }
}

async function runTagMigration(ctx: BridgeContext, model: CaptureModel): Promise<void> {
  if (tagMigrationRunning) return;
  tagMigrationRunning = true;
  let attempted = 0;
  let queueFailed = false;

  try {
    while (attempted < TAG_MIGRATION_MAX_PER_RUN) {
      const claimed = await rpc<{
        success: boolean;
        data?: { claim?: TagMigrationClaim | null };
        error?: string;
      }>("/api/migration/tags/claim", {
        method: "POST",
        body: JSON.stringify({ workerId: TAG_MIGRATION_WORKER_ID }),
      });
      if (!claimed.success) throw new Error(claimed.error || "Tag migration claim failed");
      const claim = claimed.data?.claim;
      if (!claim) break;

      attempted++;
      try {
        const tags = await createTechnicalTags(ctx, model, claim);
        const completed = await rpc<{
          success: boolean;
          data?: { memoryId: string; tags: string[] };
          error?: string;
        }>("/api/migration/tags/complete", {
          method: "POST",
          body: JSON.stringify({
            workerId: TAG_MIGRATION_WORKER_ID,
            claimId: claim.claimId,
            tags,
          }),
        });
        if (!completed.success)
          throw new Error(completed.error || "Tag migration completion failed");
        await logBridge(
          ctx,
          "info",
          `Automatic tag migration completed for ${claim.memoryId} using ${model.providerID}/${model.modelID}`
        );
      } catch (error) {
        const message = String(error);
        await rpc<{ success: boolean }>("/api/migration/tags/fail", {
          method: "POST",
          body: JSON.stringify({
            workerId: TAG_MIGRATION_WORKER_ID,
            claimId: claim.claimId,
            error: message,
          }),
        }).catch(() => {});
        await logServiceError(
          ctx,
          `Automatic tag migration failed for ${claim.memoryId}: ${message}`
        );
      }

      await sleep(TAG_MIGRATION_BETWEEN_ITEMS_MS);
    }
  } catch (error) {
    queueFailed = true;
    await logServiceError(ctx, `Automatic tag migration queue failed: ${String(error)}`);
  } finally {
    tagMigrationRunning = false;
  }

  await scheduleTagMigrationFromStatus(ctx, model, attempted, queueFailed);
}

export const OpenCodeMemoryBridge: Plugin = async (ctx: any) => {
  const bridgeContext: BridgeContext = { directory: ctx.directory, client: ctx.client };
  await logBridge(
    bridgeContext,
    "info",
    `OpenCode Memory bridge loaded for ${ctx.directory || process.cwd()}; automatic capture inherits the source session model`
  );
  return {
    config: async () => {},

    "chat.message": async (input: any, output: any) => {
      if (!input.sessionID || INTERNAL_SESSIONS.has(input.sessionID)) return;
      const inputModel = normalizeCaptureModel(input.model);
      if (inputModel) SESSION_MODELS.set(input.sessionID, inputModel);
      try {
        await injectContext(bridgeContext, input.sessionID, output);
      } catch (error) {
        await logServiceError(bridgeContext, `Memory context injection failed: ${String(error)}`);
      }
    },

    event: async ({ event }: { event: { type: string; properties?: any } }) => {
      if (event.type === "session.idle") {
        const sessionID = event.properties?.sessionID;
        if (!sessionID || (await isInternalCaptureSession(bridgeContext, sessionID))) return;
        if (ACTIVE_CAPTURE_SESSIONS.has(sessionID)) {
          await logBridge(
            bridgeContext,
            "info",
            `Automatic capture already running for ${sessionID}`
          );
          return;
        }
        ACTIVE_CAPTURE_SESSIONS.add(sessionID);
        let migrationModel: CaptureModel | undefined;
        void captureSession(bridgeContext, sessionID, (model) => {
          migrationModel = model;
        })
          .catch((error) =>
            logServiceError(bridgeContext, `Automatic capture failed: ${String(error)}`)
          )
          .finally(() => {
            if (migrationModel) void runTagMigration(bridgeContext, migrationModel);
            ACTIVE_CAPTURE_SESSIONS.delete(sessionID);
          });
      }

      if (event.type === "session.compacted") {
        const sessionID = event.properties?.sessionID;
        if (
          !sessionID ||
          (await isInternalCaptureSession(bridgeContext, sessionID)) ||
          !bridgeContext.client?.session?.prompt
        ) {
          return;
        }
        try {
          const result = await rpc<{ success: boolean; context?: string }>("/api/plugin/context", {
            method: "POST",
            body: JSON.stringify({
              directory: bridgeContext.directory || process.cwd(),
              sessionID,
              limit: 10,
            }),
          });
          if (result.success && result.context) {
            await bridgeContext.client.session.prompt({
              path: { id: sessionID },
              body: {
                parts: [
                  { type: "text", text: `Restore relevant project memory:\n\n${result.context}` },
                ],
                noReply: true,
              },
            });
          }
        } catch (error) {
          await logServiceError(
            bridgeContext,
            `Compaction memory restore failed: ${String(error)}`
          );
        }
      }

      if (event.type === "session.deleted") {
        const sessionID = event.properties?.info?.id || event.properties?.sessionID;
        if (!sessionID || INTERNAL_SESSIONS.has(sessionID)) return;
        ACTIVE_CAPTURE_SESSIONS.delete(sessionID);
        LAST_CAPTURE_FINGERPRINTS.delete(sessionID);
        SESSION_MODELS.delete(sessionID);
      }
    },

    tool: {
      memory: tool({
        description: "Manage and query OpenCode Memory through the local Windows service.",
        args: {
          mode: tool.schema
            .enum([
              "add",
              "search",
              "profile",
              "list",
              "forget",
              "help",
              "migrate",
              "list-shards",
              "export",
              "import",
            ])
            .optional(),
          content: tool.schema.string().optional(),
          query: tool.schema.string().optional(),
          tags: tool.schema.string().optional(),
          type: tool.schema.string().optional(),
          memoryId: tool.schema.string().optional(),
          limit: tool.schema.number().optional(),
          scope: tool.schema.enum(["project", "all-projects"]).optional(),
          fromPath: tool.schema.string().optional(),
          fromHash: tool.schema.string().optional(),
          outputPath: tool.schema.string().optional(),
          inputPath: tool.schema.string().optional(),
          dryRun: tool.schema.boolean().optional(),
          allowLinkedSource: tool.schema.boolean().optional(),
        },
        async execute(args: any, toolContext: any) {
          try {
            const result = await rpc<{ success: boolean; result?: unknown; error?: string }>(
              "/api/plugin/command",
              {
                method: "POST",
                body: JSON.stringify({
                  ...args,
                  directory: toolContext?.directory || bridgeContext.directory || process.cwd(),
                }),
              }
            );
            return JSON.stringify(result.result ?? result);
          } catch (error) {
            return JSON.stringify({ success: false, error: String(error) });
          }
        },
      }),
    },
  };
};

export default OpenCodeMemoryBridge;
