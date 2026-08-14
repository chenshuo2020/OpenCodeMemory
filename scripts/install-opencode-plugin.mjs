import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const configDir = join(homedir(), ".config", "opencode");
const pluginDir = join(configDir, "plugins");
const source = join(root, "artifacts", "plugin", "opencode-mem.js");
const target = join(pluginDir, "opencode-mem.js");
const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const connectionDir = join(localAppData, "OpenCodeMemory");
const connectionPath = join(connectionDir, "connection.json");
const tokenFile = join(homedir(), ".opencode-mem", ".auth-token");

await mkdir(pluginDir, { recursive: true });
await mkdir(connectionDir, { recursive: true });
await copyFile(source, target);
await writeFile(
  connectionPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      managedBy: "OpenCodeMemoryDesktop",
      baseUrl: "http://127.0.0.1:4747",
      tokenFile,
    },
    null,
    2
  )}\n`
);

const opencodeConfigPath = join(configDir, "opencode.json");
try {
  const original = await readFile(opencodeConfigPath, "utf8");
  const backup = `${opencodeConfigPath}.opencode-memory-backup-${Date.now()}`;
  await writeFile(backup, original);
  const json = JSON.parse(stripJsonComments(original).replace(/,\s*([}\]])/g, "$1"));
  if (Array.isArray(json.plugin)) {
    json.plugin = json.plugin.filter((entry) => entry !== "opencode-mem");
    await writeFile(opencodeConfigPath, `${JSON.stringify(json, null, 2)}\n`);
  }
} catch {
  // OpenCode may not be installed yet. The global local plugin directory is
  // still enough for it to discover the bridge on the next startup.
}

console.log(`OpenCode bridge installed at ${target}`);
console.log(`Connection manifest written at ${connectionPath}`);

function stripJsonComments(value) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
