import { useEffect, useRef, useState } from "react";

// A single draggable javascript: bookmarklet link. React sanitizes javascript:
// hrefs, so we set it directly on the DOM node via a ref.
function BookmarkletLink({ label, code, color }) {
  const ref = useRef(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (ref.current && code) ref.current.setAttribute("href", code);
  }, [code]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can still drag the link */
    }
  };

  return (
    <div className="flex items-center gap-3">
      <a
        ref={ref}
        href="#"
        onClick={(e) => e.preventDefault()}
        draggable="true"
        className={`cursor-grab select-none rounded-md px-4 py-2 text-sm font-semibold text-white shadow active:cursor-grabbing ${color}`}
        title="Drag me to the bookmarks bar"
      >
        {label}
      </a>
      <button
        onClick={copy}
        className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
      >
        {copied ? "Copied!" : "Copy code"}
      </button>
    </div>
  );
}

const COLORS = [
  "bg-blue-600 hover:bg-blue-700",
  "bg-emerald-600 hover:bg-emerald-700",
  "bg-rose-600 hover:bg-rose-700",
  "bg-amber-600 hover:bg-amber-700",
  "bg-violet-600 hover:bg-violet-700",
];

const userHint = (
  <p className="text-xs text-slate-500 dark:text-slate-400">
    Your own bookmarklets: put <code>.js</code> files in the data folder's <code>bookmarklets/</code> and they
    show up here. One can send a posting to <strong>New</strong> by opening <code>/capture#&lt;job JSON&gt;</code>{" "}
    (or <code>/capture-batch#&lt;JSON array&gt;</code>) on this app.
  </p>
);

// The app's built-in workflow bookmarklets, then the user's own (one per .js file in
// the data folder's bookmarklets/).
export default function Bookmarklet({ items = [] }) {
  const builtin = items.filter((b) => b.builtin);
  const own = items.filter((b) => !b.builtin);

  return (
    <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <p className="text-sm text-slate-700 dark:text-slate-200">Drag each button up to your bookmarks bar.</p>

      {builtin.map((b) => (
        <div key={b.file}>
          <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">
            Built in. Press it on an application tab the agent handed back once you've done what it needed;
            the agent picks the job up again.
          </p>
          <BookmarkletLink label={b.label} code={b.code} color="bg-emerald-600 hover:bg-emerald-700" />
        </div>
      ))}

      {own.map((b, i) => (
        <div key={b.file}>
          <p className="mb-1 font-mono text-xs text-slate-500 dark:text-slate-400">{b.file}</p>
          <BookmarkletLink label={b.label} code={b.code} color={COLORS[i % COLORS.length]} />
        </div>
      ))}

      {own.length === 0 && userHint}

      <p className="text-xs text-slate-500 dark:text-slate-400">
        If dragging isn’t allowed, hit “Copy code”, create a bookmark manually, and
        paste the copied code as the URL.
      </p>
    </div>
  );
}
