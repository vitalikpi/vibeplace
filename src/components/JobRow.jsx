import { WAITING } from "../workflow.js";
import { relTime, snippet } from "../lib/format.js";

const STATUS_MARK = {
  blocked: ["🟡", "Blocked: needs you"],
  ready: ["🟢", "Ready to submit"],
  on_hold: ["⏸", "On hold"],
  in_progress: ["▶", "Agent working"],
};

function Badge({ children, tone = "slate", title }) {
  const tones = {
    slate: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    red: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    violet: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  };
  return (
    <span title={title} className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

// One Gmail-style line: checkbox, status mark, company, title — snippet, badges, time.
// Bold while the job waits for the human (like unread mail).
export default function JobRow({ job, selected, cursor, open, onToggle, onOpen }) {
  const waiting = WAITING.includes(job.status);
  const stalled = job.status === "in_progress" && !job.owner;
  const [mark, markTitle] = stalled ? ["⚠", "In progress, no agent holds it"] : STATUS_MARK[job.status] || ["", ""];
  return (
    <div
      role="row"
      aria-selected={selected}
      data-job-id={job.id}
      onClick={() => onOpen(job.id)}
      className={`flex cursor-pointer items-center gap-3 border-b border-slate-100 px-3 py-2 text-sm dark:border-slate-800 ${
        open
          ? "bg-blue-50 dark:bg-blue-950/40"
          : selected
            ? "bg-amber-50 dark:bg-amber-950/30"
            : waiting
              ? "bg-white dark:bg-slate-900"
              : "bg-slate-50/60 dark:bg-slate-900/60"
      } border-l-4 ${cursor ? "border-l-blue-500" : "border-l-transparent"} hover:shadow-sm`}
    >
      <input
        type="checkbox"
        aria-label={`Select ${job.company || "job"} ${job.title || ""}`}
        checked={selected}
        onClick={(e) => e.stopPropagation()}
        onChange={() => onToggle(job.id)}
        className="shrink-0"
      />
      <span className="w-4 shrink-0 text-center" title={markTitle} aria-label={markTitle || undefined}>
        {mark}
      </span>
      <span className={`w-44 shrink-0 truncate ${waiting ? "font-semibold text-slate-900 dark:text-white" : ""}`}>
        {job.company || "(unknown company)"}
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className={waiting ? "font-semibold text-slate-900 dark:text-white" : "text-slate-800 dark:text-slate-200"}>
          {job.title || "(no title)"}
        </span>
        {snippet(job) && <span className="text-slate-500 dark:text-slate-400"> — {snippet(job)}</span>}
      </span>
      {job.scam_flag && (
        <Badge tone="red" title="The agent found no verifiable employer">
          ⚠ scam?
        </Badge>
      )}
      {job.duplicateCompany && (
        <Badge tone="amber" title="Another job at this company is already triaged or further">
          dup
        </Badge>
      )}
      {job.referral && <Badge tone="violet" title={`Referral: ${job.referral}`}>referral</Badge>}
      {job.ats && <Badge>{job.ats}</Badge>}
      {job.track && <Badge>{job.track}</Badge>}
      <time dateTime={job.updated_at} className="w-14 shrink-0 text-right text-xs tabular-nums text-slate-500">
        {relTime(job.updated_at)}
      </time>
    </div>
  );
}
