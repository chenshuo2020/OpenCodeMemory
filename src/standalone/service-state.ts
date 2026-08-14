import { CONFIG } from "../config.js";
import { embeddingService, type EmbeddingRuntimeStatus } from "../services/embedding.js";
import { getModelBundleStatus, type ModelBundleStatus } from "./model-bundle.js";

export type ServiceLifecycle = "starting" | "ready" | "degraded" | "stopping";

const startedAt = new Date();
let lifecycle: ServiceLifecycle = "starting";
let databaseReady = false;
let databaseError: string | null = null;
let lastSelfTest: { at: string; dimensions: number; finite: boolean } | null = null;

export function markDatabaseReady(): void {
  databaseReady = true;
  databaseError = null;
  refreshLifecycle();
}

export function markDatabaseError(error: unknown): void {
  databaseReady = false;
  databaseError = error instanceof Error ? error.message : String(error);
  refreshLifecycle();
}

export function markServiceStopping(): void {
  lifecycle = "stopping";
}

export function recordEmbeddingSelfTest(result: { dimensions: number; finite: boolean }): void {
  lastSelfTest = { ...result, at: new Date().toISOString() };
  refreshLifecycle();
}

export function getEmbeddingStatus(): EmbeddingRuntimeStatus & {
  lastSelfTest: typeof lastSelfTest;
  bundle: ModelBundleStatus;
} {
  const status = embeddingService.getStatus();
  return {
    ...status,
    lastSelfTest,
    bundle: getModelBundleStatus({ model: status.model, dimensions: status.dimensions }),
  };
}

export function getServiceStatus() {
  const embedding = getEmbeddingStatus();
  const autoCaptureProvider =
    process.env.OPENCODE_MEM_SERVICE === "1"
      ? { ready: true as const, mode: "opencode-session" as const, issues: [] }
      : CONFIG.autoCaptureProviderStatus;
  return {
    lifecycle,
    version: process.env.OPENCODE_MEM_VERSION || "dev",
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    port: Number(process.env.OPENCODE_MEM_PORT || CONFIG.webServerPort),
    host: process.env.OPENCODE_MEM_HOST || CONFIG.webServerHost,
    database: {
      ready: databaseReady,
      error: databaseError,
    },
    embedding,
    autoCaptureProvider,
  };
}

export function getHealthStatus(): Record<string, unknown> {
  const status = getServiceStatus();
  return {
    service: status.lifecycle,
    databaseReady,
    embeddingReady: status.embedding.ready,
    embeddingInitializing: status.embedding.initializing,
    embeddingError: status.embedding.error,
  };
}

function refreshLifecycle(): void {
  if (lifecycle === "stopping") return;
  const embedding = embeddingService.getStatus();
  lifecycle = databaseReady && embedding.ready ? "ready" : "degraded";
}
