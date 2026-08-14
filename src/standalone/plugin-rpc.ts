import { initConfig, CONFIG } from "../config.js";
import { formatContextForPrompt } from "../services/context.js";
import { memoryClient } from "../services/client.js";
import { getTags } from "../services/tags.js";
import { stripPrivateContent, isFullyPrivate } from "../services/privacy.js";
import { ensureTursoReady } from "../services/turso/ready.js";
import type { MemoryType } from "../types/index.js";

// CONFIG is a module-level compatibility singleton in the upstream plugin.
// The desktop service can receive simultaneous requests from multiple OpenCode
// projects, so hold one request at a time while a project-specific config is
// active. This prevents project A from changing CONFIG halfway through an
// embedding or database operation for project B.
let configRequestTail: Promise<void> = Promise.resolve();

async function withProjectConfig<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const previous = configRequestTail;
  let release: () => void = () => {};
  configRequestTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    initConfig(directory);
    return await operation();
  } finally {
    release();
  }
}

export type PluginCommandRequest = {
  directory?: string;
  mode?:
    | "add"
    | "search"
    | "profile"
    | "list"
    | "forget"
    | "help"
    | "migrate"
    | "list-shards"
    | "export"
    | "import";
  content?: string;
  query?: string;
  tags?: string;
  type?: string;
  memoryId?: string;
  limit?: number;
  scope?: "project" | "all-projects";
  fromPath?: string;
  fromHash?: string;
  outputPath?: string;
  inputPath?: string;
  dryRun?: boolean;
  allowLinkedSource?: boolean;
};

export async function handlePluginCommand(request: PluginCommandRequest): Promise<unknown> {
  const directory = request.directory || process.cwd();
  return withProjectConfig(directory, async () => {
    const tags = getTags(directory);
    const mode = request.mode || "help";

    if (mode === "help") {
      return {
        success: true,
        message: "Memory System Usage Guide",
        commands: [
          "add",
          "search",
          "profile",
          "list",
          "forget",
          "list-shards",
          "migrate",
          "export",
          "import",
        ],
      };
    }

    await ensureTursoReady();
    if (!["list-shards", "migrate", "export"].includes(mode)) {
      await memoryClient.warmup();
    } else {
      await memoryClient.ensureStorageReady();
    }

    switch (mode) {
      case "add":
        return addMemory(request, tags);
      case "search":
        return searchMemories(request, tags);
      case "list": {
        const result = await memoryClient.listMemories(
          tags.project.tag,
          request.limit || 20,
          request.scope || CONFIG.memory.defaultScope
        );
        return result.success
          ? { success: true, count: result.memories.length, memories: result.memories }
          : result;
      }
      case "forget":
        if (!request.memoryId) return { success: false, error: "memoryId required" };
        return memoryClient.deleteMemory(request.memoryId);
      case "profile":
        return handleProfile(request, tags.user.userEmail || "unknown");
      case "list-shards":
        return memoryClient.listShards(directory);
      case "migrate":
        if (!request.fromPath && !request.fromHash) {
          return { success: false, error: "fromPath or fromHash required" };
        }
        return memoryClient.migrateProjectPath({
          currentDirectory: directory,
          fromPath: request.fromPath,
          fromHash: request.fromHash,
          dryRun: request.dryRun,
          allowLinkedSource: request.allowLinkedSource,
        });
      case "export":
        return request.outputPath
          ? memoryClient.exportMemories(directory, request.outputPath)
          : { success: false, error: "outputPath required" };
      case "import":
        return request.inputPath
          ? memoryClient.importMemories(directory, request.inputPath, request.dryRun)
          : { success: false, error: "inputPath required" };
      default:
        return { success: false, error: `Unknown mode: ${mode}` };
    }
  });
}

export async function handlePluginContext(request: {
  directory?: string;
  limit?: number;
  scope?: "project" | "all-projects";
}): Promise<unknown> {
  const directory = request.directory || process.cwd();
  return withProjectConfig(directory, async () => {
    const tags = getTags(directory);
    await ensureTursoReady();
    await memoryClient.warmup();

    const result = await memoryClient.listMemories(
      tags.project.tag,
      request.limit || CONFIG.chatMessage.maxMemories,
      request.scope || CONFIG.memory.defaultScope
    );
    if (!result.success) return result;

    const context = await formatContextForPrompt(tags.user.userEmail || null, {
      results: result.memories.map((memory) => ({ similarity: 1, memory: memory.summary })),
    });
    return { success: true, context, memories: result.memories };
  });
}

export async function handlePluginCapture(request: {
  directory?: string;
  content: string;
  type?: string;
  tags?: string[];
  sessionID?: string;
  promptId?: string;
}): Promise<unknown> {
  const directory = request.directory || process.cwd();
  return withProjectConfig(directory, async () => {
    const tags = getTags(directory);
    const content = stripPrivateContent(request.content || "");
    if (!content.trim() || isFullyPrivate(request.content || "")) {
      return { success: false, error: "Private or empty content blocked" };
    }
    await ensureTursoReady();
    await memoryClient.warmup();
    return memoryClient.addMemory(content, tags.project.tag, {
      source: "auto-capture",
      type: request.type as MemoryType,
      tags: request.tags,
      sessionID: request.sessionID,
      promptId: request.promptId,
      captureTimestamp: Date.now(),
      displayName: tags.project.displayName,
      userName: tags.project.userName,
      userEmail: tags.project.userEmail,
      projectPath: tags.project.projectPath,
      projectName: tags.project.projectName,
      gitRepoUrl: tags.project.gitRepoUrl,
    });
  });
}

async function addMemory(request: PluginCommandRequest, tags: ReturnType<typeof getTags>) {
  if (!request.content) return { success: false, error: "content required" };
  if (isFullyPrivate(request.content)) return { success: false, error: "Private content blocked" };
  const content = stripPrivateContent(request.content);
  const parsedTags = request.tags
    ? request.tags
        .split(",")
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
    : undefined;
  const result = await memoryClient.addMemory(content, tags.project.tag, {
    source: "manual",
    type: request.type as MemoryType,
    tags: parsedTags,
    displayName: tags.project.displayName,
    userName: tags.project.userName,
    userEmail: tags.project.userEmail,
    projectPath: tags.project.projectPath,
    projectName: tags.project.projectName,
    gitRepoUrl: tags.project.gitRepoUrl,
  });
  return { ...result, message: result.success ? "Memory added" : result.error };
}

async function searchMemories(request: PluginCommandRequest, tags: ReturnType<typeof getTags>) {
  if (!request.query) return { success: false, error: "query required" };
  const result = await memoryClient.searchMemories(
    request.query,
    tags.project.tag,
    request.scope || CONFIG.memory.defaultScope
  );
  if (!result.success) return result;
  return {
    success: true,
    query: request.query,
    count: result.results.length,
    results: result.results.slice(0, request.limit || CONFIG.maxMemories).map((item: any) => ({
      id: item.id,
      content: item.memory || item.chunk,
      similarity: Math.round(item.similarity * 100),
    })),
  };
}

async function handleProfile(request: PluginCommandRequest, userId: string): Promise<unknown> {
  const { userProfileManager } = await import("../services/user-profile/user-profile-manager.js");
  if (request.content !== undefined) {
    const trimmed = request.content.trim();
    if (!trimmed) return { success: false, error: "content must not be blank" };
    const sanitized = stripPrivateContent(trimmed);
    if (isFullyPrivate(trimmed)) return { success: false, error: "Private content blocked" };
    const preference = {
      category: "explicit",
      description: sanitized,
      confidence: 1,
      frequency: 1,
      evidence: ["manual-write"],
      lastSeen: Date.now(),
    };
    const existing = await userProfileManager.getActiveProfile(userId);
    if (existing) {
      const data = JSON.parse(existing.profileData);
      const merged = await userProfileManager.mergeProfileData(
        data,
        { preferences: [preference] },
        undefined,
        existing.id
      );
      await userProfileManager.updateProfile(existing.id, merged, 0, "Explicit preference added");
    } else {
      await userProfileManager.createProfile(
        userId,
        userId,
        userId,
        userId,
        {
          preferences: [preference],
          patterns: [],
          workflows: [],
        },
        0
      );
    }
    return { success: true, message: "Preference saved to profile" };
  }
  const profile = await userProfileManager.getActiveProfile(userId);
  return profile
    ? { success: true, profile: { ...JSON.parse(profile.profileData), version: profile.version } }
    : { success: true, profile: null };
}
