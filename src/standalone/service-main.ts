import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG, initConfig } from "../config.js";
import { embeddingService } from "../services/embedding.js";
import { log } from "../services/logger.js";
import { WebAuth } from "../services/web-auth.js";
import { startWebServer, type WebServerRequestHandler } from "../services/web-server.js";
import { ensureTursoReady } from "../services/turso/ready.js";
import {
  getEmbeddingStatus,
  getHealthStatus,
  getServiceStatus,
  markDatabaseError,
  markDatabaseReady,
  markServiceStopping,
  recordEmbeddingSelfTest,
} from "./service-state.js";
import {
  handlePluginCapture,
  handlePluginCommand,
  handlePluginContext,
  handlePluginPrompt,
  handleProfileLearningComplete,
  handleProfileLearningPrepare,
  handleProfileLearningRelease,
  type PluginPromptRequest,
  type ProfileLearningCompleteRequest,
  type ProfileLearningPrepareRequest,
  type ProfileLearningReleaseRequest,
  type PluginCommandRequest,
} from "./plugin-rpc.js";

const projectRoot = process.env.OPENCODE_MEM_PROJECT_ROOT || process.cwd();
initConfig(projectRoot);
process.env.OPENCODE_MEM_SERVICE = "1";

const started = Date.now();
let server: Awaited<ReturnType<typeof startWebServer>> | null = null;
let shuttingDown = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function readTail(filePath: string, maxLines: number): string[] {
  try {
    if (!existsSync(filePath)) return [];
    return readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch (error) {
    log("Failed to read service log", { error: String(error) });
    return [];
  }
}

function getLogPath(): string {
  return process.env.OPENCODE_MEM_LOG_FILE || join(homedir(), ".opencode-mem", "opencode-mem.log");
}

const requestHandler: WebServerRequestHandler = async (req, context) => {
  if (context.path === "/api/plugin/command" && context.method === "POST") {
    return json({
      success: true,
      result: await handlePluginCommand((await req.json()) as PluginCommandRequest),
    });
  }

  if (context.path === "/api/plugin/context" && context.method === "POST") {
    return json(
      await handlePluginContext(
        (await req.json()) as {
          directory?: string;
          limit?: number;
          scope?: "project" | "all-projects";
        }
      )
    );
  }

  if (context.path === "/api/plugin/capture" && context.method === "POST") {
    const captureRequest = (await req.json()) as {
      directory?: string;
      content: string;
      type?: string;
      tags?: string[];
      sessionID?: string;
      promptId?: string;
    };
    log("Bridge capture request received", {
      directory: captureRequest.directory,
      sessionID: captureRequest.sessionID,
    });
    const result = await handlePluginCapture(captureRequest);
    log("Bridge capture request completed", {
      directory: captureRequest.directory,
      sessionID: captureRequest.sessionID,
      success: Boolean((result as { success?: boolean })?.success),
      error: (result as { error?: string })?.error,
    });
    return json(result);
  }

  if (context.path === "/api/plugin/prompt" && context.method === "POST") {
    const promptRequest = (await req.json()) as PluginPromptRequest;
    const result = await handlePluginPrompt(promptRequest);
    log("Bridge prompt request completed", {
      directory: promptRequest.directory,
      sessionID: promptRequest.sessionID,
      messageID: promptRequest.messageID,
      success: Boolean((result as { success?: boolean })?.success),
      skipped: Boolean((result as { skipped?: boolean })?.skipped),
      error: (result as { error?: string })?.error,
    });
    return json(result);
  }

  if (context.path === "/api/plugin/profile-learning/prepare" && context.method === "POST") {
    const result = await handleProfileLearningPrepare(
      (await req.json()) as ProfileLearningPrepareRequest
    );
    return json(result);
  }

  if (context.path === "/api/plugin/profile-learning/complete" && context.method === "POST") {
    const result = await handleProfileLearningComplete(
      (await req.json()) as ProfileLearningCompleteRequest
    );
    return json(result);
  }

  if (context.path === "/api/plugin/profile-learning/release" && context.method === "POST") {
    const result = await handleProfileLearningRelease(
      (await req.json()) as ProfileLearningReleaseRequest
    );
    return json(result);
  }

  if (context.path === "/api/system/status" && context.method === "GET") {
    const status = getServiceStatus();
    return json({ success: true, data: { status }, status });
  }

  if (context.path === "/api/model/status" && context.method === "GET") {
    const status = getEmbeddingStatus();
    return json({ success: true, data: { status }, status });
  }

  if (context.path === "/api/model/self-test" && context.method === "POST") {
    try {
      const result = await embeddingService.selfTest();
      recordEmbeddingSelfTest(result);
      const status = getEmbeddingStatus();
      return json({ success: true, data: { result, status }, result, status });
    } catch (error) {
      return json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        503
      );
    }
  }

  if (context.path === "/api/model/warmup" && context.method === "POST") {
    try {
      await embeddingService.warmup();
      return json({ success: true, status: getEmbeddingStatus() });
    } catch (error) {
      return json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        503
      );
    }
  }

  if (context.path === "/api/logs" && context.method === "GET") {
    const requested = Number(context.url.searchParams.get("lines") || 200);
    const lines = Math.max(1, Math.min(1000, Number.isFinite(requested) ? requested : 200));
    return json({ success: true, path: getLogPath(), lines: readTail(getLogPath(), lines) });
  }

  if (context.path === "/api/service/connection" && context.method === "GET") {
    return json({
      success: true,
      baseUrl: `http://${process.env.OPENCODE_MEM_HOST || CONFIG.webServerHost}:${
        process.env.OPENCODE_MEM_PORT || CONFIG.webServerPort
      }`,
      tokenHeader: "x-opencode-mem-token",
      tokenFile: join(homedir(), ".opencode-mem", ".auth-token"),
    });
  }

  if (context.path === "/api/service/shutdown" && context.method === "POST") {
    setImmediate(() => void shutdown());
    return json({ success: true });
  }

  return undefined;
};

async function main(): Promise<void> {
  log("Starting standalone OpenCode Memory service", {
    projectRoot,
    version: process.env.OPENCODE_MEM_VERSION || "dev",
    node: process.version,
  });

  try {
    await ensureTursoReady();
    markDatabaseReady();
  } catch (error) {
    markDatabaseError(error);
    log("Standalone service database initialization failed", { error: String(error) });
  }

  const webAuth = new WebAuth({
    password: CONFIG.webServerAuthPassword,
    username: CONFIG.webServerAuthUsername,
  });

  server = await startWebServer({
    port: Number(process.env.OPENCODE_MEM_PORT || CONFIG.webServerPort),
    host: process.env.OPENCODE_MEM_HOST || CONFIG.webServerHost,
    enabled: true,
    auth: webAuth,
    apiToken: CONFIG.webServerApiToken,
    requestHandler,
    healthProvider: getHealthStatus,
  });

  log("Standalone service HTTP server started", {
    url: server.getUrl(),
  });

  // The service is intentionally ready to answer health checks before the model
  // is warmed up. This lets the desktop panel show progress instead of timing out.
  try {
    const bundle = getEmbeddingStatus().bundle;
    if (bundle.required && !bundle.valid) {
      throw new Error(bundle.error || "Bundled embedding model validation failed");
    }
    await embeddingService.warmup();
    await embeddingService.selfTest().then(recordEmbeddingSelfTest);
  } catch (error) {
    log("Standalone service embedding warmup failed", { error: String(error) });
  }

  log("Standalone service initialization complete", { elapsedMs: Date.now() - started });
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  markServiceStopping();
  log("Stopping standalone OpenCode Memory service");
  await server?.stop();
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.once("beforeExit", () => void shutdown());

void main().catch((error) => {
  log("Standalone service fatal error", { error: String(error) });
  process.exitCode = 1;
});
