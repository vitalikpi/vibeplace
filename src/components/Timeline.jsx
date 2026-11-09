import { STATUS_LABELS } from "../workflow.js";
import { fullTime, relTime } from "../lib/format.js";

const actorTone = (actor) =>
  actor.startsWith("agent:")
    ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
    : actor === "gmail"
      ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
      : actor === "human"
        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
        : "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300";

// The job's history, newest first, like a mail thread read from the top.
export default function Timeline({ events }) {
  const items = [...events].reverse();
  return (
    <ol aria-label="Timeline" className="space-y-2">
      {items.map((e) => (
        <li key={e.id} className="text-sm">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className={`rounded px-1.5 py-0.5 font-medium ${actorTone(e.actor)}`}>{e.actor}</span>
            {e.to_status && (
              <span className="font-medium text-slate-700 dark:text-slate-200">
                {e.from_status ? `${STATUS_LABELS[e.from_status] || e.from_status} → ` : "→ "}
                {STATUS_LABELS[e.to_status] || e.to_status}
              </span>
            )}
            <time dateTime={e.at} title={fullTime(e.at)} className="ml-auto tabular-nums">
              {relTime(e.at)}
            </time>
          </div>
          {e.message && e.message !== e.to_status && (
            <p className="mt-0.5 whitespace-pre-wrap break-words text-slate-700 dark:text-slate-300">{e.message}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
