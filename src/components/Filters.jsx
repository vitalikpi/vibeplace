import { TRACKS } from "../App.jsx";

export default function Filters({
  track,
  setTrack,
  q,
  setQ,
  showTrash,
  setShowTrash,
  trashCount,
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={track}
        onChange={(e) => setTrack(e.target.value)}
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
      >
        <option value="">All tracks</option>
        {TRACKS.map((t) => (
          <option key={t.key} value={t.key}>
            {t.label}
          </option>
        ))}
      </select>

      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search company / title / text…"
        className="w-64 rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
      />

      <button
        onClick={() => setShowTrash((v) => !v)}
        className={`rounded px-3 py-1 text-sm font-medium ${
          showTrash
            ? "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900"
            : "bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
        }`}
      >
        {showTrash ? "← Back to board" : `Trash (${trashCount})`}
      </button>
    </div>
  );
}
