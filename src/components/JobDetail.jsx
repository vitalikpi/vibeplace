import { useEffect, useState } from "react";
import { STATUSES, STATUS_LABELS } from "../workflow.js";
import { humanActions } from "../lib/actions.js";
import { fullTime, safeHref } from "../lib/format.js";
import Timeline from "./Timeline.jsx";

const field = "w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800";
const label = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";

// A text input that saves on blur (or Enter) when its value changed.
function SavedInput({ value, onSave, ...props }) {
  const [v, setV] = useState(value || "");
  useEffect(() => setV(value || ""), [value]);
  const save = () => {
    if (v !== (value || "")) onSave(v);
  };
  return (
    <input
      {...props}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      className={field}
    />
  );
}

function Link({ href, children }) {
  const safe = safeHref(href);
  if (!safe) return null;
  return (
    <a href={safe} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">
      {children}
    </a>
  );
}

// The reading pane: header, actions, editable fields, notes, the account for this
// employer and the timeline.
export default function JobDetail({ job, tracks, onTransition, onSetFields, onAddNote, onReveal, onClose }) {
  const [notes, setNotes] = useState(job.notes || "");
  const [note, setNote] = useState("");
  const [moveTo, setMoveTo] = useState("");
  const [password, setPassword] = useState(null);
  const [showBody, setShowBody] = useState(false);
  useEffect(() => {
    setNotes(job.notes || "");
    setPassword(null);
    setMoveTo("");
  }, [job.id, job.notes]);

  const actions = humanActions(job.status);
  const trackOptions = [...tracks];
  if (job.track && !tracks.some((t) => t.key === job.track)) trackOptions.push({ key: job.track, label: job.track });
  const leaseLive = job.owner && job.lease_until && new Date(job.lease_until) > new Date();

  return (
    <aside aria-label="Job details" className="flex w-[30rem] shrink-0 flex-col overflow-y-auto border-l border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-slate-500">
              #{job.id} · {STATUS_LABELS[job.status]}
            </p>
            <h2 className="truncate text-lg font-semibold" title={job.company}>
              {job.company || "(unknown company)"}
            </h2>
            <p className="text-sm text-slate-700 dark:text-slate-300">{job.title || "(no title)"}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
            ✕
          </button>
        </div>
        <p className="mt-1 flex flex-wrap gap-x-3 text-sm">
          <Link href={job.url}>Posting ↗</Link>
          <Link href={job.apply_url}>Application ↗</Link>
          {job.location && <span className="text-slate-500">{job.location}</span>}
        </p>
        {(job.duplicateCompany || job.scam_flag || job.referral) && (
          <p className="mt-2 flex flex-wrap gap-2 text-xs">
            {job.duplicateCompany && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">⚠ already applied to this company</span>}
            {job.scam_flag && <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700">⚠ possible scam</span>}
            {job.referral && <span className="rounded bg-violet-100 px-1.5 py-0.5 text-violet-700">referral: {job.referral}</span>}
          </p>
        )}
        <div role="toolbar" aria-label="Actions" className="mt-3 flex flex-wrap gap-1.5">
          {actions.map((a) => (
            <button
              key={a.to}
              onClick={() => onTransition(a.to)}
              className={`rounded px-3 py-1 text-sm font-medium ${
                a.to === "trash"
                  ? "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                  : "bg-slate-100 text-slate-800 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
              }`}
            >
              {a.label}
            </button>
          ))}
          <span className="ml-auto flex items-center gap-1">
            <select
              aria-label="Move to"
              value={moveTo}
              onChange={(e) => setMoveTo(e.target.value)}
              className="rounded border border-slate-300 bg-white px-1 py-1 text-xs dark:border-slate-600 dark:bg-slate-800"
            >
              <option value="">Move to…</option>
              {STATUSES.filter((s) => s !== job.status).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
            {moveTo && (
              <button onClick={() => onTransition(moveTo, { override: true })} className="rounded bg-slate-800 px-2 py-1 text-xs text-white dark:bg-slate-200 dark:text-slate-900">
                Move
              </button>
            )}
          </span>
        </div>
      </header>

      <div className="space-y-5 p-4">
        {job.status === "ready" && (
          <p className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-700 dark:bg-emerald-950/30">
            🟢 The form is filled. Review it in the browser and press Submit yourself, then mark it <strong>Submitted ✓</strong>.
          </p>
        )}
        {(job.owner || job.step) && (
          <p className="text-xs text-slate-500">
            {job.owner && (leaseLive ? `Held by ${job.owner} until ${fullTime(job.lease_until)}. ` : `Last held by ${job.owner} (lease expired). `)}
            {job.step && `Step: ${job.step}.`}
            {job.tab_id != null && ` Tab ${job.tab_id}.`}
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <label className="col-span-2">
            <span className={label}>Application URL</span>
            <SavedInput value={job.apply_url} onSave={(v) => onSetFields({ apply_url: v })} placeholder="https://…" />
          </label>
          <label>
            <span className={label}>Track</span>
            <select value={job.track || ""} onChange={(e) => onSetFields({ track: e.target.value || null })} className={field}>
              <option value="">—</option>
              {trackOptions.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className={label}>ATS</span>
            <SavedInput value={job.ats} onSave={(v) => onSetFields({ ats: v })} placeholder="workday, greenhouse…" />
          </label>
          <label className="col-span-2">
            <span className={label}>Referral (the agent waits while set)</span>
            <SavedInput value={job.referral} onSave={(v) => onSetFields({ referral: v })} placeholder="Contact at the company" />
          </label>
        </div>

        <label className="block">
          <span className={label}>Your notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== (job.notes || "") && onSetFields({ notes })}
            rows={3}
            className={field}
          />
        </label>

        {job.account && (
          <section aria-label="Account">
            <span className={label}>Account ({job.account.tenant})</span>
            <p className="flex items-center gap-2 text-sm">
              <span className="font-mono">{job.account.email}</span>
              <span className="font-mono">{password ?? "••••••••"}</span>
              <button
                onClick={async () => setPassword(password ? null : await onReveal())}
                className="rounded px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
              >
                {password ? "Hide" : "Show"}
              </button>
            </p>
          </section>
        )}

        {job.body && (
          <section>
            <button onClick={() => setShowBody((v) => !v)} className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
              {showBody ? "▾ Hide description" : "▸ Show description"}
            </button>
            {showBody && (
              <pre className="mt-1 max-h-80 overflow-y-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                {job.body}
              </pre>
            )}
          </section>
        )}

        <section>
          <span className={label}>Timeline</span>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (note.trim()) onAddNote(note.trim()).then(() => setNote(""));
            }}
            className="mb-3 flex gap-2"
          >
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add to the timeline…" className={field} />
            <button type="submit" className="rounded bg-slate-100 px-3 text-sm hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700">
              Add
            </button>
          </form>
          <Timeline events={job.events || []} />
        </section>
      </div>
    </aside>
  );
}
