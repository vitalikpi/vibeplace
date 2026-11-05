// Electron entry: picks the data folder, starts the capture + MCP server on
// 127.0.0.1:7085 (PORT overrides) and shows the tracker in a window. The UI is loaded
// from disk and reaches the data over IPC only (preload.cjs → ipc.js). The server
// lives as long as the app does (closing the window on macOS keeps it running for the
// bookmarklets and Claude Code).
//
// Every write (UI, MCP, bookmarklet) goes through db.js in this process, so db.onChange
// drives live UI updates, the dock badge ("waiting for me" count) and a notification
// when an agent hands a job back.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, Menu, Notification, shell } from "electron";

import { DIST_DIR, PORT, envDataRoot, getPaths, setDataRoot } from "./config.js";
import { closeDb, folderCounts, getJob, initDb, onChange } from "./db.js";
import { registerIpc } from "./ipc.js";
import { createServer } from "./server.js";
import { STATUS_LABELS, WAITING, actorKind } from "./workflow.js";

app.setName("Job Tracker"); // same userData folder in dev and packaged builds
// Tests: a separate userData folder (its own config and single-instance lock), so a
// test instance can run next to the real app.
if (process.env.TRACKER_USER_DATA) app.setPath("userData", process.env.TRACKER_USER_DATA);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEV = process.env.ELECTRON_DEV === "1";
const DEV_URL = "http://localhost:5173";
const INDEX_HTML = path.join(DIST_DIR, "index.html");
// Prefix every URL of the app's own page starts with (dev server or dist/ on disk).
const APP_PREFIX = DEV ? DEV_URL + "/" : pathToFileURL(DIST_DIR).href + "/";
const configPath = () => path.join(app.getPath("userData"), "config.json");

let win = null;
let server = null;
let started = false; // data folder chosen, DB open, server listening, IPC registered
let quitting = false;

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

// Stop accepting requests, let in-flight ones finish, then close the database.
async function shutdown() {
  if (server) {
    const s = server;
    server = null;
    await new Promise((resolve) => {
      s.close(resolve);
      s.closeIdleConnections?.();
      setTimeout(() => {
        s.closeAllConnections?.();
        resolve();
      }, 2000).unref();
    });
  }
  closeDb();
}

function startupError(e) {
  if (e.code === "EADDRINUSE") {
    dialog.showErrorBox(
      `Port ${PORT} in use`,
      "Another program (an old tracker?) is using it. Quit it, or start the app with PORT set to a free port."
    );
  } else {
    dialog.showErrorBox("Job Tracker failed to start", String(e.stack || e));
  }
}

// Open a data folder: database (migrating it if needed), server, change watching.
async function openDataFolder(root) {
  setDataRoot(root);
  try {
    initDb(getPaths().DB_PATH);
    server = await startServer();
  } catch (e) {
    closeDb();
    throw e;
  }
  watchChanges(); // closeDb() drops listeners, so (re)register for this database
  updateBadge();
}

// Switch folders in place: no process restart, which in dev would also stop Vite.
async function changeDataFolder() {
  if (envDataRoot()) {
    dialog.showErrorBox("Data folder is fixed", "TRACKER_DATA_ROOT is set, so the folder can't be changed here.");
    return;
  }
  const previous = getPaths().DATA_ROOT;
  const next = await pickDataFolder("The tracker reopens with the new folder.");
  if (!next || next === previous) return;
  await shutdown();
  try {
    await openDataFolder(next);
  } catch (e) {
    startupError(e);
    writeConfig({ ...readConfig(), dataRoot: previous });
    try {
      await openDataFolder(previous);
    } catch (e2) {
      startupError(e2);
      quitting = true;
      return app.exit(1);
    }
  }
  if (win) win.webContents.reload();
  else createWindow();
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

// Job and application links open in the system browser, and only if they're web
// pages: job URLs come from any website (POST /api/jobs), so file:, smb:, custom
// protocol handlers and the like are refused.
function openWebLink(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === "https:" || protocol === "http:") shell.openExternal(url);
  } catch {
    /* not a URL */
  }
}

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
  win.webContents.setWindowOpenHandler(({ url }) => {
    openWebLink(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!isAppUrl(url)) {
      e.preventDefault();
      openWebLink(url);
    }
  });
  win.on("closed", () => {
    win = null;
  });
  if (DEV) win.loadURL(DEV_URL);
  else win.loadFile(INDEX_HTML);
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.focus();
}

// --- live updates, dock badge, notifications --------------------------------------

let pending = null;

function updateBadge() {
  let n;
  try {
    n = folderCounts().waiting;
  } catch {
    return; // no database open (between folders)
  }
  app.dock?.setBadge(n ? String(n) : "");
}

function notifyHandBack(jobId, to) {
  if (!Notification.isSupported()) return;
  const job = getJob(jobId);
  if (!job) return;
  const n = new Notification({
    title: to === "ready" ? "Ready to submit" : `${STATUS_LABELS[to]}: needs you`,
    body: [job.company, job.title].filter(Boolean).join(" — ") || `Job #${jobId}`,
  });
  n.on("click", () => {
    showWindow();
    win?.webContents.send("tracker:changed", { jobIds: [jobId], kinds: [], open: jobId });
  });
  n.show();
}

// Batch the changes of one burst (a bulk move, a batch capture) into one push.
function watchChanges() {
  onChange((c) => {
    if (c.kind === "transition" && WAITING.includes(c.to) && actorKind(c.actor) === "agent") {
      notifyHandBack(c.jobId, c.to);
    }
    if (!pending) {
      pending = { jobIds: new Set(), kinds: new Set() };
      setTimeout(() => {
        const { jobIds, kinds } = pending;
        pending = null;
        if (quitting) return;
        updateBadge();
        win?.webContents.send("tracker:changed", { jobIds: [...jobIds], kinds: [...kinds] });
      }, 50);
    }
    pending.jobIds.add(c.jobId);
    pending.kinds.add(c.kind);
  });
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
  // A second launch focuses this one, but not before startup has finished (the
  // first-run folder picker may still be open).
  app.on("second-instance", () => {
    if (started) showWindow();
  });

  app.whenReady().then(async () => {
    const root = await resolveDataRoot();
    if (!root) return app.quit();
    if (!DEV && !fs.existsSync(INDEX_HTML)) {
      dialog.showErrorBox("UI not built", "Run `npm run build` (or use `npm run electron:start`).");
      return app.exit(1);
    }
    try {
      await openDataFolder(root);
    } catch (e) {
      startupError(e);
      return app.exit(1);
    }
    registerIpc(isAppUrl);
    buildMenu();
    started = true;
    createWindow();
  });

  // macOS: closing the window keeps the server (bookmarklets, MCP) running.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (started && !win) createWindow();
  });
  app.on("before-quit", (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    shutdown().finally(() => app.quit());
  });
}
