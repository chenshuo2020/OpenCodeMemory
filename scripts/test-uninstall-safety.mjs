import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd();
const markerValue = "OpenCodeMemory.InstallRoot.v1";
const removalScript = resolve(root, "installer", "service", "remove-background-task.ps1");
const installerInclude = await readFile(resolve(root, "installer", "installer.nsh"), "utf8");
const removalSource = await readFile(removalScript, "utf8");
const desktopPackage = JSON.parse(await readFile(resolve(root, "desktop", "package.json"), "utf8"));
const sandbox = await mkdtemp(join(tmpdir(), "opencode-memory-uninstall-safety-"));

async function makeInstallCase(name, options = {}) {
  const caseRoot = join(sandbox, name);
  const installRoot = join(caseRoot, options.directoryName || "OpenCode Memory");
  await mkdir(installRoot, { recursive: true });
  if (options.app !== false) await writeFile(join(installRoot, "OpenCode Memory.exe"), "test");
  if (options.uninstaller !== false) {
    await writeFile(join(installRoot, "Uninstall OpenCode Memory.exe"), "test");
  }
  if (options.marker !== false) {
    await writeFile(
      join(installRoot, ".opencode-memory-install-root"),
      `${options.markerValue || markerValue}\n`
    );
  }
  return installRoot;
}

function validate(installRoot) {
  return spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      removalScript,
      "-InstallDir",
      installRoot,
      "-ValidateOnly",
    ],
    { encoding: "utf8", windowsHide: true }
  );
}

try {
  const siblingDirectory = join(sandbox, "Sibling Application");
  const siblingSentinel = join(siblingDirectory, "must-remain.txt");
  await mkdir(siblingDirectory, { recursive: true });
  await writeFile(siblingSentinel, "do not delete");

  const validRoot = await makeInstallCase("valid");
  assert.equal(validate(validRoot).status, 0, "a verified dedicated install root must pass");

  const linkedRoot = await makeInstallCase("linked-root-target");
  const linkedRootParent = join(sandbox, "linked-root-parent");
  const linkedInstallRoot = join(linkedRootParent, "OpenCode Memory");
  await mkdir(linkedRootParent, { recursive: true });
  await symlink(linkedRoot, linkedInstallRoot, "junction");
  assert.notEqual(validate(linkedInstallRoot).status, 0, "a junction install root must fail closed");

  const internalLinkRoot = await makeInstallCase("internal-link");
  await symlink(siblingDirectory, join(internalLinkRoot, "linked-sibling"), "junction");
  assert.notEqual(validate(internalLinkRoot).status, 0, "an internal junction must fail closed");

  for (const [name, options] of [
    ["wrong-directory", { directoryName: "Other Software" }],
    ["missing-marker", { marker: false }],
    ["wrong-marker", { markerValue: "SomeOtherProduct.InstallRoot.v1" }],
    ["missing-app", { app: false }],
    ["missing-uninstaller", { uninstaller: false }],
  ]) {
    const invalidRoot = await makeInstallCase(name, options);
    const result = validate(invalidRoot);
    assert.notEqual(result.status, 0, `${name} must fail closed`);
  }

  assert.equal((await readFile(siblingSentinel, "utf8")), "do not delete");
  assert.equal((await stat(siblingDirectory)).isDirectory(), true);

  assert.match(installerInclude, /OcmEnsureDedicatedInstallDirectory/);
  assert.match(installerInclude, /GetFileAttributesW/);
  assert.match(installerInclude, /OcmValidateInstallRoot/);
  assert.match(installerInclude, /ReadRegStr \$R5 SHELL_CONTEXT "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation/);
  assert.match(installerInclude, /customUnInit/);
  assert.match(installerInclude, /-InstallDir \"\$INSTDIR\"/);
  assert.doesNotMatch(installerInclude, /RMDir\s+\/r\s+\"?\$INSTDIR\\\.\.?/i);

  const removeItemLines = removalSource
    .split(/\r?\n/)
    .filter((line) => /\bRemove-Item\b/.test(line));
  assert.deepEqual(removeItemLines.map((line) => line.trim()), [
    "Remove-Item -LiteralPath $pluginPath -Force",
    "Remove-Item -LiteralPath $connectionPath -Force",
    "Remove-Item -LiteralPath $connectionDirectory -Force",
  ]);
  assert.match(removalSource, /Assert-ManagedTask/);
  assert.match(removalSource, /HashSet\[string\]/);
  assert.match(removalSource, /ReparsePoint/);
  assert.match(removalSource, /Get-FileHash -Algorithm SHA256/);
  assert.doesNotMatch(removalSource, /Remove-Item[^\r\n]*(?:InstallDir|installRoot|\.\.)/i);

  assert.equal(desktopPackage.build.nsis.deleteAppDataOnUninstall, true);
  assert.deepEqual(desktopPackage.build.extraFiles, [
    {
      from: "../installer/install-root-marker.txt",
      to: ".opencode-memory-install-root",
    },
  ]);

  console.log("Uninstall path-boundary and ownership tests passed");
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
