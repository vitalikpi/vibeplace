import JobCard from "./JobCard.jsx";

export default function Column({ col, jobs, count, onPatch }) {
  return (
    <section className="flex w-80 shrink-0 flex-col rounded-lg bg-slate-200/60 dark:bg-slate-800/60">
      <h2 className="flex items-center justify-between px-3 py-2 text-sm font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
        <span>{col.label}</span>
        <span className="rounded-full bg-slate-300 px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-700 dark:text-slate-200">
          {count}
        </span>
      </h2>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {jobs.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-slate-400 dark:text-slate-500">Empty</p>
        ) : (
          jobs.map((job) => (
            <JobCard key={job.id} job={job} onPatch={onPatch} />
          ))
        )}
      </div>
    </section>
  );
}
