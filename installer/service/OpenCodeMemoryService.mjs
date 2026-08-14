import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const wrapperDirectory = dirname(fileURLToPath(import.meta.url));
const installRoot = resolve(wrapperDirectory, "..");
const serviceDirectory = join(installRoot, "service");
const entryPoint = join(serviceDirectory, "dist", "standalone", "service-main.js");
const modelDirectory = join(installRoot, "models");

if (!existsSync(entryPoint)) {
  throw new Error(`Standalone service entry point not found: ${entryPoint}`);
}
if (!existsSync(modelDirectory)) {
  throw new Error(`Bundled embedding model not found: ${modelDirectory}`);
}

process.env.OPENCODE_MEM_HOST = "127.0.0.1";
process.env.OPENCODE_MEM_PORT = "4747";
process.env.OPENCODE_MEM_VERSION = "__APP_VERSION__";
process.env.OPENCODE_MEM_MODEL_BUNDLE = modelDirectory;
process.env.OPENCODE_MEM_MODEL_CACHE = modelDirectory;
process.env.OPENCODE_MEM_REQUIRE_BUNDLED_MODEL = "1";
process.env.OPENCODE_MEM_BUNDLED_MODEL = "Xenova/nomic-embed-text-v1";
process.env.OPENCODE_MEM_BUNDLED_MODEL_DIMENSIONS = "768";
process.env.OPENCODE_MEM_MODEL_REVISION = "2f98ed5b9768f159d9cc55782f2e867abbc8d6ac";
process.env.OPENCODE_MEM_MODEL_DTYPE = "q8";
process.env.NODE_PATH = join(serviceDirectory, "node_modules");

process.chdir(serviceDirectory);
await import(pathToFileURL(entryPoint).href);
