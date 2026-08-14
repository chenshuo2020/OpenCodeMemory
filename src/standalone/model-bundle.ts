import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type ModelBundleManifest = {
  schemaVersion: 1;
  model: string;
  revision?: string;
  dtype?: string;
  dimensions: number;
  files: Record<string, string>;
};

export type ModelBundleStatus = {
  required: boolean;
  present: boolean;
  valid: boolean;
  root: string;
  model: string;
  dimensions: number;
  error: string | null;
};

export function getModelBundleRoot(): string {
  return process.env.OPENCODE_MEM_MODEL_BUNDLE || process.env.OPENCODE_MEM_MODEL_CACHE || "";
}

export function getModelBundleStatus(options: {
  model: string;
  dimensions: number;
}): ModelBundleStatus {
  const root = getModelBundleRoot();
  const required = process.env.OPENCODE_MEM_REQUIRE_BUNDLED_MODEL === "1";
  if (!root) {
    return {
      required,
      present: false,
      valid: !required,
      root: "",
      model: options.model,
      dimensions: options.dimensions,
      error: required ? "Bundled model path is not configured" : null,
    };
  }

  const manifestPath = join(root, "opencode-mem-model-manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      required,
      present: false,
      valid: !required,
      root,
      model: options.model,
      dimensions: options.dimensions,
      error: required ? `Model manifest not found: ${manifestPath}` : null,
    };
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ModelBundleManifest;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.model !== options.model ||
      manifest.dimensions !== options.dimensions ||
      (process.env.OPENCODE_MEM_MODEL_REVISION &&
        manifest.revision !== process.env.OPENCODE_MEM_MODEL_REVISION) ||
      (process.env.OPENCODE_MEM_MODEL_DTYPE &&
        manifest.dtype !== process.env.OPENCODE_MEM_MODEL_DTYPE)
    ) {
      throw new Error(
        `Model manifest mismatch: expected ${options.model}/${options.dimensions}/${process.env.OPENCODE_MEM_MODEL_REVISION || "any-revision"}/${process.env.OPENCODE_MEM_MODEL_DTYPE || "any-dtype"}, got ${manifest.model}/${manifest.dimensions}/${manifest.revision || "unknown"}/${manifest.dtype || "unknown"}`
      );
    }

    for (const [file, expectedHash] of Object.entries(manifest.files)) {
      const filePath = join(root, file);
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        throw new Error(`Bundled model file is missing: ${file}`);
      }
      const actualHash = createHash("sha256").update(readFileSync(filePath)).digest("hex");
      if (actualHash !== expectedHash) {
        throw new Error(`Bundled model checksum mismatch: ${file}`);
      }
    }

    return {
      required,
      present: true,
      valid: true,
      root,
      model: options.model,
      dimensions: options.dimensions,
      error: null,
    };
  } catch (error) {
    return {
      required,
      present: true,
      valid: false,
      root,
      model: options.model,
      dimensions: options.dimensions,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
