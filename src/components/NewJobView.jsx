import { useState } from "react";

const field = "w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800";
const label = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";

const EMPTY = { url: "", company: "", title: "", location: "", description: "" };

// A job typed in by hand. It lands in New like a bookmarklet capture; a posting URL
// that's already tracked refreshes that job instead.
export default function NewJobView({ tracks, onCreate, onCancel }) {
  const [form, setForm] = useState(EMPTY);
  const [track, setTrack] = useState(tracks[0]?.key ?? "");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const ready = form.url.trim() || form.title.trim();

  const submit = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      await onCreate({ ...form, track: track || null });
    } finally {
      setBusy(false);
    }
  };

  const input = (key, text, props = {}) => (
    <label className="block">
      <span className={label}>{text}</span>
      <input {...props} value={form[key]} onChange={set(key)} className={field} />
    </label>
  );

  return (
    <section aria-label="New job" className="flex-1 overflow-y-auto bg-white p-6 dark:bg-slate-900">
      <h2 className="mb-4 text-lg font-semibold">New job</h2>
      <form onSubmit={submit} className="max-w-2xl space-y-3">
        {input("url", "Posting URL", { type: "url", placeholder: "https://…", autoFocus: true })}
        <div className="grid grid-cols-2 gap-3">
          {input("company", "Company")}
          {input("title", "Title")}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {input("location", "Location")}
          <label className="block">
            <span className={label}>Track</span>
            <select value={track} onChange={(e) => setTrack(e.target.value)} className={field}>
              <option value="">(none)</option>
              {tracks.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block">
          <span className={label}>Description</span>
          <textarea value={form.description} onChange={set("description")} rows={10} className={field} />
        </label>
        <div className="flex items-center gap-2 pt-1">
          <button
            type="submit"
            disabled={!ready || busy}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Add job
          </button>
          <button type="button" onClick={onCancel} className="rounded px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">
            Cancel
          </button>
          <span className="text-xs text-slate-500">A posting URL or a title is required.</span>
        </div>
      </form>
    </section>
  );
}
