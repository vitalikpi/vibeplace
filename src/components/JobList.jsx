import { canTransition } from "../workflow.js";
import { BULK } from "../lib/actions.js";
import JobRow from "./JobRow.jsx";

// The middle pane: search, select-all / bulk actions, one page of rows, paging.
export default function JobList({
  title,
  page,
  offset,
  pageSize,
  selected,
  cursor,
  openId,
  q,
  searchRef,
  onSearch,
  onToggle,
  onToggleAll,
  onOpen,
  onPage,
  onBulk,
}) {
  const { jobs, total } = page;
  const allChecked = jobs.length > 0 && jobs.every((j) => selected.has(j.id));
  const chosen = jobs.filter((j) => selected.has(j.id));
  const bulk = BULK.filter((b) => chosen.some((j) => canTransition(j.status, b.to, "human")));
  const from = total ? offset + 1 : 0;
  const to = Math.min(offset + pageSize, total);

  return (
    <section aria-label={title} className="flex min-w-0 flex-1 flex-col bg-white dark:bg-slate-900">
      <div className="flex items-center gap-3 border-b border-slate-200 px-3 py-2 dark:border-slate-700">
        <input
          type="checkbox"
          aria-label="Select all on this page"
          checked={allChecked}
          onChange={() => onToggleAll(allChecked ? [] : jobs.map((j) => j.id))}
        />
        {selected.size > 0 ? (
          <div role="toolbar" aria-label="Bulk actions" className="flex items-center gap-1">
            <span className="mr-2 text-sm text-slate-600 dark:text-slate-300">{selected.size} selected</span>
            {bulk.map((b) => (
              <button
                key={b.to}
                onClick={() => onBulk(b.to)}
                className="rounded px-2 py-1 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                {b.label}
              </button>
            ))}
          </div>
        ) : (
          <input
            ref={searchRef}
            type="search"
            value={q}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={`Search ${title.toLowerCase()}…  ( / )`}
            className="w-full max-w-md rounded-full border border-slate-200 bg-slate-100 px-4 py-1.5 text-sm focus:border-blue-400 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:focus:bg-slate-900"
          />
        )}
        <div className="ml-auto flex items-center gap-1 text-xs text-slate-500">
          <span className="tabular-nums">
            {from}–{to} of {total}
          </span>
          <button
            aria-label="Newer"
            disabled={offset === 0}
            onClick={() => onPage(Math.max(0, offset - pageSize))}
            className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
          >
            ‹
          </button>
          <button
            aria-label="Older"
            disabled={to >= total}
            onClick={() => onPage(offset + pageSize)}
            className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
          >
            ›
          </button>
        </div>
      </div>

      <div role="grid" aria-label={`${title} jobs`} className="flex-1 overflow-y-auto">
        {jobs.length === 0 ? (
          <p className="px-6 py-12 text-center text-sm text-slate-400">
            {q ? "No jobs match." : title === "Waiting for me" ? "Nothing is waiting for you. 🎉" : "Empty."}
          </p>
        ) : (
          jobs.map((job, i) => (
            <JobRow
              key={job.id}
              job={job}
              selected={selected.has(job.id)}
              cursor={i === cursor}
              open={job.id === openId}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))
        )}
      </div>
    </section>
  );
}
