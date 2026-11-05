// Electron entry: picks the data folder, starts the capture + MCP server on
// 127.0.0.1:7085 (PORT overrides) and shows the board in a window. The UI is loaded
// from disk and reaches the data over IPC only (preload.cjs → ipc.js). The server
// lives as long as the app does (closing the window on macOS keeps it running for the
// bookmarklets and Claude Code).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, Menu, shell } from "electron";

import { DIST_DIR, PORT, envDataRoot, getPaths, setDataRoot } from "./config.js";
import { closeDb, initDb } from "./db.js";
import { registerIpc } from "./ipc.js";
import { createServer } from "./server.js";

app.setName("Job Tracker"); // same userData folder in dev and packaged builds

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEV = process.env.ELECTRON_DEV === "1";
const DEV_URL = "http://localhost:5173";
const INDEX_HTML = path.join(DIST_DIR, "index.html");
// Prefix every URL of the app's own page starts with (dev server or dist/ on disk).
const APP_PREFIX = DEV ? DEV_URL + "/" : pathToFileURL(DIST_DIR).href + "/";
const configPath = () => path.join(app.getPath("userData"), "config.json");

let win = null;
let server = null;

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf-8"));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

async function pickDataFolder(message) {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Choose the Job Tracker data folder",
    message,
    buttonLabel: "Use This Folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (canceled || !filePaths.length) return null;
  writeConfig({ ...readConfig(), dataRoot: filePaths[0] });
  return filePaths[0];
}

// Env override (tests) → saved choice → ask once.
async function resolveDataRoot() {
  const env = envDataRoot();
  if (env) return env;
  const saved = readConfig().dataRoot;
  if (saved && fs.existsSync(saved)) return saved;
  return pickDataFolder(
    saved
      ? `The data folder ${saved} is missing. Choose it again or pick a new one.`
      : "jobs.db, resume.txt, bookmarklets/ and settings.json live here. An empty folder starts a fresh tracker."
  );
}

async function changeDataFolder() {
  if (await pickDataFolder("The app restarts to use the new folder.")) {
    app.relaunch();
    app.exit(0);
  }
}

function buildMenu() {
  const template = [
    { role: "appMenu" },
    {
      label: "File",
      submenu: [
        { label: "Change Data Folder…", click: changeDataFolder },
        {
          label: "Show Data Folder",
          click: () => shell.openPath(getPaths().DATA_ROOT),
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const isAppUrl = (url) => url.startsWith(APP_PREFIX);

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Job Tracker",
    webPreferences: {
      preload: path.join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Job links on cards open in the system browser, not in the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!isAppUrl(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  win.on("closed", () => {
    win = null;
  });
  if (DEV) win.loadURL(DEV_URL);
  else win.loadFile(INDEX_HTML);
}

// Plain http.Server rather than app.listen(): Express 5 hands bind errors to the
// listen callback, which would make EADDRINUSE look like a successful start.
function startServer() {
  return new Promise((resolve, reject) => {
    const s = http.createServer(createServer());
    s.once("error", reject);
    s.listen(PORT, "127.0.0.1", () => resolve(s));
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    const root = await resolveDataRoot();
    if (!root) return app.quit();
    setDataRoot(root);
    if (!DEV && !fs.existsSync(INDEX_HTML)) {
      dialog.showErrorBox("UI not built", "Run `npm run build` (or use `npm run electron:start`).");
      return app.exit(1);
    }
    try {
      initDb(getPaths().DB_PATH);
      server = await startServer();
    } catch (e) {
      if (e.code === "EADDRINUSE") {
        dialog.showErrorBox(
          `Port ${PORT} in use`,
          "Another program (an old tracker?) is using it. Quit it, or start the app with PORT set to a free port."
        );
      } else {
        dialog.showErrorBox("Job Tracker failed to start", String(e.stack || e));
      }
      return app.exit(1);
    }
    registerIpc(isAppUrl);
    buildMenu();
    createWindow();
  });

  // macOS: closing the window keeps the server (bookmarklets, MCP) running.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (!win && server) createWindow();
  });
  app.on("before-quit", () => {
    server?.close();
    server?.closeAllConnections?.();
    closeDb();
  });
}
