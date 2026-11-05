// Preload bridge: exposes window.tracker to the UI. CommonJS because sandboxed
// preloads can't be ES modules. Each call maps to one ipcMain handler in ipc.js;
// onChange subscribes to the main process's "tracker:changed" push.
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("tracker", {
  listJobs: invoke("jobs:list"),
  getJob: invoke("jobs:get"),
  folderCounts: invoke("folders:counts"),
  transition: invoke("jobs:transition"),
  bulkTransition: invoke("jobs:bulkTransition"),
  setFields: invoke("jobs:setFields"),
  resolveNeed: invoke("jobs:resolveNeed"),
  addNote: invoke("jobs:addNote"),
  revealPassword: invoke("account:reveal"),
  stats: invoke("stats:get"),
  statsToday: invoke("stats:today"),
  statsDaily: invoke("stats:daily"),
  bookmarklets: invoke("bookmarklets:list"),
  settings: invoke("settings:get"),
  // cb({jobIds, kinds}) after every write (UI, MCP or bookmarklet); returns unsubscribe.
  onChange: (cb) => {
    const listener = (_event, change) => cb(change);
    ipcRenderer.on("tracker:changed", listener);
    return () => ipcRenderer.removeListener("tracker:changed", listener);
  },
});
