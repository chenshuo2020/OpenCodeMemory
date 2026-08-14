import { randomUUID } from "node:crypto";
import { initConfig, CONFIG } from "../config.js";
import { formatContextForPrompt } from "../services/context.js";
import { memoryClient } from "../services/client.js";
import { getTags } from "../services/tags.js";
import { stripPrivateContent, isFullyPrivate } from "../services/privacy.js";
import { ensureTursoReady } from "../services/turso/ready.js";
import { UserProfileValidator } from "../services/ai/validators/user-profile-validator.js";
import type { UserProfileData } from "../services/user-profile/types.js";
import type { MemoryType } from "../types/index.js";

// CONFIG is a module-level compatibility singleton in the upstream plugin.
// The desktop service can receive simultaneous requests from multiple OpenCode
// projects, so hold one request at a time while a project-specific config is
// active. This prevents project A from changing CONFIG halfway through an
// embedding or database operation for project B.
let configRequestTail: Promise<void> = Promise.resolve();

const PROFILE_LEARNING_LEASE_MS = 10 * 60 * 1000;

type ProfileLearningLease = {
  leaseId: string;
  directory: string;
  userId: string;
  promptIds: string[];
  expiresAt: number;
};

let activeProfileLearningLease: ProfileLearningLease | null = null;

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

export type PluginPromptRequest = {
  directory?: string;
  sessionID: string;
  messageID: string;
  content: string;
  providerID?: string;
  modelID?: string;
};

export type ProfileLearningPrepareRequest = {
  directory?: string;
};

export type ProfileLearningCompleteRequest = {
  directory?: string;
  leaseId: string;
  promptIds?: string[];
  analysis: unknown;
};

export type ProfileLearningReleaseRequest = {
  leaseId: string;
};

function normalizeProfileAnalysis(value: any): UserProfileData {
  const now = Date.now();
  const preferences = Array.isArray(value?.preferences)
    ? value.preferences
        .filter((item: any) => item && typeof item === "object")
        .map((item: any) => ({
          category: String(item.category || "").trim(),
          description: String(item.description || "").trim(),
          confidence: Math.min(
            1,
            Math.max(0, Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0)
          ),
          frequency: 1,
          evidence:
            Array.isArray(item.evidence) && item.evidence.length > 0
              ? item.evidence
                  .map((entry: unknown) => String(entry).trim())
                  .filter(Boolean)
                  .slice(0, 3)
              : ["recent user prompts"],
          lastSeen: now,
        }))
    : [];
  const patterns = Array.isArray(value?.patterns)
    ? value.patterns
        .filter((item: any) => item && typeof item === "object")
        .map((item: any) => ({
          category: String(item.category || "").trim(),
          description: String(item.description || "").trim(),
          confidence: 0.5,
          frequency: 1,
          evidence: [],
          lastSeen: now,
        }))
    : [];
  const workflows = Array.isArray(value?.workflows)
    ? value.workflows
        .filter((item: any) => item && typeof item === "object")
        .map((item: any) => ({
          description: String(item.description || "").trim(),
          confidence: 0.5,
          frequency: 1,
          evidence: [],
          lastSeen: now,
          steps: Array.isArray(item.steps)
            ? item.steps.map((step: unknown) => String(step).trim()).filter(Boolean).slice(0, 6)
            : [],
        }))
    : [];

  return { preferences, patterns, workflows };
}

function releaseProfileLearningLease(leaseId: string): boolean {
  if (activeProfileLearningLease?.leaseId !== leaseId) return false;
  activeProfileLearningLease = null;
  return true;
}

export async function handlePluginPrompt(request: PluginPromptRequest): Promise<unknown> {
  const directory = request.directory || process.cwd();
  return withProjectConfig(directory, async () => {
    const rawContent = String(request.content || "");
    const content = stripPrivateContent(rawContent).trim();
    if (!content || isFullyPrivate(rawContent)) {
      return { success: true, skipped: true, reason: "Private or empty content" };
    }

    const { userPromptManager } = await import("../services/user-prompt/user-prompt-manager.js");
    const promptId = await userPromptManager.savePrompt(
      request.sessionID,
      request.messageID,
      directory,
      content
    );
    if (request.providerID && request.modelID) {
      await userPromptManager.setPromptModel(request.messageID, request.providerID, request.modelID);
    }

    return { success: true, promptId };
  });
}

export async function handleProfileLearningPrepare(
  request: ProfileLearningPrepareRequest
): Promise<unknown> {
  const directory = request.directory || process.cwd();
  return withProjectConfig(directory, async () => {
    const now = Date.now();
    if (activeProfileLearningLease && activeProfileLearningLease.expiresAt <= now) {
      activeProfileLearningLease = null;
    }
    if (activeProfileLearningLease) {
      return {
        success: true,
        data: { ready: false, busy: true, count: 0, threshold: CONFIG.userProfileAnalysisInterval },
      };
    }

    const { userPromptManager } = await import("../services/user-prompt/user-prompt-manager.js");
    const threshold = Math.max(1, Math.floor(CONFIG.userProfileAnalysisInterval || 10));
    const count = await userPromptManager.countUnanalyzedForUserLearning();
    if (count < threshold) {
      return { success: true, data: { ready: false, busy: false, count, threshold } };
    }

    const prompts = await userPromptManager.getPromptsForUserLearning(threshold);
    if (prompts.length === 0) {
      return { success: true, data: { ready: false, busy: false, count: 0, threshold } };
    }

    const { userProfileManager } = await import("../services/user-profile/user-profile-manager.js");
    const tags = getTags(directory);
    const userId = tags.user.userEmail || "unknown";
    const profile = await userProfileManager.getActiveProfile(userId);
    const lease: ProfileLearningLease = {
      leaseId: `profile-learning-${randomUUID()}`,
      directory,
      userId,
      promptIds: prompts.map((prompt) => prompt.id),
      expiresAt: now + PROFILE_LEARNING_LEASE_MS,
    };
    activeProfileLearningLease = lease;

    return {
      success: true,
      data: {
        ready: true,
        leaseId: lease.leaseId,
        expiresAt: lease.expiresAt,
        count,
        threshold,
        prompts: prompts.map((prompt) => ({
          id: prompt.id,
          content: prompt.content,
          createdAt: prompt.createdAt,
          providerId: prompt.providerId,
          modelId: prompt.modelId,
        })),
        user: {
          userId,
          displayName: tags.user.displayName || "Unknown",
          userName: tags.user.userName || "unknown",
          userEmail: tags.user.userEmail || "unknown",
        },
        profile: profile
          ? {
              id: profile.id,
              version: profile.version,
              totalPromptsAnalyzed: profile.totalPromptsAnalyzed,
              profileData: JSON.parse(profile.profileData),
            }
          : null,
      },
    };
  });
}

export async function handleProfileLearningComplete(
  request: ProfileLearningCompleteRequest
): Promise<unknown> {
  const lease = activeProfileLearningLease;
  if (!lease || lease.leaseId !== request.leaseId) {
    return { success: false, error: "Profile learning lease is missing or expired" };
  }
  if (lease.expiresAt <= Date.now()) {
    activeProfileLearningLease = null;
    return { success: false, error: "Profile learning lease expired" };
  }

  const promptIds = request.promptIds || [];
  if (
    promptIds.length !== lease.promptIds.length ||
    promptIds.some((promptId) => !lease.promptIds.includes(promptId))
  ) {
    return { success: false, error: "Profile learning prompt batch does not match the lease" };
  }

  const profileData = normalizeProfileAnalysis(request.analysis);
  const validation = UserProfileValidator.validate(profileData);
  const validatedProfileData = validation.data;
  if (!validation.valid || !validatedProfileData) {
    return { success: false, error: `Invalid profile analysis: ${validation.errors.join("; ")}` };
  }
  const hasObservations =
    validatedProfileData.preferences.length > 0 ||
    validatedProfileData.patterns.length > 0 ||
    validatedProfileData.workflows.length > 0;

  const directory = request.directory || lease.directory;
  return withProjectConfig(directory, async () => {
    const { userPromptManager } = await import("../services/user-prompt/user-prompt-manager.js");
    const { userProfileManager } = await import("../services/user-profile/user-profile-manager.js");
    if (!hasObservations) {
      await userPromptManager.markMultipleAsUserLearningCaptured(promptIds);
      releaseProfileLearningLease(lease.leaseId);
      return {
        success: true,
        data: { profileId: null, analyzedPrompts: promptIds.length, applied: false },
      };
    }
    const tags = getTags(directory);
    const userId = tags.user.userEmail || lease.userId || "unknown";
    let profile = await userProfileManager.getActiveProfile(userId);
    let profileId: string;

    if (profile) {
      let merged = await userProfileManager.mergeProfileData(
        JSON.parse(profile.profileData),
        validatedProfileData,
        undefined,
        profile.id
      );
      let updated = await userProfileManager.updateProfile(
        profile.id,
        merged,
        promptIds.length,
        `Automatic profile learning from ${promptIds.length} prompts`
      );

      if (!updated) {
        profile = await userProfileManager.getActiveProfile(userId);
        if (!profile) throw new Error("User profile disappeared during update");
        merged = await userProfileManager.mergeProfileData(
          JSON.parse(profile.profileData),
          validatedProfileData,
          undefined,
          profile.id
        );
        updated = await userProfileManager.updateProfile(
          profile.id,
          merged,
          promptIds.length,
          `Automatic profile learning from ${promptIds.length} prompts`
        );
      }
      if (!updated) throw new Error("User profile update conflict");
      profileId = profile.id;
    } else {
      profileId = await userProfileManager.createProfile(
        userId,
        tags.user.displayName || "Unknown",
        tags.user.userName || "unknown",
        tags.user.userEmail || "unknown",
        validatedProfileData,
        promptIds.length
      );
    }

    await userPromptManager.markMultipleAsUserLearningCaptured(promptIds);
    releaseProfileLearningLease(lease.leaseId);
    return {
      success: true,
      data: {
        profileId,
        analyzedPrompts: promptIds.length,
        preferenceCount: validatedProfileData.preferences.length,
        patternCount: validatedProfileData.patterns.length,
        workflowCount: validatedProfileData.workflows.length,
      },
    };
  });
}

export async function handleProfileLearningRelease(
  request: ProfileLearningReleaseRequest
): Promise<unknown> {
  return { success: true, released: releaseProfileLearningLease(request.leaseId) };
}

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
