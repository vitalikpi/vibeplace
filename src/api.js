// Thin fetch wrapper around the tracker API (electron/server.js). Relative URLs work
// both in dev (Vite proxies /api -> the app's port) and in the app (served from :8775).

async function req(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export function listJobs({ track, q } = {}) {
  const params = new URLSearchParams();
  if (track) params.set("track", track);
  if (q) params.set("q", q);
  const qs = params.toString();
  return req(`/api/jobs${qs ? "?" + qs : ""}`);
}

export function getStats() {
  return req("/api/stats");
}

export function getBookmarklet() {
  return req("/api/bookmarklet");
}

export function getMe() {
  return req("/api/me");
}

export function getTodayStats() {
  return req("/api/stats/today");
}

export function getDailyStats(days) {
  return req(`/api/stats/daily${days ? "?days=" + days : ""}`);
}

export function updateJob(id, fields) {
  return req(`/api/jobs/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
}
