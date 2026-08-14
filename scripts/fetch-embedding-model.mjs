import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { env, pipeline } from "@huggingface/transformers";

const model = process.env.OPENCODE_MEM_MODEL || "Xenova/nomic-embed-text-v1";
const dimensions = Number(process.env.OPENCODE_MEM_MODEL_DIMENSIONS || 768);
const outputDir = process.env.OPENCODE_MEM_MODEL_OUTPUT || join(process.cwd(), "artifacts", "model-cache");
const revision = process.env.OPENCODE_MEM_MODEL_REVISION || "2f98ed5b9768f159d9cc55782f2e867abbc8d6ac";
const dtype = process.env.OPENCODE_MEM_MODEL_DTYPE || "q8";
const sourceDir = process.env.OPENCODE_MEM_MODEL_SOURCE_DIR;
const remoteHosts = (process.env.OPENCODE_MEM_MODEL_REMOTE_HOSTS || "https://huggingface.co/,https://hf.co/")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => (value.endsWith("/") ? value : `${value}/`));

const manifestPath = join(outputDir, "opencode-mem-model-manifest.json");
if (!existsSync(manifestPath)) {
  // A previous interrupted download is not a usable release artifact. Starting
  // from a clean cache prevents a large fp32 partial file from being mistaken
  // for the q8 bundle that the Windows product ships.
  rmSync(outputDir, { recursive: true, force: true });
}
mkdirSync(outputDir, { recursive: true });
env.cacheDir = outputDir;
env.localModelPath = outputDir;
env.allowLocalModels = true;
env.allowRemoteModels = !sourceDir;

console.log(`Downloading and validating ${model} into ${outputDir}`);
let extractor;
let remoteHostUsed;
if (sourceDir) {
  console.log(`Using local model source: ${sourceDir}`);
  const requiredFiles = [
    "config.json",
    "quantize_config.json",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.txt",
    "onnx/model_quantized.onnx",
  ];
  for (const file of requiredFiles) {
    const source = join(sourceDir, file.replace("onnx/", ""));
    if (!existsSync(source)) throw new Error(`Local model source is missing ${file}: ${source}`);
    const target = join(outputDir, model, file);
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(source, target);
  }
  extractor = await pipeline("feature-extraction", model, {
    revision,
    dtype,
    local_files_only: true,
  });
  remoteHostUsed = `local-source:${sourceDir}`;
} else {
  const failures = [];
  for (const remoteHost of remoteHosts) {
    try {
      console.log(`Trying model host: ${remoteHost}`);
      env.remoteHost = remoteHost;
      extractor = await pipeline("feature-extraction", model, { revision, dtype });
      remoteHostUsed = remoteHost;
      break;
    } catch (error) {
      failures.push(`${remoteHost}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!extractor) {
    throw new Error(`Unable to download ${model} from the configured model endpoints. ${failures.join(" | ")}`);
  }
}
const result = await extractor("OpenCode Memory model preflight", { pooling: "mean", normalize: true });
if (!result?.data || result.data.length !== dimensions) {
  throw new Error(`Expected ${dimensions} dimensions, got ${result?.data?.length ?? 0}`);
}

const files = {};
function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const filePath = join(dir, entry.name);
    if (entry.isDirectory()) visit(filePath);
    else if (entry.isFile() && entry.name !== "opencode-mem-model-manifest.json") {
      const rel = relative(outputDir, filePath).replaceAll("\\", "/");
      files[rel] = createHash("sha256").update(readFileSync(filePath)).digest("hex");
    }
  }
}
visit(outputDir);

const expectedQuantizedModelHash = "b7941066a6529a287e2502ea6cb68ff82006d311eac53627dc88c259cbcbda64";
const quantizedModelPath = Object.keys(files).find((file) => file.endsWith("onnx/model_quantized.onnx"));
if (!quantizedModelPath) {
  throw new Error("The downloaded bundle does not contain onnx/model_quantized.onnx");
}
if (files[quantizedModelPath] !== expectedQuantizedModelHash) {
  throw new Error(
    `Embedding model checksum mismatch for ${quantizedModelPath}: expected ${expectedQuantizedModelHash}, got ${files[quantizedModelPath]}`
  );
}

const manifest = {
  schemaVersion: 1,
  model,
  revision,
  dtype,
  dimensions,
  sourceHost: remoteHostUsed,
  files,
  generatedAt: new Date().toISOString(),
};
writeFileSync(join(outputDir, "opencode-mem-model-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Model ready: ${Object.keys(files).length} files, ${result.data.length} dimensions`);
