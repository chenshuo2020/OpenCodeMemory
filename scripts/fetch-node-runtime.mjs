import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const version = process.env.OPENCODE_MEM_NODE_VERSION || "v22.15.0";
if (!/^v\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Invalid Node.js version: ${version}`);
}
if (process.platform !== "win32") {
  throw new Error("The bundled runtime is only prepared on Windows hosts.");
}

const archiveName = `node-${version}-win-x64.zip`;
const baseUrl = `https://nodejs.org/dist/${version}`;
const runtimeDir = join(process.cwd(), "installer", "runtime");
const nodePath = join(runtimeDir, "node.exe");
const tempDir = await mkdtemp(join(tmpdir(), "opencode-memory-node-"));

try {
  const [checksumsResponse, archiveResponse] = await Promise.all([
    fetch(`${baseUrl}/SHASUMS256.txt`),
    fetch(`${baseUrl}/${archiveName}`),
  ]);
  if (!checksumsResponse.ok) {
    throw new Error(`Unable to fetch Node.js checksums: HTTP ${checksumsResponse.status}`);
  }
  if (!archiveResponse.ok) {
    throw new Error(`Unable to fetch Node.js runtime: HTTP ${archiveResponse.status}`);
  }

  const checksumLine = (await checksumsResponse.text())
    .split(/\r?\n/)
    .find((line) => line.endsWith(`  ${archiveName}`));
  if (!checksumLine) {
    throw new Error(`No checksum entry found for ${archiveName}`);
  }
  const expectedHash = checksumLine.split(/\s+/)[0];
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  const actualHash = createHash("sha256").update(archive).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(`Node.js checksum mismatch for ${archiveName}`);
  }

  const archivePath = join(tempDir, archiveName);
  await writeFile(archivePath, archive);
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${tempDir.replaceAll("'", "''")}' -Force`,
  ]);

  const extractedRoot = join(tempDir, `node-${version}-win-x64`);
  const extractedNode = join(extractedRoot, "node.exe");
  try {
    await readFile(extractedNode);
  } catch {
    throw new Error(`Downloaded Node.js archive did not contain ${extractedNode}`);
  }

  await rm(runtimeDir, { recursive: true, force: true });
  await mkdir(runtimeDir, { recursive: true });
  await cp(extractedRoot, runtimeDir, { recursive: true });
  await writeFile(
    join(runtimeDir, "opencode-memory-node-runtime.json"),
    `${JSON.stringify({ version, archiveName, sha256: actualHash }, null, 2)}\n`
  );
  console.log(`Bundled Node.js ${version} at ${nodePath}`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
