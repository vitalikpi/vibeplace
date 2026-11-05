// Thin fetch wrapper around the Flask API. Relative URLs work both in dev (Vite
// proxies /api -> :8765) and in production (Flask serves this app on :8765).

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
