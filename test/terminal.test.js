import { EventEmitter } from "node:events";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { tempDataRoot } from "./helpers.js";

// A fake pty process recording what the manager does with it.
const spawned = [];
function fakeProc() {
  const p = {
    pid: 1000 + spawned.length,
    written: [],
    size: null,
    killed: false,
    write: (d) => p.written.push(d),
    resize: (c, r) => (p.size = [c, r]),
    kill: () => (p.killed = true),
    onData: (cb) => (p.emitData = cb),
    onExit: (cb) => (p.emitExit = cb),
  };
  return p;
}
vi.mock("node-pty", () => ({
  default: {
    spawn: vi.fn((file, args, opts) => {
      const p = fakeProc();
      spawned.push({ file, args, opts, proc: p });
      return p;
    }),
  },
}));
const handlers = new Map();
vi.mock("electron", () => ({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } }));

const APP = "file:///app/dist/index.html";
function sender() {
  const s = new EventEmitter();
  s.sent = [];
  s.send = (channel, payload) => s.sent.push([channel, payload]);
  s.isDestroyed = () => false;
  return s;
}
const invoke = (channel, s, ...args) => handlers.get(channel)({ senderFrame: { url: APP }, sender: s }, ...args);

let term;
let root;
beforeAll(async () => {
  term = await import("../electron/terminal.js");
  term.registerTerminalIpc((url) => url.startsWith("file:///app/dist/"));
});
beforeEach(() => {
  term.stopTerminal();
  spawned.length = 0;
  root = tempDataRoot();
});

describe("shell command and environment", () => {
  it("runs Claude Code in a login shell, then stays as an interactive shell", () => {
    expect(term.shellCommand("/bin/zsh")).toEqual({ file: "/bin/zsh", args: ["-l", "-i", "-c", "claude; exec /bin/zsh -l -i"] });
  });
  it("drops Electron's and the tracker's own variables and sets a terminal type", () => {
    const env = term.shellEnv({ PATH: "/usr/bin", HOME: "/h", ELECTRON_RUN_AS_NODE: "1", TRACKER_DATA_ROOT: "/x", TRACKER_USER_DATA: "/y" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/h", TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "JobTracker" });
  });
});

describe("terminal IPC", () => {
  it("starts the shell in the data folder at the requested size", async () => {
    const s = sender();
    const out = await invoke("term:start", s, 120, 30);
    expect(out).toEqual({ pid: 1000, cwd: root });
    expect(spawned[0].opts).toMatchObject({ cwd: root, cols: 120, rows: 30, name: "xterm-256color" });
    expect(spawned[0].args.at(-1)).toMatch(/^claude; exec /);
  });

  it("falls back to 80×24 for bad sizes", async () => {
    await invoke("term:start", sender(), -1, "x");
    expect(spawned[0].opts).toMatchObject({ cols: 80, rows: 24 });
  });

  it("forwards input and resizes to the shell, and output and exit to the page", async () => {
    const s = sender();
    await invoke("term:start", s, 80, 24);
    const p = spawned[0].proc;
    await invoke("term:write", s, "ls\r");
    await invoke("term:write", s, 42); // ignored: not a string
    await invoke("term:resize", s, 100, 40);
    expect(p.written).toEqual(["ls\r"]);
    expect(p.size).toEqual([100, 40]);
    p.emitData("hello");
    p.emitExit({ exitCode: 0 });
    expect(s.sent).toEqual([
      ["term:data", "hello"],
      ["term:exit", { exitCode: 0 }],
    ]);
  });

  it("restarting kills the previous shell, and its late output is dropped", async () => {
    const s = sender();
    await invoke("term:start", s, 80, 24);
    await invoke("term:start", s, 80, 24);
    expect(spawned[0].proc.killed).toBe(true);
    spawned[0].proc.emitData("stale");
    spawned[1].proc.emitData("fresh");
    expect(s.sent).toEqual([["term:data", "fresh"]]);
  });

  it("term:stop and a closed window kill the shell", async () => {
    const s = sender();
    await invoke("term:start", s, 80, 24);
    await invoke("term:stop", s);
    expect(spawned[0].proc.killed).toBe(true);
    const s2 = sender();
    await invoke("term:start", s2, 80, 24);
    s2.emit("destroyed");
    expect(spawned[1].proc.killed).toBe(true);
  });

  it("refuses calls from pages other than the app's own", () => {
    expect(() => handlers.get("term:start")({ senderFrame: { url: "https://evil.example/" }, sender: sender() }, 80, 24)).toThrow(
      /untrusted sender/
    );
    expect(spawned).toHaveLength(0);
  });
});
