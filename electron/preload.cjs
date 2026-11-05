// Preload bridge: exposes window.tracker to the UI. CommonJS because sandboxed
// preloads can't be ES modules. Each call maps to one ipcMain handler in ipc.js.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tracker", {
  listJobs: (filters) => ipcRenderer.invoke("jobs:list", filters),
  updateJob: (id, fields) => ipcRenderer.invoke("jobs:update", id, fields),
  stats: () => ipcRenderer.invoke("stats:get"),
  statsToday: () => ipcRenderer.invoke("stats:today"),
  statsDaily: (days) => ipcRenderer.invoke("stats:daily", days),
  bookmarklets: () => ipcRenderer.invoke("bookmarklets:list"),
  me: () => ipcRenderer.invoke("me:get"),
});
