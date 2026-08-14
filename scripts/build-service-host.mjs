import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const source = join(root, "installer", "service-host", "main.go");
const outputDirectory = join(root, "installer", "runtime");
const output = join(outputDirectory, "OpenCodeMemoryServiceHost.exe");

await mkdir(outputDirectory, { recursive: true });
await execFileAsync(
  "go",
  ["build", "-trimpath", "-ldflags=-s -w -H=windowsgui", "-o", output, source],
  {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      CGO_ENABLED: "0",
      GOOS: "windows",
      GOARCH: "amd64",
    },
  }
);

const executable = await readFile(output);
if (executable.toString("ascii", 0, 2) !== "MZ") {
  throw new Error(`Service host is not a Windows executable: ${output}`);
}
const peOffset = executable.readUInt32LE(0x3c);
if (executable.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
  throw new Error(`Service host has an invalid PE signature: ${output}`);
}
const machine = executable.readUInt16LE(peOffset + 4);
const optionalHeader = peOffset + 24;
const subsystem = executable.readUInt16LE(optionalHeader + 0x44);
if (machine !== 0x8664 || subsystem !== 2) {
  throw new Error(
    `Service host must be Windows x64 GUI (machine=0x${machine.toString(16)}, subsystem=${subsystem})`
  );
}

console.log(`Windowless Windows x64 service host written to ${output}`);
