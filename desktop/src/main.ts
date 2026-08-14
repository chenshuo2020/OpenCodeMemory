import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const TASK_NAME = "OpenCodeMemoryService";
const SERVICE_HOST = process.env.OPENCODE_MEM_HOST || "127.0.0.1";
const SERVICE_PORT = Number(process.env.OPENCODE_MEM_PORT || 4747);
const SERVICE_URL = `http://${SERVICE_HOST}:${SERVICE_PORT}`;
let mainWindow: BrowserWindow | null = null;
let developmentService: ChildProcess | null = null;
let taskRegistrationAttempted = false;
let taskRegistrationError: string | null = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

type CommandResult = { success: boolean; output: string };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] || character;
  });
}

function statusPage(title: string, message: string, detail?: string): string {
  const detailMarkup = detail ? `<pre>${escapeHtml(detail)}</pre>` : "";
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OpenCode Memory</title>
    <style>
      :root { color-scheme: dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
      body { margin: 0; background: #111827; color: #f9fafb; }
      main { display: grid; min-height: 100vh; place-items: center; padding: 32px; box-sizing: border-box; }
      section { width: min(600px, 100%); }
      h1 { margin: 0 0 12px; font-size: 26px; font-weight: 600; }
      p { margin: 0; color: #d1d5db; font-size: 15px; line-height: 1.6; }
      pre { margin: 20px 0 0; padding: 14px; overflow: auto; background: #1f2937; color: #e5e7eb; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; }
    </style>
  </head>
  <body><main><section><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${detailMarkup}</section></main></body>
</html>`;
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
}

function isCurrentWindow(window: BrowserWindow): boolean {
  return mainWindow === window && !window.isDestroyed();
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function projectRoot(): string {
  return app.isPackaged ? process.resourcesPath : join(process.cwd(), "..");
}

function bundledModelPath(): string | undefined {
  return app.isPackaged
    ? join(process.resourcesPath, "models")
    : process.env.OPENCODE_MEM_MODEL_BUNDLE;
}

function bridgeSourcePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "plugin", "opencode-mem.js")
    : join(projectRoot(), "artifacts", "plugin", "opencode-mem.js");
}

function taskRegistrationScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "service-wrapper", "register-background-task.ps1")
    : join(projectRoot(), "installer", "service", "register-background-task.ps1");
}

function serviceCommand(): { file: string; args: string[]; cwd: string } {
  const explicit = process.env.OPENCODE_MEM_SERVICE_COMMAND;
  if (explicit) return { file: explicit, args: [], cwd: process.cwd() };

  return {
    file: process.env.NODE_BINARY || "node",
    args: [join(projectRoot(), "dist", "standalone", "service-main.js")],
    cwd: projectRoot(),
  };
}

function runCommand(file: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.once("close", (code) => resolve({ success: code === 0, output: stdout || stderr }));
    child.once("error", (error) => resolve({ success: false, output: String(error) }));
  });
}

async function isServiceHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${SERVICE_URL}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function startDevelopmentService(): void {
  if (developmentService && !developmentService.killed) return;
  const command = serviceCommand();
  developmentService = spawn(command.file, command.args, {
    cwd: command.cwd,
    detached: false,
    windowsHide: true,
    env: {
      ...process.env,
      OPENCODE_MEM_HOST: SERVICE_HOST,
      OPENCODE_MEM_PORT: String(SERVICE_PORT),
      OPENCODE_MEM_VERSION: app.getVersion(),
      ...(bundledModelPath()
        ? {
            OPENCODE_MEM_MODEL_BUNDLE: bundledModelPath(),
            OPENCODE_MEM_MODEL_CACHE: bundledModelPath(),
            OPENCODE_MEM_REQUIRE_BUNDLED_MODEL: "1",
            OPENCODE_MEM_MODEL_REVISION:
              process.env.OPENCODE_MEM_MODEL_REVISION || "2f98ed5b9768f159d9cc55782f2e867abbc8d6ac",
            OPENCODE_MEM_MODEL_DTYPE: process.env.OPENCODE_MEM_MODEL_DTYPE || "q8",
          }
        : {}),
    },
    stdio: "ignore",
  });
  developmentService.once("exit", () => {
    developmentService = null;
  });
}

async function waitForService(timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServiceHealthy()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function installOpenCodeBridge(): Promise<void> {
  const source = bridgeSourcePath();
  if (!existsSync(source)) {
    throw new Error(`OpenCode bridge was not found: ${source}`);
  }

  const configDir = join(homedir(), ".config", "opencode");
  const pluginDir = join(configDir, "plugins");
  const target = join(pluginDir, "opencode-mem.js");
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const connectionDir = join(localAppData, "OpenCodeMemory");
  const connectionPath = join(connectionDir, "connection.json");

  await mkdir(pluginDir, { recursive: true });
  await mkdir(connectionDir, { recursive: true });
  await copyFile(source, target);
  await writeFile(
    connectionPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        managedBy: "OpenCodeMemoryDesktop",
        baseUrl: SERVICE_URL,
        tokenFile: join(homedir(), ".opencode-mem", ".auth-token"),
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function registerCurrentUserService(): Promise<CommandResult> {
  if (process.platform !== "win32" || !app.isPackaged) {
    return { success: true, output: "Development service does not use Task Scheduler." };
  }
  if (taskRegistrationAttempted) {
    return taskRegistrationError
      ? { success: false, output: taskRegistrationError }
      : { success: true, output: "Current-user background service is registered." };
  }

  taskRegistrationAttempted = true;
  const script = taskRegistrationScriptPath();
  if (!existsSync(script)) {
    taskRegistrationError = `Task registration script was not found: ${script}`;
    return { success: false, output: taskRegistrationError };
  }

  const result = await runCommand("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-InstallRoot",
    process.resourcesPath,
  ]);
  if (!result.success)
    taskRegistrationError = result.output || "Unable to register the background service.";
  return result;
}

async function taskAction(action: "query" | "start" | "stop" | "restart"): Promise<CommandResult> {
  if (process.platform !== "win32") {
    return { success: false, output: "The background service is only available on Windows." };
  }

  if (action === "restart") {
    await runCommand("schtasks.exe", ["/End", "/TN", TASK_NAME]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return runCommand("schtasks.exe", ["/Run", "/TN", TASK_NAME]);
  }
  if (action === "query") {
    return runCommand("schtasks.exe", ["/Query", "/TN", TASK_NAME, "/FO", "LIST", "/V"]);
  }
  const verb = action === "start" ? "/Run" : "/End";
  return runCommand("schtasks.exe", [verb, "/TN", TASK_NAME]);
}

async function serviceAction(
  action: "query" | "start" | "stop" | "restart"
): Promise<CommandResult> {
  if (!app.isPackaged) {
    if (action === "query") {
      return {
        success: Boolean(developmentService && !developmentService.killed),
        output: developmentService
          ? "Development service is running."
          : "Development service is stopped.",
      };
    }
    if (action === "stop") {
      if (developmentService && !developmentService.killed) developmentService.kill();
      return { success: true, output: "Development service stopped." };
    }
    if (action === "restart" && developmentService && !developmentService.killed)
      developmentService.kill();
    startDevelopmentService();
    return { success: true, output: "Development service started." };
  }

  const registration = await registerCurrentUserService();
  if (!registration.success) return registration;
  return taskAction(action);
}

async function ensureServiceRunning(): Promise<{ ready: boolean; detail?: string }> {
  if (await isServiceHealthy()) return { ready: true };

  if (app.isPackaged) {
    const registration = await registerCurrentUserService();
    if (!registration.success) return { ready: false, detail: registration.output };
    const result = await taskAction("start");
    if (!result.success) return { ready: false, detail: result.output };
  } else {
    startDevelopmentService();
  }

  return {
    ready: await waitForService(),
    detail: taskRegistrationError || undefined,
  };
}

function registerIpc(): void {
  ipcMain.handle("service:action", (_event, action: "query" | "start" | "stop" | "restart") =>
    serviceAction(action)
  );
  ipcMain.handle("service:url", () => SERVICE_URL);
  ipcMain.handle("service:open-browser", () => shell.openExternal(SERVICE_URL));
}

async function showServiceStartupError(detail?: string): Promise<void> {
  if (!mainWindow) return;
  await dialog.showMessageBox(mainWindow, {
    type: "error",
    title: "OpenCode Memory",
    message: "The memory background service could not be started.",
    detail:
      detail ||
      "Open the app again after checking Task Scheduler, the bundled embedding model, and port 4747.",
  });
}

async function loadStatusPage(
  window: BrowserWindow,
  title: string,
  message: string,
  detail?: string
): Promise<void> {
  if (!isCurrentWindow(window)) return;
  try {
    await window.loadURL(statusPage(title, message, detail));
  } catch {
    // The window remains visible even if Chromium cannot render the fallback page.
  }
}

async function loadApplication(window: BrowserWindow): Promise<void> {
  const service = await ensureServiceRunning();
  if (!isCurrentWindow(window)) return;

  if (!service.ready) {
    await loadStatusPage(
      window,
      "OpenCode Memory could not start",
      "The background service did not become ready. Check the service status in the task panel, then restart the application.",
      service.detail
    );
    await showServiceStartupError(service.detail);
    return;
  }

  try {
    await window.loadURL(`${SERVICE_URL}/?desktop=1`);
  } catch (error) {
    await loadStatusPage(
      window,
      "OpenCode Memory could not load",
      "The background service is reachable, but the management panel did not load.",
      String(error)
    );
  }
}

async function createWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: true,
    title: "OpenCode Memory",
    backgroundColor: "#111827",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(app.getAppPath(), "dist", "preload.js"),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(SERVICE_URL)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(SERVICE_URL)) event.preventDefault();
  });
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 || validatedUrl.startsWith("data:") || !mainWindow)
        return;
      void loadStatusPage(
        mainWindow,
        "OpenCode Memory could not load",
        "The management panel navigation failed.",
        `${errorDescription} (${errorCode}): ${validatedUrl}`
      );
    }
  );
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (!mainWindow) return;
    void loadStatusPage(
      mainWindow,
      "OpenCode Memory renderer stopped",
      "The management panel renderer exited unexpectedly. Restart the application to try again.",
      `${details.reason}${details.exitCode ? ` (exit code ${details.exitCode})` : ""}`
    );
  });

  const window = mainWindow;
  mainWindow.on("closed", () => (mainWindow = null));
  await loadStatusPage(
    window,
    "Starting OpenCode Memory",
    "Preparing the local memory service and management panel."
  );
  void loadApplication(window);
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  registerIpc();
  await createWindow();
  try {
    await installOpenCodeBridge();
  } catch (error) {
    const options = {
      type: "warning",
      title: "OpenCode Memory",
      message: "The OpenCode bridge could not be installed automatically.",
      detail: String(error),
    } as const;
    if (mainWindow) await dialog.showMessageBox(mainWindow, options);
    else await dialog.showMessageBox(options);
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (app.isReady()) focusMainWindow();
    else void app.whenReady().then(focusMainWindow);
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (developmentService && !developmentService.killed) developmentService.kill();
});
