import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api.js";
import { FOLDERS } from "./workflow.js";
import useKeyboard from "./useKeyboard.js";
import Sidebar from "./components/Sidebar.jsx";
import JobList from "./components/JobList.jsx";
import JobDetail from "./components/JobDetail.jsx";
import StatsView from "./components/StatsView.jsx";
import BookmarkletsView from "./components/BookmarkletsView.jsx";
import TerminalPanel from "./components/TerminalPanel.jsx";

export const PAGE_SIZE = 50;
const errText = (e) => String(e?.message || e);

// Per-viewer UI conveniences; storage can be unavailable, so never rely on it.
function remembered(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function remember(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

// Three panes, Gmail style: folders | one page of jobs | the open job.
// Data comes over IPC (api.js); main pushes a change after every write (UI, MCP,
// bookmarklet), and the list, counts and open job reload from that.
export default function App() {
  const [view, setView] = useState("list"); // list | stats | bookmarklets
  const [folder, setFolder] = useState("waiting");
  const [track, setTrack] = useState(null);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState(""); // q, debounced
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState({ total: 0, jobs: [] });
  const [counts, setCounts] = useState({});
  const [settings, setSettings] = useState({ links: [], tracks: [] });
  const [selected, setSelected] = useState(() => new Set());
  const [cursor, setCursor] = useState(0);
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [version, setVersion] = useState(0); // bumps on every pushed change
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  // The Claude Code pane: mounted on first open, then kept (hiding keeps the session).
  const [termOpen, setTermOpen] = useState(() => remembered("termOpen", false));
  const [termMounted, setTermMounted] = useState(termOpen);
  const [termHeight, setTermHeight] = useState(() => remembered("termHeight", 320));
  const searchRef = useRef(null);
  const openRef = useRef(openId);
  openRef.current = openId;

  const toggleTerminal = useCallback(() => {
    setTermMounted(true);
    setTermOpen((o) => {
      remember("termOpen", !o);
      return !o;
    });
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "`") {
        e.preventDefault();
        toggleTerminal();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleTerminal]);

  const flash = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? "" : t)), 4000);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  // A new folder, track or search starts from the first page with nothing selected.
  useEffect(() => {
    setOffset(0);
    setSelected(new Set());
    setCursor(0);
  }, [folder, track, query]);

  const loadList = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([
        api.listJobs({ folder, track, q: query || null, limit: PAGE_SIZE, offset }),
        api.folderCounts(track),
      ]);
      setPage(p);
      setCounts(c);
      setError("");
    } catch (e) {
      setError(errText(e));
    }
  }, [folder, track, query, offset]);

  const loadDetail = useCallback(async (id) => {
    if (!id) return setDetail(null);
    try {
      setDetail(await api.getJob(id));
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);
  useEffect(() => {
    loadDetail(openId);
  }, [openId, loadDetail]);
  useEffect(() => {
    const load = () => api.getSettings().then(setSettings).catch(() => {});
    load();
    window.addEventListener("focus", load); // settings.json may have been edited
    return () => window.removeEventListener("focus", load);
  }, []);

  useEffect(
    () =>
      api.onChange((change) => {
        setVersion((v) => v + 1);
        loadList();
        if (change.open) {
          setView("list");
          setOpenId(change.open);
        } else if (openRef.current && change.jobIds?.includes(openRef.current)) {
          loadDetail(openRef.current);
        }
      }),
    [loadList, loadDetail]
  );

  // Run an action; show its error as a toast, then refresh what's on screen.
  const run = useCallback(
    async (fn) => {
      try {
        return await fn();
      } catch (e) {
        flash(errText(e));
      } finally {
        loadList();
        if (openRef.current) loadDetail(openRef.current);
      }
    },
    [flash, loadList, loadDetail]
  );

  // Keyboard and bulk actions apply to the selection, else the open job, else the row
  // under the cursor.
  const targets = () => {
    if (selected.size) return [...selected];
    if (openId) return [openId];
    const row = page.jobs[cursor];
    return row ? [row.id] : [];
  };

  const move = (ids, to, opts) =>
    run(async () => {
      if (!ids.length) return;
      if (ids.length === 1) {
        await api.transition(ids[0], to, opts);
      } else {
        const r = await api.bulkTransition(ids, to, opts);
        if (r.refused.length) flash(`${r.moved.length} moved · ${r.refused.length} can't move there`);
      }
      setSelected(new Set());
    });

  const toggle = (id) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const openFolder = (key) => {
    setView("list");
    setFolder(key);
    setOpenId(null);
  };

  useKeyboard(
    {
      j: () => setCursor((c) => Math.min(c + 1, Math.max(page.jobs.length - 1, 0))),
      k: () => setCursor((c) => Math.max(c - 1, 0)),
      Enter: () => page.jobs[cursor] && setOpenId(page.jobs[cursor].id),
      o: () => page.jobs[cursor] && setOpenId(page.jobs[cursor].id),
      x: () => page.jobs[cursor] && toggle(page.jobs[cursor].id),
      e: () => move(targets(), "trash"),
      "#": () => move(targets(), "trash"),
      s: () => move(targets(), "in_progress"),
      h: () => move(targets(), "on_hold"),
      "/": () => searchRef.current?.focus(),
      Escape: () => {
        if (document.activeElement === searchRef.current) searchRef.current.blur();
        else if (openId) setOpenId(null);
        else setSelected(new Set());
      },
    },
    view === "list"
  );

  const folderLabel = FOLDERS.find((f) => f.key === folder)?.label ?? "";

  return (
    <div className="flex h-full bg-slate-100 text-slate-800 dark:bg-slate-950 dark:text-slate-100">
      <Sidebar
        view={view}
        folder={folder}
        counts={counts}
        tracks={settings.tracks}
        track={track}
        links={settings.links}
        onFolder={openFolder}
        onTrack={setTrack}
        onView={setView}
        terminalOpen={termOpen}
        onTerminal={toggleTerminal}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <main className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-tl-2xl shadow-sm">
          {view === "stats" && <StatsView version={version} />}
          {view === "bookmarklets" && <BookmarkletsView />}
          {view === "list" && (
            <>
              <JobList
                title={folderLabel}
                page={page}
                offset={offset}
                pageSize={PAGE_SIZE}
                selected={selected}
                cursor={cursor}
                openId={openId}
                q={q}
                searchRef={searchRef}
                onSearch={setQ}
                onToggle={toggle}
                onToggleAll={(ids) => setSelected(new Set(ids))}
                onOpen={(id) => setOpenId(id === openId ? null : id)}
                onPage={(o) => {
                  setOffset(o);
                  setCursor(0);
                }}
                onBulk={(to) => move([...selected], to)}
              />
              {detail && openId === detail.id && (
                <JobDetail
                  job={detail}
                  tracks={settings.tracks}
                  onTransition={(to, opts) => move([detail.id], to, opts)}
                  onSetFields={(fields) => run(() => api.setFields(detail.id, fields))}
                  onAddNote={(message) => run(() => api.addNote(detail.id, message))}
                  onReveal={() => api.revealPassword(detail.id).catch((e) => (flash(errText(e)), null))}
                  onClose={() => setOpenId(null)}
                />
              )}
            </>
          )}
        </main>
        {termMounted && (
          <TerminalPanel
            open={termOpen}
            height={termHeight}
            onHeight={(h) => {
              setTermHeight(h);
              remember("termHeight", h);
            }}
            onClose={toggleTerminal}
          />
        )}
      </div>
      {(error || toast) && (
        <div role="status" className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-slate-100 dark:text-slate-900">
          {error || toast}
        </div>
      )}
    </div>
  );
}
