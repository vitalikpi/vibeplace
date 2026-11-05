import { useState } from "react";

// A blocked job's to-do list from the agent. Questions get an answer field; other
// items are ticked off. "Unblock" hands the job back to the agent with the answers.
export default function NeedsList({ needs, onResolve, onUnblock }) {
  const [answers, setAnswers] = useState({});
  const set = (id, v) => setAnswers((a) => ({ ...a, [id]: v }));
  const given = Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim()));

  return (
    <section aria-label="Needs" className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/30">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">
        The agent needs you
      </h3>
      {needs.length === 0 && <p className="text-sm text-slate-600 dark:text-slate-300">Everything is resolved.</p>}
      <ul className="space-y-2">
        {needs.map((n) => (
          <li key={n.id} className="text-sm">
            {n.type === "question" ? (
              <label className="block">
                <span className="mb-1 block font-medium">❓ {n.q || n.text}</span>
                <input
                  value={answers[n.id] || ""}
                  onChange={(e) => set(n.id, e.target.value)}
                  placeholder="Your answer"
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
                />
              </label>
            ) : (
              <label className="flex items-start gap-2">
                <input type="checkbox" onChange={() => onResolve(n.id)} className="mt-1" aria-label={`Done: ${n.text}`} />
                <span>
                  <span className="mr-1 rounded bg-white px-1 text-[11px] uppercase text-slate-500 dark:bg-slate-800">{n.type}</span>
                  {n.text}
                </span>
              </label>
            )}
          </li>
        ))}
      </ul>
      <button
        onClick={() => onUnblock(Object.keys(given).length ? given : undefined)}
        className="mt-3 rounded bg-amber-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber-700"
      >
        Unblock → back to the agent
      </button>
    </section>
  );
}
