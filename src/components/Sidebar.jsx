import { useState } from "react";
import { kbd } from "../lib/platform.js";
import { FOLDERS } from "../workflow.js";

const ICONS = {
  waiting: "⏰",
  new: "📥",
  triaged: "✓",
  in_progress: "▶",
  on_hold: "⏸",
  applied: "📤",
  interviewing: "💬",
  rejected: "✗",
  trash: "🗑",
};

const item = (active) =>
  `flex w-full items-center gap-2 rounded-r-full px-4 py-1.5 text-left text-sm ${
    active
      ? "bg-blue-100 font-semibold text-blue-900 dark:bg-blue-900/50 dark:text-blue-100"
      : "text-slate-700 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
  }`;

// Folders (one per status, plus "Waiting for me"), track labels, and the other pages.
export default function Sidebar({ view, folder, counts, tracks, track, links, onFolder, onTrack, onView, terminalOpen, onTerminal }) {
  const [copied, setCopied] = useState("");
  const copy = (value) =>
    navigator.clipboard.writeText(value).then(() => {
      setCopied(value);
      setTimeout(() => setCopied((c) => (c === value ? "" : c)), 1200);
    });

  return (
    <nav aria-label="Folders" className="flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto py-3 pr-2">
      <h1 className="mb-2 px-4 text-lg font-bold tracking-tight">Job Tracker</h1>
      {FOLDERS.map((f) => {
        const n = counts[f.key] || 0;
        const active = view === "list" && folder === f.key;
        const loud = f.key === "waiting" && n > 0;
        return (
          <button key={f.key} className={item(active)} onClick={() => onFolder(f.key)} aria-current={active ? "page" : undefined}>
            <span className="w-5 text-center" aria-hidden>
              {ICONS[f.key]}
            </span>
            <span className={`flex-1 ${loud ? "font-semibold" : ""}`}>{f.label}</span>
            {n > 0 && (
              <span
                className={`text-xs tabular-nums ${loud ? "rounded-full bg-amber-500 px-1.5 py-0.5 font-bold text-white" : "text-slate-500"}`}
              >
                {n}
              </span>
            )}
          </button>
        );
      })}

      {tracks.length > 0 && (
        <>
          <h2 className="mt-4 px-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Tracks</h2>
          <button className={item(track === null)} onClick={() => onTrack(null)}>
            <span className="w-5" aria-hidden />
            All tracks
          </button>
          {tracks.map((t) => (
            <button key={t.key} className={item(track === t.key)} onClick={() => onTrack(track === t.key ? null : t.key)}>
              <span className="w-5 text-center" aria-hidden>
                🏷
              </span>
              {t.label}
            </button>
          ))}
        </>
      )}

      <div className="mt-4 border-t border-slate-200 pt-2 dark:border-slate-700">
        <button className={item(view === "stats")} onClick={() => onView("stats")}>
          <span className="w-5 text-center" aria-hidden>
            📈
          </span>
          Stats
        </button>
        <button className={item(view === "bookmarklets")} onClick={() => onView("bookmarklets")}>
          <span className="w-5 text-center" aria-hidden>
            🔖
          </span>
          Bookmarklets
        </button>
        <button className={item(terminalOpen)} onClick={onTerminal} title={`Claude Code in the data folder (${kbd("ctrl+`")})`}>
          <span className="w-5 text-center" aria-hidden>
            ⌨
          </span>
          <span className="flex-1">Claude Code</span>
          <kbd className="text-[10px] text-slate-400">{kbd("ctrl+`")}</kbd>
        </button>
      </div>

      {links.length > 0 && (
        <div className="mt-auto space-y-1 px-4 pt-4">
          {links.map((l) => (
            <button
              key={l.label}
              onClick={() => copy(l.value)}
              title={`Copy ${l.value}`}
              className="block w-full truncate text-left text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            >
              {copied === l.value ? "Copied!" : `⧉ ${l.label}`}
            </button>
          ))}
        </div>
      )}
    </nav>
  );
}
