import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

const MIN_HEIGHT = 120;

// Claude Code in the data folder, in a pane under the tracker (electron/terminal.js
// runs the shell). The pane stays mounted once opened, so hiding it keeps the session.
export default function TerminalPanel({ open, height, onHeight, onClose }) {
  const box = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const [status, setStatus] = useState("starting"); // starting | running | exited | unavailable
  const bridge = window.tracker?.terminal;

  const start = async () => {
    const term = termRef.current;
    if (!term || !bridge) return;
    term.reset();
    setStatus("starting");
    try {
      fitRef.current.fit();
      await bridge.start(term.cols, term.rows);
      setStatus("running");
      term.focus();
    } catch (e) {
      term.write(`\r\n\x1b[31mCould not start the terminal: ${String(e?.message || e)}\x1b[0m\r\n`);
      setStatus("exited");
    }
  };

  useEffect(() => {
    if (!bridge) {
      setStatus("unavailable");
      return undefined;
    }
    const term = new Terminal({
      fontFamily: "Menlo, Monaco, monospace",
      fontSize: 12,
      cursorBlink: true,
      macOptionIsMeta: true,
      allowProposedApi: false,
      scrollback: 5000,
      theme: { background: "#0f172a", foreground: "#e2e8f0", cursor: "#e2e8f0", selectionBackground: "#334155" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Links open through the app's window-open handler (http(s) only, system browser).
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, "_blank")));
    term.open(box.current);
    termRef.current = term;
    fitRef.current = fit;

    // Cmd+C copies a selection; other Cmd/Ctrl+` combos go to the app menu and the
    // pane toggle instead of the shell.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.metaKey && e.key === "c" && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
        return false;
      }
      if (e.metaKey) return false;
      if (e.ctrlKey && e.key === "`") return false;
      return true;
    });

    const offData = bridge.onData((d) => term.write(d));
    const offExit = bridge.onExit(({ exitCode }) => {
      term.write(`\r\n\x1b[2m[exited with code ${exitCode}; press Restart]\x1b[0m\r\n`);
      setStatus("exited");
    });
    const input = term.onData((d) => bridge.write(d));

    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!box.current?.offsetHeight) return; // hidden
        fit.fit();
        bridge.resize(term.cols, term.rows);
      });
    });
    ro.observe(box.current);

    start();
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
      offData();
      offExit();
      input.dispose();
      bridge.stop();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (open && termRef.current) {
      requestAnimationFrame(() => {
        fitRef.current?.fit();
        termRef.current?.focus();
      });
    }
  }, [open]);

  const startDrag = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev) => onHeight(Math.min(Math.max(startH + startY - ev.clientY, MIN_HEIGHT), window.innerHeight * 0.8));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <section
      aria-label="Claude Code terminal"
      style={{ height }}
      className={`${open ? "flex" : "hidden"} shrink-0 flex-col border-t border-slate-700 bg-slate-900 text-slate-200`}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal"
        onMouseDown={startDrag}
        className="h-1 cursor-row-resize bg-slate-700 hover:bg-blue-500"
      />
      <div className="flex items-center gap-3 px-3 py-1 text-xs">
        <span className="font-semibold">⌨ Claude Code</span>
        <span className="text-slate-400">
          {status === "running" ? "running in the data folder" : status === "unavailable" ? "only inside the app" : status}
        </span>
        <span className="ml-auto flex gap-1">
          <button onClick={start} disabled={!bridge} className="rounded px-2 py-0.5 hover:bg-slate-700 disabled:opacity-40">
            Restart
          </button>
          <button onClick={onClose} aria-label="Hide terminal" title="Hide (⌃`)" className="rounded px-2 py-0.5 hover:bg-slate-700">
            ▾
          </button>
        </span>
      </div>
      <div ref={box} className="min-h-0 flex-1 px-2 pb-1" />
    </section>
  );
}
