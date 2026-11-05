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
    throw new Error(String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
  }
}

export function listJobs({ track, q } = {}) {
  return call((t) => t.listJobs({ track, q }));
}

export function getStats() {
  return call((t) => t.stats());
}

export function getBookmarklet() {
  return call((t) => t.bookmarklets());
}

export function getMe() {
  return call((t) => t.me());
}

export function getTodayStats() {
  return call((t) => t.statsToday());
}

export function getDailyStats(days) {
  return call((t) => t.statsDaily(days || null));
}

export function updateJob(id, fields) {
  return call((t) => t.updateJob(id, fields));
}
