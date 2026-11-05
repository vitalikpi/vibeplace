// IPC handlers behind the preload bridge (preload.cjs → window.tracker). This is the
// UI's only way to the data: none of these are reachable over HTTP.
import { ipcMain } from "electron";

import * as db from "./db.js";
import { readSettings } from "./config.js";
import { listBookmarklets } from "./bookmarklets.js";

const optStr = (v) => (typeof v === "string" && v ? v : null);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// isTrusted(url) decides whether a frame may call these handlers (the app's own page
// only — never a remote page that somehow ended up in a window).
export function registerIpc(isTrusted) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrusted(event.senderFrame?.url || "")) throw new Error(`untrusted sender for ${channel}`);
      return fn(...args);
    });

  handle("jobs:list", (filters = {}) =>
    db.listJobs({ status: optStr(filters.status), track: optStr(filters.track), q: optStr(filters.q) })
  );
  handle("jobs:update", (id, fields) => {
    if (!Number.isInteger(id) || id < 0 || !isObject(fields)) throw new Error("bad job id or fields");
    const updated = db.updateJob(id, fields);
    if (updated === null) throw new Error("no valid fields or job not found");
    return updated;
  });
  handle("stats:get", () => db.stats());
  handle("stats:today", () => db.statsToday());
  handle("stats:daily", (days) => db.statsDaily(Number.isInteger(days) ? days : null));
  handle("bookmarklets:list", () => listBookmarklets());
  handle("me:get", () => ({ links: readSettings().links }));
}
