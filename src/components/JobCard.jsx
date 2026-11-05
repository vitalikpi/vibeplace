import { useState } from "react";
import { TRACKS } from "../App.jsx";

// Sensible stage actions per current status. Each entry: [targetStatus, label].
const ACTIONS = {
  incoming: [["review", "→ Review"], ["applied", "→ Applied"]],
  review: [["applied", "→ Applied"], ["incoming", "← Incoming"]],
  applied: [["rejected", "→ Rejected"], ["review", "← Review"]],
  rejected: [["applied", "← Applied"]],
  trash: [["incoming", "♻ Restore"]],
};

export default function JobCard({ job, onPatch }) {
  const [expanded, setExpanded] = useState(false);
  const [notes, setNotes] = useState(job.notes || "");

  const saveNotes = () => {
    if (notes !== (job.notes || "")) onPatch(job.id, { notes });
  };

  const actions = ACTIONS[job.status] || [];

  return (
    <article className="rounded-md border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold text-slate-900 dark:text-slate-100" title={job.company}>
            <span className="mr-1 select-all font-mono text-xs font-normal text-slate-400 dark:text-slate-500">
              #{job.id}
            </span>
            {job.company || "(unknown company)"}
          </p>
          <p className="truncate text-sm text-slate-600 dark:text-slate-300" title={job.title}>
            {job.title || "(no title)"}
          </p>
        </div>
        <select
          value={job.track}
          onChange={(e) => onPatch(job.id, { track: e.target.value })}
          className="shrink-0 rounded border border-slate-300 bg-slate-50 px-1 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
          title="Track"
        >
          {TRACKS.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        {job.url && (
          <a
            href={job.url}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            Open posting ↗
          </a>
        )}
        {job.location && <span className="text-slate-500 dark:text-slate-400">{job.location}</span>}
        {job.duplicateCompany && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
            ⚠ already applied
          </span>
        )}
      </div>

      {job.body && (
        <div className="mt-2">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          >
            {expanded ? "▾ Hide description" : "▸ Show description"}
          </button>
          {expanded && (
            <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-700 dark:bg-slate-900 dark:text-slate-300">
              {job.body}
            </pre>
          )}
        </div>
      )}

      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={saveNotes}
        placeholder="Notes…"
        rows={2}
        className="mt-2 w-full resize-y rounded border border-slate-200 bg-slate-50 p-1.5 text-xs focus:border-slate-400 focus:outline-none dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:border-slate-500"
      />

      <div className="mt-2 flex flex-wrap gap-1.5">
        {actions.map(([target, label]) => (
          <button
            key={target}
            onClick={() => onPatch(job.id, { status: target })}
            className="rounded bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
          >
            {label}
          </button>
        ))}
        {job.status !== "trash" && (
          <button
            onClick={() => onPatch(job.id, { status: "trash" })}
            className="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            Trash
          </button>
        )}
      </div>
    </article>
  );
}
