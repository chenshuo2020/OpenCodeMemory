import { createHash, randomUUID } from "node:crypto";
import { embeddingService } from "./embedding.js";
import { log } from "./logger.js";
import { stripPrivateContent } from "./privacy.js";
import { tursoConnectionManager } from "./turso/connection-manager.js";
import { ensureTursoReady } from "./turso/ready.js";
import { tursoShardManager } from "./turso/shard-manager.js";
import type { ShardInfo } from "./turso/types.js";
import { formatTagsForEmbedding, vectorToJson } from "./turso/vector-utils.js";

const CLAIM_TTL_MS = 5 * 60 * 1000;
const RETRY_BASE_MS = 60 * 1000;
const RETRY_MAX_MS = 30 * 60 * 1000;
const CLAIM_SCAN_LIMIT = 100;
const MAX_CONTENT_CHARS = 12_000;

interface TagMigrationClaimRecord {
  claimId: string;
  workerId: string;
  memoryKey: string;
  memoryId: string;
  contentHash: string;
  shard: ShardInfo;
  expiresAt: number;
  completing: boolean;
}

interface RetryState {
  attempts: number;
  nextAttemptAt: number;
  error: string;
}

export interface TagMigrationClaim {
  claimId: string;
  memoryId: string;
  content: string;
  projectPath?: string;
  projectName?: string;
  remaining: number;
}

export interface TagMigrationStatus {
  pending: number;
  active: number;
  deferred: number;
  /** Earliest retry time, if one or more memories are currently backing off. */
  nextAttemptAt: number | null;
  lastError: string | null;
}

const claimsById = new Map<string, TagMigrationClaimRecord>();
const claimIdByMemory = new Map<string, string>();
const retryByMemory = new Map<string, RetryState>();
let lastError: string | null = null;
let queueTail: Promise<void> = Promise.resolve();

async function withQueueLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = queueTail;
  let release: () => void = () => {};
  queueTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

function memoryKey(shardId: number, memoryId: string): string {
  return `${shardId}:${memoryId}`;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function releaseClaim(record: TagMigrationClaimRecord): void {
  claimsById.delete(record.claimId);
  if (claimIdByMemory.get(record.memoryKey) === record.claimId) {
    claimIdByMemory.delete(record.memoryKey);
  }
}

function cleanupExpiredClaims(now = Date.now()): void {
  for (const record of claimsById.values()) {
    if (record.expiresAt > now || record.completing) continue;
    releaseClaim(record);
    log("Tag migration claim expired", {
      claimId: record.claimId,
      memoryId: record.memoryId,
      workerId: record.workerId,
    });
  }
}

function scheduleRetry(memory: string, error: string): void {
  const previous = retryByMemory.get(memory);
  const attempts = (previous?.attempts ?? 0) + 1;
  const delay = Math.min(RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 8), RETRY_MAX_MS);
  retryByMemory.set(memory, {
    attempts,
    nextAttemptAt: Date.now() + delay,
    error,
  });
  lastError = error;
}

function isDeferred(memory: string, now = Date.now()): boolean {
  const retry = retryByMemory.get(memory);
  if (!retry) return false;
  if (retry.nextAttemptAt <= now) {
    retryByMemory.delete(memory);
    return false;
  }
  return true;
}

function cleanTag(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^[-*\d.)\s]+/, "")
    .replace(/^["'`]+|["'`.,;:]+$/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}#+._/-]/gu, "")
    .slice(0, 48);
}

export function normalizeTechnicalTags(values: unknown[]): string[] {
  const unique: string[] = [];
  for (const value of values) {
    const tag = cleanTag(value);
    if (!tag || unique.includes(tag)) continue;
    unique.push(tag);
    if (unique.length >= 4) break;
  }
  return unique;
}

async function getProjectShards(): Promise<ShardInfo[]> {
  await ensureTursoReady();
  return tursoShardManager.getAllShards("project", "");
}

async function countPendingMemories(shards: ShardInfo[]): Promise<number> {
  let pending = 0;
  for (const shard of shards) {
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    const row = await db.get(
      "SELECT COUNT(*) AS count FROM memories WHERE tags IS NULL OR TRIM(tags) = ''"
    );
    pending += Number(row?.count ?? 0);
  }
  return pending;
}

export async function getTagMigrationStatus(): Promise<TagMigrationStatus> {
  return withQueueLock(async () => {
    cleanupExpiredClaims();
    const shards = await getProjectShards();
    const pending = await countPendingMemories(shards);
    const now = Date.now();
    let deferred = 0;
    let nextAttemptAt: number | null = null;
    for (const [memory, retry] of retryByMemory) {
      if (retry.nextAttemptAt <= now) {
        retryByMemory.delete(memory);
        continue;
      }
      deferred++;
      if (nextAttemptAt === null || retry.nextAttemptAt < nextAttemptAt) {
        nextAttemptAt = retry.nextAttemptAt;
      }
    }
    return {
      pending,
      active: claimsById.size,
      deferred,
      nextAttemptAt,
      lastError,
    };
  });
}

export async function claimNextTagMigration(workerId: string): Promise<TagMigrationClaim | null> {
  return withQueueLock(async () => {
    cleanupExpiredClaims();
    const normalizedWorker = workerId.trim().slice(0, 120) || "opencode-bridge";
    const shards = await getProjectShards();
    const pending = await countPendingMemories(shards);
    const now = Date.now();

    for (const shard of shards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const rows = await db.all(
        `SELECT id, content, project_path, project_name
         FROM memories
         WHERE tags IS NULL OR TRIM(tags) = ''
         ORDER BY created_at ASC
         LIMIT ?`,
        [CLAIM_SCAN_LIMIT]
      );

      for (const row of rows) {
        const memoryId = String(row.id);
        const key = memoryKey(shard.id, memoryId);
        if (claimIdByMemory.has(key) || isDeferred(key, now)) continue;

        const originalContent = String(row.content ?? "");

        const claimId = randomUUID();
        const record: TagMigrationClaimRecord = {
          claimId,
          workerId: normalizedWorker,
          memoryKey: key,
          memoryId,
          contentHash: hashContent(originalContent),
          shard,
          expiresAt: now + CLAIM_TTL_MS,
          completing: false,
        };
        claimsById.set(claimId, record);
        claimIdByMemory.set(key, claimId);

        const sanitized = stripPrivateContent(originalContent).trim().slice(-MAX_CONTENT_CHARS);
        log("Tag migration memory claimed", {
          claimId,
          memoryId,
          workerId: normalizedWorker,
          remaining: pending,
        });
        return {
          claimId,
          memoryId,
          content: sanitized || "[REDACTED]",
          projectPath: row.project_path ? String(row.project_path) : undefined,
          projectName: row.project_name ? String(row.project_name) : undefined,
          remaining: pending,
        };
      }
    }

    return null;
  });
}

export async function completeTagMigrationClaim(options: {
  claimId: string;
  workerId: string;
  tags: unknown[];
}): Promise<{ memoryId: string; tags: string[] }> {
  const tags = normalizeTechnicalTags(options.tags);
  if (tags.length === 0) {
    throw new Error("The model returned no usable technical tags");
  }

  const record = await withQueueLock(async () => {
    cleanupExpiredClaims();
    const active = claimsById.get(options.claimId);
    if (!active) throw new Error("Tag migration claim is missing or expired");
    if (active.workerId !== options.workerId.trim().slice(0, 120)) {
      throw new Error("Tag migration claim belongs to another worker");
    }
    if (active.completing) throw new Error("Tag migration claim is already completing");
    active.completing = true;
    active.expiresAt = Date.now() + CLAIM_TTL_MS;
    return active;
  });

  try {
    const db = await tursoConnectionManager.getConnection(record.shard.dbPath);
    const row = await db.get("SELECT content, tags FROM memories WHERE id = ?", [record.memoryId]);
    if (!row) throw new Error("Memory no longer exists");
    if (String(row.tags ?? "").trim()) {
      await withQueueLock(async () => releaseClaim(record));
      return {
        memoryId: record.memoryId,
        tags: normalizeTechnicalTags(String(row.tags).split(",")),
      };
    }

    const content = String(row.content ?? "");
    if (hashContent(content) !== record.contentHash) {
      throw new Error("Memory changed while tag migration was running; it will be retried");
    }
    // Existing pre-migration data may predate the current privacy filter. Never
    // send a <private> region to a remote embedding backend while repairing its
    // vectors; the stored text remains unchanged, but its searchable vector is
    // based on the same redacted representation we gave to the tag model.
    const contentForEmbedding = stripPrivateContent(content);
    const contentVector = await embeddingService.embedWithTimeout(contentForEmbedding, {
      task: "document",
    });
    const tagsVector = await embeddingService.embedWithTimeout(formatTagsForEmbedding(tags), {
      task: "document",
    });

    const updated = await tursoShardManager.withScopeWriteLock(
      record.shard.scope,
      record.shard.scopeHash,
      async () =>
        db.run(
          `UPDATE memories
           SET tags = ?, vector = vector32(?), tags_vector = vector32(?), updated_at = ?
           WHERE id = ? AND content = ? AND (tags IS NULL OR TRIM(tags) = '')`,
          [
            tags.join(","),
            vectorToJson(contentVector),
            vectorToJson(tagsVector),
            Date.now(),
            record.memoryId,
            content,
          ]
        )
    );
    if (updated !== 1) {
      throw new Error("Memory changed while tag migration was running; it will be retried");
    }

    await withQueueLock(async () => {
      releaseClaim(record);
      retryByMemory.delete(record.memoryKey);
      lastError = null;
    });
    log("Tag migration memory completed", {
      memoryId: record.memoryId,
      tags,
      workerId: record.workerId,
    });
    return { memoryId: record.memoryId, tags };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withQueueLock(async () => {
      releaseClaim(record);
      scheduleRetry(record.memoryKey, message);
    });
    log("Tag migration completion failed", {
      memoryId: record.memoryId,
      workerId: record.workerId,
      error: message,
    });
    throw error;
  }
}

export async function failTagMigrationClaim(options: {
  claimId: string;
  workerId: string;
  error: string;
}): Promise<void> {
  await withQueueLock(async () => {
    cleanupExpiredClaims();
    const record = claimsById.get(options.claimId);
    if (!record || record.workerId !== options.workerId.trim().slice(0, 120)) return;
    releaseClaim(record);
    const message = options.error.trim().slice(0, 1000) || "Unknown model error";
    scheduleRetry(record.memoryKey, message);
    log("Tag migration claim released after model failure", {
      memoryId: record.memoryId,
      workerId: record.workerId,
      error: message,
    });
  });
}

export function resetTagMigrationStateForTests(): void {
  claimsById.clear();
  claimIdByMemory.clear();
  retryByMemory.clear();
  lastError = null;
  queueTail = Promise.resolve();
}
