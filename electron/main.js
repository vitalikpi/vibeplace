// Electron entry: picks the data folder, starts the API + MCP server on 127.0.0.1:8775 (PORT overrides)
// and shows the board in a window. The server lives as long as the app does (closing
// the window on macOS keeps it running for the bookmarklets and Claude Code).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { app, BrowserWindow, dialog, Menu, shell } from "electron";

import { PORT, envDataRoot, getPaths, setDataRoot } from "./config.js";
import { closeDb, initDb } from "./db.js";
import { createServer } from "./server.js";

app.setName("Job Tracker"); // same userData folder in dev and packaged builds

const DEV = process.env.ELECTRON_DEV === "1";
const APP_URL = DEV ? "http://localhost:5173" : `http://127.0.0.1:${PORT}`;
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

const isLocal = (url) => url.startsWith(APP_URL) || url.startsWith(`http://127.0.0.1:${PORT}`);

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Job Tracker",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // Job links on cards open in the system browser, not in the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!isLocal(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  win.on("closed", () => {
    win = null;
  });
  win.loadURL(APP_URL);
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
