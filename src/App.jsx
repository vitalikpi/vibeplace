import { useCallback, useEffect, useMemo, useState } from "react";
import { getBookmarklet, getStats, getTodayStats, listJobs, updateJob } from "./api.js";
import Filters from "./components/Filters.jsx";
import Board from "./components/Board.jsx";
import Bookmarklet from "./components/Bookmarklet.jsx";
import StatsChart from "./components/StatsChart.jsx";

export const COLUMNS = [
  { key: "incoming", label: "Incoming" },
  { key: "review", label: "Review" },
  { key: "applied", label: "Applied" },
  { key: "rejected", label: "Rejected" },
];

export const TRACKS = [
  { key: "remote", label: "Remote" },
  { key: "nyc", label: "NYC" },
  { key: "boston", label: "Boston" },
  { key: "sf", label: "SF Bay" },
  { key: "florida", label: "Florida" },
];

export const ME_LINKS = [
  { label: "LinkedIn", value: "https://www.linkedin.com/in/vpianykh/" },
  { label: "GitHub", value: "https://github.com/vitalikpi" },
];

export default function App() {
  const [jobs, setJobs] = useState([]);
  const [stats, setStats] = useState({});
  const [track, setTrack] = useState("");
  const [q, setQ] = useState("");
  const [showTrash, setShowTrash] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [bookmarklet, setBookmarklet] = useState({});
  const [showStats, setShowStats] = useState(false);
  const [today, setToday] = useState(null);
  const [showMe, setShowMe] = useState(false);
  const [copied, setCopied] = useState("");

  const copy = (value) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(value);
      setTimeout(() => setCopied((c) => (c === value ? "" : c)), 1200);
    });
  };

  const toggleStats = () => {
    const next = !showStats;
    setShowStats(next);
    if (next) getTodayStats().then(setToday).catch(() => setToday(null));
  };
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [j, s] = await Promise.all([listJobs({ track, q }), getStats()]);
      setJobs(j);
      setStats(s);
      setError("");
    } catch (e) {
      setError(String(e.message || e));
    }
  }, [track, q]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Fetch the capture bookmarklet source once for the setup panel.
  useEffect(() => {
    getBookmarklet()
      .then((d) => setBookmarklet(d || {}))
      .catch(() => {});
  }, []);

  // Refetch when the window regains focus (e.g. after capturing jobs on LinkedIn).
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const patch = useCallback(async (id, fields) => {
    const updated = await updateJob(id, fields);
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...updated } : j)));
    // Status changes shift column counts / dedup flags, so resync.
    if ("status" in fields) refresh();
  }, [refresh]);

  const byStatus = useMemo(() => {
    const map = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));
    map.trash = [];
    for (const j of jobs) (map[j.status] || (map[j.status] = [])).push(j);
    return map;
  }, [jobs]);

  return (
    <div className="min-h-full bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-bold tracking-tight">Job Tracker</h1>
          <Filters
            track={track}
            setTrack={setTrack}
            q={q}
            setQ={setQ}
            showTrash={showTrash}
            setShowTrash={setShowTrash}
            trashCount={stats.trash || 0}
          />
          <button
            onClick={() => setShowMe((v) => !v)}
            className={`ml-auto rounded px-3 py-1 text-sm font-medium ${
              showMe
                ? "bg-violet-600 text-white"
                : "bg-violet-100 text-violet-700 hover:bg-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:hover:bg-violet-900/60"
            }`}
          >
            Me
          </button>
          <button
            onClick={toggleStats}
            className={`rounded px-3 py-1 text-sm font-medium ${
              showStats
                ? "bg-emerald-600 text-white"
                : "bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:hover:bg-emerald-900/60"
            }`}
          >
            Stats
          </button>
          <button
            onClick={() => setShowSetup((v) => !v)}
            className={`rounded px-3 py-1 text-sm font-medium ${
              showSetup
                ? "bg-blue-600 text-white"
                : "bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:hover:bg-blue-900/60"
            }`}
          >
            ＋ Bookmarklet
          </button>
        </div>
        {error && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">
            API error: {error}. Is the Flask server running on :8765?
          </p>
        )}
        {showMe && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-700 dark:bg-slate-800">
            {ME_LINKS.map((l) => (
              <button
                key={l.label}
                onClick={() => copy(l.value)}
                title="Click to copy"
                className="flex items-baseline gap-2 rounded border border-slate-300 bg-slate-50 px-3 py-1.5 text-left text-sm hover:border-violet-400 hover:bg-violet-50 dark:border-slate-600 dark:bg-slate-900 dark:hover:border-violet-500 dark:hover:bg-violet-900/30"
              >
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {l.label}
                </span>
                <span className="font-mono">{l.value}</span>
                {copied === l.value && (
                  <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Copied!</span>
                )}
              </button>
            ))}
          </div>
        )}
        {showStats && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <div className="flex flex-wrap items-center gap-5">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Today
            </span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-bold text-slate-800 dark:text-slate-100">
                {today ? today.incoming : "—"}
              </span>
              <span className="text-sm text-slate-500 dark:text-slate-400">incoming</span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                {today ? today.applied : "—"}
              </span>
              <span className="text-sm text-slate-500 dark:text-slate-400">applied</span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-bold text-rose-600 dark:text-rose-400">
                {today ? today.trashed : "—"}
              </span>
              <span className="text-sm text-slate-500 dark:text-slate-400">trashed</span>
            </div>
          </div>
          <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-700">
            <StatsChart />
          </div>
          </div>
        )}
        {showSetup && (
          <div className="mt-3">
            <Bookmarklet codes={bookmarklet} />
          </div>
        )}
      </header>

      <main className="p-4">
        {showTrash ? (
          <Board
            columns={[{ key: "trash", label: "Trash" }]}
            byStatus={byStatus}
            stats={stats}
            onPatch={patch}
          />
        ) : (
          <Board
            columns={COLUMNS}
            byStatus={byStatus}
            stats={stats}
            onPatch={patch}
          />
        )}
      </main>
    </div>
  );
}
