// Thin wrapper around the bridge the preload script exposes as window.tracker
// (electron/preload.cjs → electron/ipc.js). The UI never talks HTTP to the app.

function tracker() {
  if (!window.tracker) throw new Error("not running inside the Job Tracker app");
  return window.tracker;
}

// IPC errors arrive as "Error invoking remote method 'x': Error: msg"; keep msg.
async function call(fn) {
  try {
    return await fn(tracker());
  } catch (e) {
    throw new Error(String(e?.message || e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ""));
  }
}

export const listJobs = (opts) => call((t) => t.listJobs(opts));
export const getJob = (id) => call((t) => t.getJob(id));
export const addJob = (data) => call((t) => t.addJob(data));
export const folderCounts = (track) => call((t) => t.folderCounts(track || null));
export const transition = (id, to, opts) => call((t) => t.transition(id, to, opts));
export const bulkTransition = (ids, to, opts) => call((t) => t.bulkTransition(ids, to, opts));
export const setFields = (id, fields) => call((t) => t.setFields(id, fields));
export const addNote = (id, message) => call((t) => t.addNote(id, message));
export const revealPassword = (id) => call((t) => t.revealPassword(id));
export const getStats = () => call((t) => t.stats());
export const getTodayStats = () => call((t) => t.statsToday());
export const getDailyStats = (days) => call((t) => t.statsDaily(days || null));
export const getBookmarklets = () => call((t) => t.bookmarklets());
export const getSettings = () => call((t) => t.settings());

// Live updates from the main process; a no-op outside the app.
export function onChange(cb) {
  return window.tracker?.onChange ? window.tracker.onChange(cb) : () => {};
}
