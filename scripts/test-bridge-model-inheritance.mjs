import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sourceSessionID = "source-session";
const captureSessionID = "capture-session";
const tagMigrationSessionID = "tag-migration-session";
const sourceModel = {
  providerID: "deepseek",
  modelID: "deepseek-v4-flash",
};
let activeCaptureRequests = [];
let activeTagMigrationCompletions = [];
let activeTagMigrationFailures = [];
let activeTagMigrationStatusRequests = [];
let nextTagMigrationClaim = null;
let tagMigrationStatus = {
  pending: 0,
  active: 0,
  deferred: 0,
  nextAttemptAt: null,
  lastError: null,
};

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function waitFor(condition, label) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function runCaptureCase(name, sourceMessages) {
  const promptCalls = [];
  const captureRequests = [];
  activeCaptureRequests = captureRequests;
  activeTagMigrationCompletions = [];
  activeTagMigrationFailures = [];
  activeTagMigrationStatusRequests = [];
  nextTagMigrationClaim = null;
  tagMigrationStatus = { pending: 0, active: 0, deferred: 0, nextAttemptAt: null, lastError: null };
  const deletedSessions = [];
  const logs = [];
  let createCalls = 0;
  let bridge;

  const client = {
    session: {
      async messages({ path }) {
        if (path.id === sourceSessionID) return { data: sourceMessages };
        if (path.id === captureSessionID) {
          return {
            data: [
              {
                info: { role: "assistant", ...sourceModel },
                parts: [{ type: "text", text: "## Outcome\nSaved the technical work." }],
              },
            ],
          };
        }
        throw new Error(`Unexpected session lookup: ${path.id}`);
      },
      async get({ path }) {
        return {
          data: {
            id: path.id,
            title: path.id === captureSessionID ? "OpenCode Memory Auto Capture" : "Source session",
          },
        };
      },
      async create() {
        createCalls++;
        return { data: { id: captureSessionID } };
      },
      async prompt(request) {
        promptCalls.push(request);
        await bridge.event({
          event: {
            type: "session.idle",
            properties: { sessionID: captureSessionID },
          },
        });
        return { data: {} };
      },
      async delete({ path }) {
        deletedSessions.push(path.id);
      },
    },
    app: {
      async log({ body }) {
        logs.push(body);
      },
    },
  };

  const bridgeUrl = pathToFileURL(resolve("artifacts/plugin/opencode-mem.js"));
  bridgeUrl.searchParams.set("test", `${name}-${Date.now()}`);
  const { OpenCodeMemoryBridge } = await import(bridgeUrl.href);
  bridge = await OpenCodeMemoryBridge({ directory: "C:/test/project", client });

  await bridge.event({
    event: {
      type: "session.idle",
      properties: { sessionID: sourceSessionID },
    },
  });
  await bridge.event({
    event: {
      type: "session.idle",
      properties: { sessionID: sourceSessionID },
    },
  });

  await waitFor(() => promptCalls.length === 1 && captureRequests.length === 1 && deletedSessions.length === 1, name);

  assert.deepEqual(promptCalls[0].body.model, sourceModel, `${name}: capture must use source session model`);
  assert.equal(captureRequests[0].path, "/api/plugin/capture", `${name}: summary must be saved`);
  assert.equal(captureRequests[0].body.sessionID, sourceSessionID, `${name}: save must point to source session`);
  assert.deepEqual(deletedSessions, [captureSessionID], `${name}: temporary session must be cleaned up`);
  assert.equal(createCalls, 1, `${name}: duplicate idle events must not create concurrent capture sessions`);
  assert.ok(
    logs.some((entry) => entry.level === "info" && entry.message.includes("deepseek/deepseek-v4-flash")),
    `${name}: inherited model must be logged`
  );
  assert.ok(
    logs.some((entry) => entry.level === "info" && entry.message.includes("bridge loaded")),
    `${name}: plugin startup must be observable`
  );
  assert.ok(
    logs.some((entry) => entry.level === "info" && entry.message.includes("Automatic capture saved")),
    `${name}: successful persistence must be observable`
  );

  await bridge.event({
    event: {
      type: "session.idle",
      properties: { sessionID: sourceSessionID },
    },
  });
  await waitFor(
    () => logs.some((entry) => entry.level === "info" && entry.message.includes("transcript is unchanged")),
    `${name}: unchanged transcript skip`
  );
  assert.equal(createCalls, 1, `${name}: unchanged transcript must not be captured twice`);
}

async function runChatMessageModelFallbackCase() {
  const promptCalls = [];
  const captureRequests = [];
  activeCaptureRequests = captureRequests;
  activeTagMigrationCompletions = [];
  activeTagMigrationFailures = [];
  activeTagMigrationStatusRequests = [];
  nextTagMigrationClaim = null;
  tagMigrationStatus = { pending: 0, active: 0, deferred: 0, nextAttemptAt: null, lastError: null };
  const logs = [];

  const client = {
    session: {
      async messages({ path }) {
        if (path.id === sourceSessionID) {
          return {
            data: [
              {
                info: { role: "user" },
                parts: [{ type: "text", text: "Remember the model selected by the chat.message hook." }],
              },
            ],
          };
        }
        if (path.id === captureSessionID) {
          return {
            data: [
              {
                info: { role: "assistant", ...sourceModel },
                parts: [{ type: "text", text: "## Outcome\nSaved using the cached source model." }],
              },
            ],
          };
        }
        throw new Error(`Unexpected session lookup: ${path.id}`);
      },
      async get({ path }) {
        return {
          data: {
            id: path.id,
            title: path.id === captureSessionID ? "OpenCode Memory Auto Capture" : "Source session",
          },
        };
      },
      async create() {
        return { data: { id: captureSessionID } };
      },
      async prompt(request) {
        promptCalls.push(request);
        return { data: {} };
      },
      async delete() {},
    },
    app: {
      async log({ body }) {
        logs.push(body);
      },
    },
  };

  const bridgeUrl = pathToFileURL(resolve("artifacts/plugin/opencode-mem.js"));
  bridgeUrl.searchParams.set("test", `chat-message-model-${Date.now()}`);
  const { OpenCodeMemoryBridge } = await import(bridgeUrl.href);
  const bridge = await OpenCodeMemoryBridge({ directory: "C:/test/project", client });

  await bridge["chat.message"](
    { sessionID: sourceSessionID, model: sourceModel },
    { message: { id: "message-id" }, parts: [] }
  );
  await bridge.event({
    event: {
      type: "session.idle",
      properties: { sessionID: sourceSessionID },
    },
  });

  await waitFor(() => promptCalls.length === 1 && captureRequests.length === 1, "chat.message model fallback");
  assert.deepEqual(promptCalls[0].body.model, sourceModel, "chat.message model metadata must be inherited");
  assert.ok(
    logs.some((entry) => entry.message.includes("deepseek/deepseek-v4-flash")),
    "chat.message model fallback must be logged"
  );
}

async function runMissingModelCase() {
  let createCalls = 0;
  let promptCalls = 0;
  const logs = [];

  const client = {
    session: {
      async messages() {
        return {
          data: [
            {
              info: { role: "assistant", summary: true, providerID: "ikunopencode", modelID: "claude-opus-4-8" },
              parts: [{ type: "text", text: "Compaction summary that must not select the capture model." }],
            },
          ],
        };
      },
      async create() {
        createCalls++;
        return { data: { id: captureSessionID } };
      },
      async prompt() {
        promptCalls++;
      },
    },
    app: {
      async log({ body }) {
        logs.push(body);
      },
    },
  };

  const bridgeUrl = pathToFileURL(resolve("artifacts/plugin/opencode-mem.js"));
  bridgeUrl.searchParams.set("test", `missing-model-${Date.now()}`);
  const { OpenCodeMemoryBridge } = await import(bridgeUrl.href);
  const bridge = await OpenCodeMemoryBridge({ directory: "C:/test/project", client });

  await bridge.event({
    event: {
      type: "session.idle",
      properties: { sessionID: sourceSessionID },
    },
  });

  await waitFor(
    () => logs.some((entry) => entry.level === "warn" && entry.message.includes("source session model could not be determined")),
    "missing-model warning"
  );

  assert.equal(createCalls, 0, "missing-model: no capture session may be created");
  assert.equal(promptCalls, 0, "missing-model: OpenCode default model must never be invoked");
}

async function runAutomaticTagMigrationCase() {
  const promptCalls = [];
  const captureRequests = [];
  const deletedSessions = [];
  const logs = [];
  activeCaptureRequests = captureRequests;
  activeTagMigrationCompletions = [];
  activeTagMigrationFailures = [];
  activeTagMigrationStatusRequests = [];
  nextTagMigrationClaim = {
    claimId: "legacy-tag-claim",
    memoryId: "legacy-memory",
    content: "Implemented a retryable DeepSeek authentication fix in the Windows bridge.",
    remaining: 1,
  };
  tagMigrationStatus = { pending: 1, active: 0, deferred: 0, nextAttemptAt: null, lastError: null };
  let createCalls = 0;

  const client = {
    session: {
      async messages({ path }) {
        if (path.id === sourceSessionID) {
          return {
            data: [
              {
                info: { role: "user", model: sourceModel },
                parts: [{ type: "text", text: "Please repair automatic memory tagging." }],
              },
              {
                info: { role: "assistant", ...sourceModel },
                parts: [{ type: "text", text: "The migration queue is now automatic." }],
              },
            ],
          };
        }
        if (path.id === captureSessionID) {
          return {
            data: [
              {
                info: { role: "assistant", ...sourceModel },
                parts: [{ type: "text", text: "## Outcome\nAutomatic tagging migration was enabled." }],
              },
            ],
          };
        }
        if (path.id === tagMigrationSessionID) {
          return {
            data: [
              {
                info: { role: "assistant", ...sourceModel },
                parts: [{ type: "text", text: '{"tags":["deepseek","authentication","windows-bridge"]}' }],
              },
            ],
          };
        }
        throw new Error(`Unexpected session lookup: ${path.id}`);
      },
      async get({ path }) {
        return {
          data: {
            id: path.id,
            title:
              path.id === captureSessionID
                ? "OpenCode Memory Auto Capture"
                : path.id === tagMigrationSessionID
                  ? "OpenCode Memory Tag Migration"
                  : "Source session",
          },
        };
      },
      async create() {
        createCalls++;
        return { data: { id: createCalls === 1 ? captureSessionID : tagMigrationSessionID } };
      },
      async prompt(request) {
        promptCalls.push(request);
        return { data: {} };
      },
      async delete({ path }) {
        deletedSessions.push(path.id);
      },
    },
    app: {
      async log({ body }) {
        logs.push(body);
      },
    },
  };

  const bridgeUrl = pathToFileURL(resolve("artifacts/plugin/opencode-mem.js"));
  bridgeUrl.searchParams.set("test", `automatic-tag-migration-${Date.now()}`);
  const { OpenCodeMemoryBridge } = await import(bridgeUrl.href);
  const bridge = await OpenCodeMemoryBridge({ directory: "C:/test/project", client });

  await bridge.event({
    event: {
      type: "session.idle",
      properties: { sessionID: sourceSessionID },
    },
  });

  await waitFor(
    () =>
      promptCalls.length === 2 &&
      captureRequests.length === 1 &&
      activeTagMigrationCompletions.length === 1 &&
      deletedSessions.length === 2 &&
      activeTagMigrationStatusRequests.length === 1,
    "automatic tag migration"
  );

  assert.deepEqual(promptCalls[0].body.model, sourceModel, "capture must use the source session model");
  assert.deepEqual(promptCalls[1].body.model, sourceModel, "tag migration must inherit the source session model");
  assert.match(
    promptCalls[1].body.parts[0].text,
    /Return only JSON/i,
    "tag migration must ask for structured tags"
  );
  assert.deepEqual(activeTagMigrationCompletions[0].body.tags, [
    "deepseek",
    "authentication",
    "windows-bridge",
  ]);
  assert.equal(activeTagMigrationCompletions[0].body.claimId, "legacy-tag-claim");
  assert.equal(activeTagMigrationFailures.length, 0, "successful migration must not be released as failed");
  assert.equal(
    activeTagMigrationStatusRequests.length,
    1,
    "the queue must recheck status after an empty claim so deferred work is retried automatically"
  );
  assert.ok(
    logs.some((entry) => entry.message.includes("Automatic tag migration completed")),
    "successful background migration must be observable"
  );
}

async function runTagMigrationAfterCaptureFailureCase() {
  const promptCalls = [];
  const deletedSessions = [];
  const logs = [];
  activeCaptureRequests = [];
  activeTagMigrationCompletions = [];
  activeTagMigrationFailures = [];
  activeTagMigrationStatusRequests = [];
  nextTagMigrationClaim = {
    claimId: "capture-failure-tag-claim",
    memoryId: "legacy-memory-after-capture-failure",
    content: "Repair tags even when automatic memory capture cannot be saved.",
    remaining: 1,
  };
  tagMigrationStatus = { pending: 1, active: 0, deferred: 0, nextAttemptAt: null, lastError: null };
  let createCalls = 0;

  const client = {
    session: {
      async messages({ path }) {
        if (path.id === sourceSessionID) {
          return {
            data: [
              {
                info: { role: "assistant", ...sourceModel },
                parts: [{ type: "text", text: "The capture endpoint is currently unavailable." }],
              },
            ],
          };
        }
        if (path.id === tagMigrationSessionID) {
          return {
            data: [
              {
                info: { role: "assistant", ...sourceModel },
                parts: [{ type: "text", text: '{"tags":["background","migration"]}' }],
              },
            ],
          };
        }
        throw new Error(`Unexpected session lookup: ${path.id}`);
      },
      async get({ path }) {
        return {
          data: {
            id: path.id,
            title:
              path.id === captureSessionID
                ? "OpenCode Memory Auto Capture"
                : path.id === tagMigrationSessionID
                  ? "OpenCode Memory Tag Migration"
                  : "Source session",
          },
        };
      },
      async create() {
        createCalls++;
        return { data: { id: createCalls === 1 ? captureSessionID : tagMigrationSessionID } };
      },
      async prompt(request) {
        promptCalls.push(request);
        if (request.path.id === captureSessionID) {
          throw new Error("synthetic capture failure");
        }
        return { data: {} };
      },
      async delete({ path }) {
        deletedSessions.push(path.id);
      },
    },
    app: {
      async log({ body }) {
        logs.push(body);
      },
    },
  };

  const bridgeUrl = pathToFileURL(resolve("artifacts/plugin/opencode-mem.js"));
  bridgeUrl.searchParams.set("test", `tag-migration-after-capture-failure-${Date.now()}`);
  const { OpenCodeMemoryBridge } = await import(bridgeUrl.href);
  const bridge = await OpenCodeMemoryBridge({ directory: "C:/test/project", client });

  await bridge.event({
    event: {
      type: "session.idle",
      properties: { sessionID: sourceSessionID },
    },
  });

  await waitFor(
    () =>
      promptCalls.length === 2 &&
      activeTagMigrationCompletions.length === 1 &&
      deletedSessions.length === 2,
    "tag migration after capture failure"
  );

  assert.deepEqual(
    promptCalls[1].body.model,
    sourceModel,
    "tag migration must keep the triggering session model when capture fails"
  );
  assert.equal(activeCaptureRequests.length, 0, "failed capture must not fake a memory write");
  assert.ok(
    logs.some((entry) => entry.message.includes("Automatic capture failed")),
    "capture failure must remain observable"
  );
  assert.ok(
    logs.some((entry) => entry.message.includes("Automatic tag migration completed")),
    "tag migration must still continue after capture failure"
  );
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const body = JSON.parse(String(init.body || "{}"));
  if (url.pathname === "/api/plugin/context") {
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.pathname === "/api/plugin/capture") {
    activeCaptureRequests.push({ path: url.pathname, body });
    return new Response(JSON.stringify({ success: true, result: { success: true } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.pathname === "/api/migration/tags/claim") {
    const claim = nextTagMigrationClaim;
    nextTagMigrationClaim = null;
    tagMigrationStatus = {
      pending: claim ? 1 : 0,
      active: claim ? 1 : 0,
      deferred: 0,
      nextAttemptAt: null,
      lastError: null,
    };
    return new Response(JSON.stringify({ success: true, data: { claim } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.pathname === "/api/migration/tags/complete") {
    activeTagMigrationCompletions.push({ path: url.pathname, body });
    tagMigrationStatus = { pending: 0, active: 0, deferred: 0, nextAttemptAt: null, lastError: null };
    return new Response(JSON.stringify({ success: true, data: { memoryId: body.memoryId, tags: body.tags } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.pathname === "/api/migration/tags/fail") {
    activeTagMigrationFailures.push({ path: url.pathname, body });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.pathname === "/api/migration/tags/status") {
    activeTagMigrationStatusRequests.push({ path: url.pathname, body });
    return new Response(JSON.stringify({ success: true, data: tagMigrationStatus }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected bridge RPC during test: ${url.pathname}`);
};

try {
  await runCaptureCase("assistant-model", [
    {
      info: { role: "user", model: sourceModel },
      parts: [{ type: "text", text: "Please implement the memory capture fix." }],
    },
    {
      info: { role: "assistant", ...sourceModel },
      parts: [{ type: "text", text: "Implemented the bridge change." }],
    },
    {
      info: {
        role: "assistant",
        summary: true,
        mode: "compaction",
        providerID: "ikunopencode",
        modelID: "claude-opus-4-8",
      },
      parts: [{ type: "text", text: "Compaction summary using a different small model." }],
    },
  ]);

  await runCaptureCase("user-model-fallback", [
    {
      info: { role: "user", model: sourceModel },
      parts: [{ type: "text", text: "Please implement the memory capture fix." }],
    },
  ]);

  await runMissingModelCase();
  await runChatMessageModelFallbackCase();
  await runAutomaticTagMigrationCase();
  await runTagMigrationAfterCaptureFailureCase();

  console.log("Bridge model inheritance tests passed");
} finally {
  globalThis.fetch = originalFetch;
}
