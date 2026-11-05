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

export default function Bookmarklet({ codes }) {
  const { add, dismiss, scrape } = codes || {};

  if (!add && !dismiss && !scrape) {
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Bookmarklet source not found (expected <code>add-job.js</code> /{" "}
        <code>dismiss-jobs.js</code> one level up from <code>tracker/</code>).
      </p>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <p className="text-sm text-slate-700 dark:text-slate-200">
        Drag each button up to your bookmarks bar.
      </p>

      {add && (
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Add Job → sends the current LinkedIn posting to <strong>Incoming</strong>
          </p>
          <BookmarkletLink label="＋ Add Job" code={add} color="bg-blue-600 hover:bg-blue-700" />
        </div>
      )}

      {scrape && (
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Scrape Page → opens each job on the search page, grabs its full description,
            sends it to <strong>Incoming</strong>, then dismisses it. Runs slowly
            (5–15s between jobs); click the badge to stop.
          </p>
          <BookmarkletLink label="⟳ Scrape Page" code={scrape} color="bg-emerald-600 hover:bg-emerald-700" />
        </div>
      )}

      {dismiss && (
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Dismiss Shown → clicks the ✕ on every job currently visible on the LinkedIn
            page (no request to the tracker)
          </p>
          <BookmarkletLink label="✕ Dismiss Shown" code={dismiss} color="bg-rose-600 hover:bg-rose-700" />
        </div>
      )}

      <p className="text-xs text-slate-500 dark:text-slate-400">
        If dragging isn’t allowed, hit “Copy code”, create a bookmark manually, and
        paste the copied code as the URL.
      </p>
    </div>
  );
}
