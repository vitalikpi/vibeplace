// The application pipeline: statuses, sidebar folders and who may move a job where.
// Pure ESM with no Node or Electron imports, so the UI imports it too (src/workflow.js).
//
//   new ─triage─▶ triaged ─Start─▶ in_progress ─agent─▶ blocked ─Unblock─▶ in_progress …
//    └─▶ trash                          └─agent─▶ ready ─human submits─▶ applied ─▶ interviewing
//   on_hold: parked by agent or human; any outcome can end in rejected.

export const STATUSES = [
  "new",
  "triaged",
  "in_progress",
  "blocked",
  "ready",
  "on_hold",
  "applied",
  "interviewing",
  "rejected",
  "trash",
];

// Statuses before the application went out.
export const PRE_APPLY = ["new", "triaged", "in_progress", "blocked", "ready", "on_hold"];

// Statuses that count as "committed to this company" for the duplicate warning.
export const COMMITTED = ["triaged", "in_progress", "blocked", "ready", "on_hold", "applied", "interviewing", "rejected"];

// "Waiting for me": the agent handed the job back to the human.
export const WAITING = ["blocked", "ready"];

// Sidebar order. `waiting` is virtual (WAITING); the rest are one status each.
export const FOLDERS = [
  { key: "new", label: "New", statuses: ["new"] },
  { key: "triaged", label: "Triaged", statuses: ["triaged"] },
  { key: "in_progress", label: "In progress", statuses: ["in_progress"] },
  { key: "waiting", label: "Waiting for me", statuses: WAITING },
  { key: "applied", label: "Applied", statuses: ["applied"] },
  { key: "interviewing", label: "Interviewing", statuses: ["interviewing"] },
  { key: "rejected", label: "Rejected", statuses: ["rejected"] },
  { key: "on_hold", label: "On hold", statuses: ["on_hold"] },
  { key: "trash", label: "Trash", statuses: ["trash"] },
];

export const STATUS_LABELS = {
  new: "New",
  triaged: "Triaged",
  in_progress: "In progress",
  blocked: "Blocked",
  ready: "Ready to submit",
  on_hold: "On hold",
  applied: "Applied",
  interviewing: "Interviewing",
  rejected: "Rejected",
  trash: "Trash",
};

// Actor strings stored on events: "human", "agent:<name>", "gmail", "bookmarklet",
// "migration". Rules are per kind.
export const ACTOR_KINDS = ["human", "agent", "gmail", "bookmarklet"];

export function actorKind(actor) {
  const kind = String(actor || "").split(":")[0];
  return ACTOR_KINDS.includes(kind) ? kind : null;
}

const H = "human";
const A = "agent";
const G = "gmail";
const B = "bookmarklet";

// [from statuses, to, allowed actor kinds]
const RULES = [
  [["new"], "triaged", [H, A]],
  [["triaged"], "in_progress", [H]], // Start
  [["in_progress"], "blocked", [A]],
  [["in_progress"], "ready", [A]],
  [["blocked"], "in_progress", [H, B]], // Unblock
  [["ready"], "in_progress", [H]], // send back to the agent
  [["on_hold"], "triaged", [H]],
  [["on_hold"], "in_progress", [H]],
  [PRE_APPLY, "applied", [H, B, G]], // never an agent: the human submits
  [["applied"], "interviewing", [H, G]],
  [[...PRE_APPLY, "applied", "interviewing"], "rejected", [H, G]],
  [STATUSES.filter((s) => !["on_hold", "trash"].includes(s)), "on_hold", [H, A]],
  [STATUSES.filter((s) => s !== "trash"), "trash", [H]],
  [["new", "triaged"], "trash", [A]], // triage NO-GO
  [["trash"], "new", [H]], // restore
];

export function canTransition(from, to, kind) {
  if (from === to) return false;
  return RULES.some(([froms, t, kinds]) => t === to && froms.includes(from) && kinds.includes(kind));
}

// Statuses `kind` may move a job in `from` to, in STATUSES order.
export function allowedTargets(from, kind) {
  return STATUSES.filter((to) => canTransition(from, to, kind));
}

// Entering in_progress from these hands the job to the agent loop (queue message).
export const QUEUE_ON_ENTER = { triaged: "start", on_hold: "start", ready: "start", blocked: "unblock" };
