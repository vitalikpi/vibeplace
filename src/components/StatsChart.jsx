import { useEffect, useMemo, useState } from "react";
import { getDailyStats } from "../api.js";

// Fixed categorical order (slots 1-3); colors live in index.css as --series-*.
const SERIES = [
  { key: "incoming", label: "Incoming", color: "var(--series-1)" },
  { key: "applied", label: "Applied", color: "var(--series-2)" },
  { key: "rejected", label: "Rejected", color: "var(--series-3)" },
];

const RANGES = [
  { key: 14, label: "14d" },
  { key: 30, label: "30d" },
  { key: 0, label: "All" },
];

const W = 760;
const H = 200;
const PAD = { top: 12, right: 72, bottom: 24, left: 36 };

function niceMax(v) {
  if (v <= 5) return 5;
  const step = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / step) * step;
}

const fmtDay = (iso) =>
  new Date(iso + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });

export default function StatsChart() {
  const [range, setRange] = useState(30);
  const [data, setData] = useState([]);
  const [hover, setHover] = useState(null);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    getDailyStats(range || undefined).then(setData).catch(() => setData([]));
  }, [range]);

  const { x, y, yMax, ticks } = useMemo(() => {
    const max = niceMax(Math.max(1, ...data.flatMap((d) => SERIES.map((s) => d[s.key]))));
    const iw = W - PAD.left - PAD.right;
    const ih = H - PAD.top - PAD.bottom;
    const n = Math.max(1, data.length - 1);
    return {
      x: (i) => PAD.left + (i / n) * iw,
      y: (v) => PAD.top + ih - (v / max) * ih,
      yMax: max,
      ticks: [0, max / 4, max / 2, (3 * max) / 4, max],
    };
  }, [data]);

  const totals = useMemo(() => {
    const t = { incoming: 0, applied: 0, rejected: 0 };
    for (const d of data) for (const s of SERIES) t[s.key] += d[s.key];
    const active = data.filter((d) => d.applied > 0).length;
    return { ...t, active, perActive: active ? t.applied / active : 0 };
  }, [data]);

  if (!data.length) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">No data yet.</p>;
  }

  // Label every ~7th day so the axis never crowds.
  const every = Math.max(1, Math.ceil(data.length / 8));
  const last = data.length - 1;

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.left) / (W - PAD.left - PAD.right)) * last);
    setHover(Math.min(last, Math.max(0, i)));
  };

  // End labels: nudge apart when lines finish close together.
  const ends = SERIES.map((s) => ({ ...s, v: data[last][s.key], py: y(data[last][s.key]) }))
    .sort((a, b) => a.py - b.py);
  for (let i = 1; i < ends.length; i++) {
    if (ends[i].py - ends[i - 1].py < 12) ends[i].py = ends[i - 1].py + 12;
  }

  const h = hover != null ? data[hover] : null;

  return (
    <div className="viz-root w-full">
      <div className="mb-2 flex flex-wrap items-center gap-4">
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                range === r.key
                  ? "bg-slate-800 text-white dark:bg-slate-100 dark:text-slate-900"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="flex gap-3 text-xs text-slate-600 dark:text-slate-300">
          {SERIES.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} />
              {s.label} <span className="font-semibold">{totals[s.key]}</span>
            </span>
          ))}
        </div>
        <div className="flex gap-4 text-xs text-slate-500 dark:text-slate-400">
          <span>
            Apply rate <span className="font-semibold text-slate-700 dark:text-slate-200">
              {totals.incoming ? Math.round((100 * totals.applied) / totals.incoming) : 0}%
            </span>
          </span>
          <span>
            Avg/active day <span className="font-semibold text-slate-700 dark:text-slate-200">
              {totals.perActive.toFixed(1)}
            </span>
          </span>
          <span>
            Rejection rate <span className="font-semibold text-slate-700 dark:text-slate-200">
              {totals.applied ? Math.round((100 * totals.rejected) / totals.applied) : 0}%
            </span>
          </span>
        </div>
        <button
          onClick={() => setShowTable((v) => !v)}
          className="ml-auto text-xs text-slate-500 underline hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
        >
          {showTable ? "Chart" : "Table"}
        </button>
      </div>

      {showTable ? (
        <div className="max-h-60 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500 dark:text-slate-400">
              <tr>
                <th className="py-1">Date</th>
                {SERIES.map((s) => <th key={s.key} className="py-1 text-right">{s.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().map((d) => (
                <tr key={d.date} className="border-t border-slate-100 dark:border-slate-700">
                  <td className="py-0.5">{fmtDay(d.date)}</td>
                  {SERIES.map((s) => <td key={s.key} className="py-0.5 text-right tabular-nums">{d[s.key]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="h-auto w-full"
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
            role="img"
            aria-label="Daily incoming, applied and rejected jobs"
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth="1" />
                <text x={PAD.left - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--text-muted)">
                  {Math.round(t)}
                </text>
              </g>
            ))}
            {data.map((d, i) =>
              (i % every === 0 && last - i >= every / 2) || i === last ? (
                <text key={d.date} x={x(i)} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--text-muted)">
                  {fmtDay(d.date)}
                </text>
              ) : null
            )}
            {h && (
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--text-muted)" strokeWidth="1" strokeDasharray="3 3" />
            )}
            {SERIES.map((s) => (
              <polyline
                key={s.key}
                points={data.map((d, i) => `${x(i)},${y(d[s.key])}`).join(" ")}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {h &&
              SERIES.map((s) => (
                <circle key={s.key} cx={x(hover)} cy={y(h[s.key])} r="4" fill={s.color} stroke="var(--surface)" strokeWidth="2" />
              ))}
            {ends.map((e) => (
              <text key={e.key} x={W - PAD.right + 8} y={e.py + 3} fontSize="10" fill="var(--text-secondary)">
                {e.label} {e.v}
              </text>
            ))}
          </svg>
          {h && (
            <div
              className="pointer-events-none absolute top-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs shadow dark:border-slate-600 dark:bg-slate-800"
              style={{
                left: `${(x(hover) / W) * 100}%`,
                transform: hover > last / 2 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
              }}
            >
              <div className="mb-0.5 font-semibold">{fmtDay(h.date)}</div>
              {SERIES.map((s) => (
                <div key={s.key} className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                  <span className="text-slate-500 dark:text-slate-400">{s.label}</span>
                  <span className="ml-auto pl-3 font-semibold tabular-nums">{h[s.key]}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
