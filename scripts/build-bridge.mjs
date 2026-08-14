import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("artifacts/plugin", { recursive: true });
await build({
  entryPoints: ["bridge/src/opencode-mem.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  outfile: "artifacts/plugin/opencode-mem.js",
  sourcemap: false,
  external: ["node:*"],
  banner: { js: "// Managed by OpenCode Memory desktop app.\n" },
  legalComments: "eof",
});
console.log("OpenCode bridge written to artifacts/plugin/opencode-mem.js");
