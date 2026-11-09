// IPC handlers behind the preload bridge (preload.cjs → window.tracker). This is the
// UI's only way to the data: none of these are reachable over HTTP. Every action here
// is the human's (actor "human").
import { ipcMain } from "electron";

import * as db from "./db.js";
import { defaultTrack, isValidTrack, readSettings } from "./config.js";
import { listBookmarklets } from "./bookmarklets.js";
import { FOLDERS } from "./workflow.js";

const optStr = (v) => (typeof v === "string" && v ? v : null);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isId = (v) => Number.isInteger(v) && v > 0;
const HUMAN = { actor: "human" };

function needId(id) {
  if (!isId(id)) throw new Error("bad job id");
  return id;
}

// TransitionErrors carry the reason the move was refused; keep just that.
function moveOne(id, to, opts = {}) {
  const { message = null, answers, override = false } = isObject(opts) ? opts : {};
  return db.transition(needId(id), to, {
    ...HUMAN,
    message: optStr(message),
    data: answers === undefined ? null : { answers },
    override: override === true,
  });
}

// isTrusted(url) decides whether a frame may call these handlers (the app's own page
// only — never a remote page that somehow ended up in a window).
export function registerIpc(isTrusted) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrusted(event.senderFrame?.url || "")) throw new Error(`untrusted sender for ${channel}`);
      return fn(...args);
    });

  handle("jobs:list", (opts = {}) => {
    const o = isObject(opts) ? opts : {};
    const folder = FOLDERS.some((f) => f.key === o.folder) ? o.folder : "new";
    const limit = Number.isInteger(o.limit) ? Math.min(Math.max(o.limit, 1), 500) : 50;
    const offset = Number.isInteger(o.offset) && o.offset > 0 ? o.offset : 0;
    return db.listJobSummaries({ folder, track: optStr(o.track), q: optStr(o.q), limit, offset });
  });
  handle("jobs:get", (id) => {
    const job = db.getJobDetail(needId(id));
    if (!job) return null;
    const account = db.accountForJob(job);
    // The password stays in the main process until the human asks for it.
    return { ...job, account: account ? { tenant: account.tenant, email: account.email } : null };
  });
  handle("folders:counts", (track) => db.folderCounts({ track: optStr(track) }));

  // A job the human typed in: same path as a bookmarklet capture (dedup by URL, blacklist).
  handle("jobs:add", (data) => {
    if (!isObject(data)) throw new Error("bad job");
    const fields = {};
    for (const k of ["url", "title", "company", "location", "description"]) fields[k] = typeof data[k] === "string" ? data[k].trim() : "";
    if (!fields.url && !fields.title) throw new Error("missing url/title");
    const track = "track" in data ? data.track ?? null : defaultTrack();
    if (!isValidTrack(track)) throw new Error(`unknown track ${track}`);
    return db.addJob({ ...fields, source: "manual" }, { ...HUMAN, track });
  });
  handle("jobs:transition", (id, to, opts) => moveOne(id, to, opts));
  handle("jobs:bulkTransition", (ids, to, opts) => {
    if (!Array.isArray(ids) || !ids.length) throw new Error("no jobs selected");
    const results = { moved: [], refused: [] };
    for (const id of ids) {
      try {
        moveOne(id, to, opts);
        results.moved.push(id);
      } catch (e) {
        if (!(e instanceof db.TransitionError)) throw e;
        results.refused.push({ id, reason: e.message });
      }
    }
    return results;
  });
  handle("jobs:setFields", (id, fields) => {
    if (!isObject(fields)) throw new Error("bad fields");
    if ("track" in fields && !isValidTrack(fields.track ?? null)) throw new Error(`unknown track ${fields.track}`);
    const job = db.setJobFields(needId(id), fields, HUMAN);
    if (job === null) throw new Error("no valid fields or job not found");
    return job;
  });
  handle("jobs:resolveNeed", (id, need) => {
    const rest = db.resolveNeed(needId(id), String(need ?? ""), HUMAN);
    if (rest === null) throw new Error("need not found");
    return rest;
  });
  handle("jobs:addNote", (id, message) => {
    if (!optStr(message)) throw new Error("empty note");
    return db.addEvent(needId(id), { ...HUMAN, message });
  });
  handle("account:reveal", (id) => db.accountForJob(db.getJob(needId(id)))?.password ?? null);

  handle("stats:get", () => db.stats());
  handle("stats:today", () => db.statsToday());
  handle("stats:daily", (days) => db.statsDaily(Number.isInteger(days) && days >= 1 ? days : null));
  handle("bookmarklets:list", () => listBookmarklets());
  handle("settings:get", () => {
    const { links, tracks } = readSettings();
    return { links, tracks };
  });
}
