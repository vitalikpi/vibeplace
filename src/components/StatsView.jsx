import { useEffect, useState } from "react";
import { getTodayStats } from "../api.js";
import StatsChart from "./StatsChart.jsx";

function Tile({ value, label, tone }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={`text-2xl font-bold ${tone}`}>{value ?? "—"}</span>
      <span className="text-sm text-slate-500 dark:text-slate-400">{label}</span>
    </div>
  );
}

// Today's numbers and the daily chart. `version` changes on every data change.
export default function StatsView({ version }) {
  const [today, setToday] = useState(null);
  useEffect(() => {
    getTodayStats().then(setToday).catch(() => setToday(null));
  }, [version]);
  return (
    <section aria-label="Stats" className="flex-1 overflow-y-auto bg-white p-6 dark:bg-slate-900">
      <h2 className="mb-4 text-lg font-semibold">Stats</h2>
      <div className="mb-6 flex flex-wrap items-center gap-6">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Today</span>
        <Tile value={today?.captured} label="captured" tone="text-slate-800 dark:text-slate-100" />
        <Tile value={today?.applied} label="applied" tone="text-emerald-600 dark:text-emerald-400" />
        <Tile value={today?.trashed} label="trashed" tone="text-rose-600 dark:text-rose-400" />
      </div>
      <StatsChart key={version} />
    </section>
  );
}
