// Preload bridge: exposes window.tracker to the UI. CommonJS because sandboxed
// preloads can't be ES modules. Each call maps to one ipcMain handler in ipc.js;
// onChange subscribes to the main process's "tracker:changed" push.
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

// Listen to a push channel from main; returns unsubscribe.
function subscribe(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("tracker", {
  // "darwin" | "win32" | "linux": picks shortcut labels and terminal copy/paste keys.
  platform: process.platform,
  listJobs: invoke("jobs:list"),
  getJob: invoke("jobs:get"),
  folderCounts: invoke("folders:counts"),
  transition: invoke("jobs:transition"),
  bulkTransition: invoke("jobs:bulkTransition"),
  setFields: invoke("jobs:setFields"),
  addNote: invoke("jobs:addNote"),
  revealPassword: invoke("account:reveal"),
  stats: invoke("stats:get"),
  statsToday: invoke("stats:today"),
  statsDaily: invoke("stats:daily"),
  bookmarklets: invoke("bookmarklets:list"),
  settings: invoke("settings:get"),
  // The embedded terminal (a shell in the data folder; see electron/terminal.js).
  terminal: {
    start: invoke("term:start"),
    write: invoke("term:write"),
    resize: invoke("term:resize"),
    stop: invoke("term:stop"),
    onData: (cb) => subscribe("term:data", cb),
    onExit: (cb) => subscribe("term:exit", cb),
  },
  // cb({jobIds, kinds}) after every write (UI, MCP or bookmarklet); returns unsubscribe.
  onChange: (cb) => subscribe("tracker:changed", cb),
});
