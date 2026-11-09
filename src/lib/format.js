// An http(s) URL to link to, or null: job URLs come from any website, so nothing
// else (javascript:, file:, custom schemes) is ever rendered as a link.
export function safeHref(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

// Gmail-style short time: "now", "5m", "3h", "2d", then "Nov 5".
export function relTime(iso, now = Date.now()) {
  if (!iso) return "";
  const d = new Date(iso);
  const s = (now - d.getTime()) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const fullTime = (iso) => (iso ? new Date(iso).toLocaleString() : "");

// One line under the title: its latest timeline note (for a blocked job, usually what
// the agent needs).
export function snippet(job) {
  return job.last_event || "";
}
