import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const resources = join(root, "desktop", "dist", "win-unpacked", "resources");
const serviceRoot = join(resources, "service");
const nodeBinary = join(resources, "runtime", "node.exe");
const serviceEntry = join(serviceRoot, "dist", "standalone", "service-main.js");
const auditRoot = join(root, "artifacts", "status-envelope-audit-20260812-v2");
const profileRoot = join(auditRoot, "profile");
const stdoutPath = join(auditRoot, "stdout.log");
const stderrPath = join(auditRoot, "stderr.log");
const port = 4760;

await rm(auditRoot, { recursive: true, force: true });
await mkdir(profileRoot, { recursive: true });

const env = {
  ...process.env,
  USERPROFILE: profileRoot,
  HOME: profileRoot,
  LOCALAPPDATA: join(profileRoot, "AppData", "Local"),
  APPDATA: join(profileRoot, "AppData", "Roaming"),
  OPENCODE_MEM_PROJECT_ROOT: serviceRoot,
  OPENCODE_MEM_SERVICE: "1",
  OPENCODE_MEM_HOST: "127.0.0.1",
  OPENCODE_MEM_PORT: String(port),
  OPENCODE_MEM_VERSION: "1.0.1-audit",
  OPENCODE_MEM_MODEL_BUNDLE: join(resources, "models"),
  OPENCODE_MEM_MODEL_CACHE: join(resources, "models"),
  OPENCODE_MEM_REQUIRE_BUNDLED_MODEL: "1",
  OPENCODE_MEM_BUNDLED_MODEL: "Xenova/nomic-embed-text-v1",
  OPENCODE_MEM_BUNDLED_MODEL_DIMENSIONS: "768",
  OPENCODE_MEM_MODEL_REVISION: "2f98ed5b9768f159d9cc55782f2e867abbc8d6ac",
  OPENCODE_MEM_MODEL_DTYPE: "q8",
  NODE_PATH: join(serviceRoot, "node_modules"),
};

const child = spawn(nodeBinary, [serviceEntry], {
  cwd: serviceRoot,
  env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});

const stdout = [];
const stderr = [];
child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

let token;
try {
  let health;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      health = await request("/api/health");
      if (health.status === "ok") break;
    } catch {
      await sleep(400);
    }
  }
  if (!health || health.status !== "ok") {
    throw new Error(`isolated service did not become healthy\n${stderr.join("")}`);
  }

  token = (await readFile(join(profileRoot, ".opencode-mem", ".auth-token"), "utf8")).trim();
  const headers = { "x-opencode-mem-token": token };
  const system = await request("/api/system/status", { headers });
  const model = await request("/api/model/status", { headers });
  const selfTest = await request("/api/model/self-test", { method: "POST", headers });

  const result = {
    health,
    systemHasDataStatus: Boolean(system.data?.status),
    systemLifecycle: system.data?.status?.lifecycle,
    systemEmbeddingReady: system.data?.status?.embedding?.ready,
    modelHasDataStatus: Boolean(model.data?.status),
    modelReady: model.data?.status?.ready,
    selfTestHasDataResult: Boolean(selfTest.data?.result),
    dimensions: selfTest.data?.result?.dimensions,
    finite: selfTest.data?.result?.finite,
    bundleValid: selfTest.data?.status?.bundle?.valid,
  };
  console.log(JSON.stringify(result, null, 2));

  if (!result.systemHasDataStatus || result.systemLifecycle !== "ready") throw new Error("system status envelope failed");
  if (!result.systemEmbeddingReady || !result.modelHasDataStatus || !result.modelReady) throw new Error("model status failed");
  if (!result.selfTestHasDataResult || result.dimensions !== 768 || !result.finite || !result.bundleValid) {
    throw new Error("bundled model self-test failed");
  }
} finally {
  if (token) {
    try {
      await request("/api/service/shutdown", {
        method: "POST",
        headers: { "x-opencode-mem-token": token },
      });
    } catch {}
  }
  const exit = new Promise((resolve) => child.once("exit", resolve));
  await Promise.race([exit, sleep(5000)]);
  if (!child.killed && child.exitCode === null) child.kill();
  await rm(auditRoot, { recursive: true, force: true });
}
