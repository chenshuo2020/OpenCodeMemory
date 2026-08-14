import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const stagingRoot = join(root, "installer", "staging");
const serviceStage = join(stagingRoot, "service");
const serviceNodeModulesStage = join(serviceStage, "node_modules");
const wrapperStage = join(stagingRoot, "service-wrapper");
const rootNodeModules = join(root, "node_modules");

async function assertFile(path, message) {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`${message}: ${path}`);
  }
}

function productionPackagePaths() {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const args = npmCli
    ? [npmCli, "ls", "--omit=dev", "--parseable", "--all"]
    : ["ls", "--omit=dev", "--parseable", "--all"];
  const output = execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    ...(npmCli ? {} : { shell: process.platform === "win32" }),
  });
  return [...new Set(output.split(/\r?\n/).filter(Boolean))]
    .filter((path) => path !== root && path.startsWith(`${rootNodeModules}\\`))
    .sort((left, right) => left.length - right.length);
}

await assertFile(join(root, "dist", "standalone", "service-main.js"), "Build the standalone service first");
await assertFile(join(root, "dist", "web", "index.html"), "Build the web UI first");
await assertFile(join(root, "artifacts", "plugin", "opencode-mem.js"), "Build the OpenCode bridge first");
await assertFile(join(root, "artifacts", "model-cache", "opencode-mem-model-manifest.json"), "Fetch the embedding model first");
await assertFile(
  join(root, "installer", "install-root-marker.txt"),
  "The installer root marker is missing"
);
await assertFile(join(root, "installer", "runtime", "node.exe"), "Fetch the bundled Node.js runtime first");
await assertFile(
  join(root, "installer", "runtime", "OpenCodeMemoryServiceHost.exe"),
  "Build the windowless background service host first"
);
await assertFile(
  join(root, "node_modules", "onnxruntime-node", "bin", "napi-v3", "win32", "x64", "onnxruntime_binding.node"),
  "The Windows x64 ONNX runtime binding is missing"
);

await rm(stagingRoot, { recursive: true, force: true });
await mkdir(serviceStage, { recursive: true });
await cp(join(root, "dist"), join(serviceStage, "dist"), { recursive: true });
await writeFile(
  join(serviceStage, "package.json"),
  `${JSON.stringify({ name: "opencode-memory-service", private: true, type: "module", version: packageJson.version }, null, 2)}\n`
);

for (const source of productionPackagePaths()) {
  const packagePath = relative(rootNodeModules, source);
  await cp(source, join(serviceNodeModulesStage, packagePath), {
    recursive: true,
    dereference: true,
    force: true,
  });
}

await assertFile(
  join(serviceNodeModulesStage, "onnxruntime-node", "bin", "napi-v3", "win32", "x64", "onnxruntime_binding.node"),
  "Staged Windows x64 ONNX runtime binding is missing"
);

await mkdir(wrapperStage, { recursive: true });
for (const file of [
  "OpenCodeMemoryService.mjs",
  "OpenCodeMemoryService.ps1",
  "register-background-task.ps1",
  "remove-background-task.ps1",
]) {
  const source = join(root, "installer", "service", file);
  const target = join(wrapperStage, file);
  if (file === "OpenCodeMemoryService.ps1" || file === "OpenCodeMemoryService.mjs") {
    const content = await readFile(source, "utf8");
    await writeFile(target, content.replaceAll("__APP_VERSION__", packageJson.version), "utf8");
  } else {
    await cp(source, target);
  }
}

console.log("Installer resources prepared");
