import { allowedTargets } from "../workflow.js";

// Button labels for the moves the human can make from a status.
const LABELS = {
  triaged: (from) => (from === "new" ? "Triage ✓" : "Back to triaged"),
  in_progress: (from) => ({ triaged: "Start", on_hold: "Start", ready: "Send back to agent", blocked: "Unblock" })[from],
  on_hold: () => "Hold",
  applied: () => "Submitted ✓",
  interviewing: () => "Interviewing",
  rejected: () => "Rejected",
  trash: () => "Trash",
  new: () => "Restore",
};

export function humanActions(status) {
  return allowedTargets(status, "human").map((to) => ({ to, label: LABELS[to](status) }));
}

// Bulk-bar actions, in order; each is offered when any selected job allows it.
export const BULK = [
  { to: "triaged", label: "Triage" },
  { to: "in_progress", label: "Start" },
  { to: "on_hold", label: "Hold" },
  { to: "trash", label: "Trash" },
  { to: "new", label: "Restore" },
];
