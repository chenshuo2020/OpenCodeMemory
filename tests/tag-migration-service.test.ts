import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

let baseDir: string | undefined;
let restoreEmbedding: (() => void) | undefined;
let restoreConfig: (() => void) | undefined;

afterEach(async () => {
  restoreEmbedding?.();
  restoreEmbedding = undefined;
  restoreConfig?.();
  restoreConfig = undefined;

  const { resetTagMigrationStateForTests } =
    await import("../src/services/tag-migration-service.js");
  resetTagMigrationStateForTests();
  await cleanupTursoTestDirectory(baseDir);
  baseDir = undefined;
});

describe("automatic legacy memory tag migration", () => {
  it("claims one untagged memory, redacts private content, and rewrites both vectors on completion", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "opencode-mem-tag-migration-"));

    const { CONFIG } = await import("../src/config.js");
    const previousStoragePath = CONFIG.storagePath;
    const previousDimensions = CONFIG.embeddingDimensions;
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 3;
    restoreConfig = () => {
      CONFIG.storagePath = previousStoragePath;
      CONFIG.embeddingDimensions = previousDimensions;
    };

    const [{ tursoShardManager }, { tursoConnectionManager }, { tursoVectorSearch }] =
      await Promise.all([
        import("../src/services/turso/shard-manager.js"),
        import("../src/services/turso/connection-manager.js"),
        import("../src/services/turso/vector-search.js"),
      ]);
    const scopeHash = "0123456789abcdef";
    const shard = await tursoShardManager.createShard("project", scopeHash, 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    const originalContent =
      "Keep this fix. <private>do-not-send-this-secret</private> The bridge retries safely.";

    await tursoVectorSearch.insertVector(db, {
      id: "legacy_untagged_memory",
      content: originalContent,
      vector: new Float32Array([1, 0, 0]),
      containerTag: `opencode_project_${scopeHash}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const { embeddingService } = await import("../src/services/embedding.js");
    const originalEmbedWithTimeout = embeddingService.embedWithTimeout;
    const embeddingInputs: string[] = [];
    (embeddingService as any).embedWithTimeout = async (input: string) => {
      embeddingInputs.push(input);
      return new Float32Array([0.1, 0.2, 0.3]);
    };
    restoreEmbedding = () => {
      (embeddingService as any).embedWithTimeout = originalEmbedWithTimeout;
    };

    const {
      claimNextTagMigration,
      completeTagMigrationClaim,
      getTagMigrationStatus,
      resetTagMigrationStateForTests,
    } = await import("../src/services/tag-migration-service.js");
    resetTagMigrationStateForTests();

    const claim = await claimNextTagMigration("test-worker-a");
    expect(claim).not.toBeNull();
    if (!claim) throw new Error("Expected the untagged memory to be claimed");
    expect(claim.content).toContain("[REDACTED]");
    expect(claim.content).not.toContain("do-not-send-this-secret");
    expect(await claimNextTagMigration("test-worker-b")).toBeNull();

    const completed = await completeTagMigrationClaim({
      workerId: "test-worker-a",
      claimId: claim.claimId,
      tags: ["DeepSeek", "Windows Bridge", "deepseek"],
    });
    expect(completed.tags).toEqual(["deepseek", "windows-bridge"]);

    const row = await db.get(
      `SELECT tags, vector_extract(vector) AS vector_json, vector_extract(tags_vector) AS tags_vector_json
       FROM memories WHERE id = ?`,
      ["legacy_untagged_memory"]
    );
    expect(String(row?.tags)).toBe("deepseek,windows-bridge");
    expect(JSON.parse(String(row?.vector_json))).toHaveLength(3);
    expect(JSON.parse(String(row?.tags_vector_json))).toHaveLength(3);
    expect(embeddingInputs[0]).toContain("[REDACTED]");
    expect(embeddingInputs.join("\n")).not.toContain("do-not-send-this-secret");

    const status = await getTagMigrationStatus();
    expect(status.pending).toBe(0);
    expect(status.active).toBe(0);
  });
});
