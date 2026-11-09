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
// What the IPC handlers see: the saved choice and the installed shells.
const machine = { choice: undefined, shells: null };
beforeAll(async () => {
  term = await import("../electron/terminal.js");
  term.registerTerminalIpc((url) => url.startsWith("file:///app/dist/"), {
    shellChoice: () => machine.choice,
    detect: () => machine.shells ?? term.detectShells({ platform: "darwin", env: { SHELL: "/bin/zsh" } }),
  });
});
beforeEach(() => {
  machine.choice = undefined;
  machine.shells = null;
  term.stopTerminal();
  spawned.length = 0;
  root = tempDataRoot();
});

// Fake Windows machine: env plus the set of files that exist.
const WIN_ENV = {
  SystemRoot: "C:\\Windows",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
  Path: "C:\\Windows\\System32;C:\\Tools\\Git\\cmd",
};
const PS51 = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const onWindows = (files, env = WIN_ENV) => {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return term.detectShells({ platform: "win32", env, exists: (f) => set.has(f.toLowerCase()) });
};
const byId = (shells) => Object.fromEntries(shells.map((s) => [s.id, s]));

describe("shell detection", () => {
  it("uses the login shell off Windows, falling back to zsh", () => {
    expect(term.detectShells({ platform: "darwin", env: { SHELL: "/bin/bash" } })).toEqual([
      { id: "auto", label: "Login shell", file: "/bin/bash", kind: "posix", found: true },
    ]);
    expect(term.detectShells({ platform: "linux", env: {} })[0].file).toBe("/bin/zsh");
  });

  it("finds Git Bash, PowerShell and cmd on Windows, in that default order", () => {
    const shells = onWindows(["C:\\Program Files\\Git\\bin\\bash.exe", PS51, WIN_ENV.ComSpec]);
    expect(shells.map((s) => [s.id, s.kind, s.found])).toEqual([
      ["gitbash", "posix", true],
      ["powershell", "powershell", true],
      ["cmd", "cmd", true],
    ]);
    expect(shells[0].file).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(term.resolveShell(undefined, shells).id).toBe("gitbash");
  });

  it("prefers CLAUDE_CODE_GIT_BASH_PATH, then a git.exe on PATH", () => {
    const custom = "D:\\Git\\bin\\bash.exe";
    const env = { ...WIN_ENV, CLAUDE_CODE_GIT_BASH_PATH: custom };
    expect(byId(onWindows([custom, "C:\\Program Files\\Git\\bin\\bash.exe"], env)).gitbash.file).toBe(custom);
    expect(byId(onWindows(["C:\\Tools\\Git\\cmd\\git.exe", "C:\\Tools\\Git\\bin\\bash.exe"])).gitbash.file).toBe(
      "C:\\Tools\\Git\\bin\\bash.exe"
    );
  });

  it("never takes System32\\bash.exe (WSL) for Git Bash", () => {
    const env = { ...WIN_ENV, CLAUDE_CODE_GIT_BASH_PATH: "C:\\Windows\\System32\\bash.exe" };
    expect(byId(onWindows(["C:\\Windows\\System32\\bash.exe", PS51], env)).gitbash).toMatchObject({ found: false, file: null });
  });

  it("prefers pwsh on PATH over Windows PowerShell, with case-insensitive env names", () => {
    const env = { ...WIN_ENV, Path: undefined, PATH: "C:\\Program Files\\PowerShell\\7" };
    expect(byId(onWindows(["C:\\Program Files\\PowerShell\\7\\pwsh.exe", PS51], env)).powershell.file).toBe(
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
    );
    expect(byId(onWindows([PS51])).powershell.file).toBe(PS51);
  });

  it("resolves the saved choice if installed, else the first shell found", () => {
    const shells = onWindows([PS51, WIN_ENV.ComSpec]);
    expect(term.resolveShell("cmd", shells).id).toBe("cmd");
    expect(term.resolveShell("gitbash", shells).id).toBe("powershell");
    expect(term.resolveShell(undefined, onWindows([]))).toBeNull();
  });
});

describe("shell command and environment", () => {
  it("runs Claude Code in a login shell, then execs the same shell ($0) interactively", () => {
    expect(term.shellCommand({ kind: "posix", file: "/bin/zsh" })).toEqual({
      file: "/bin/zsh",
      args: ["-l", "-i", "-c", 'claude; exec "$0" -l -i', "/bin/zsh"],
    });
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
    expect(term.shellCommand({ kind: "posix", file: bash }).args.at(-1)).toBe(bash);
  });
  it("keeps PowerShell and cmd open after Claude Code", () => {
    expect(term.shellCommand({ kind: "powershell", file: "pwsh.exe" })).toEqual({
      file: "pwsh.exe",
      args: ["-NoLogo", "-NoExit", "-Command", "claude"],
    });
    expect(term.shellCommand({ kind: "cmd", file: "cmd.exe" })).toEqual({ file: "cmd.exe", args: ["/k", "claude"] });
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
    expect(out).toEqual({ pid: 1000, cwd: root, shell: "Login shell" });
    expect(spawned[0].opts).toMatchObject({ cwd: root, cols: 120, rows: 30, name: "xterm-256color" });
    expect(spawned[0].args).toContain('claude; exec "$0" -l -i');
  });

  it("starts the saved shell choice (Windows)", async () => {
    machine.shells = onWindows(["C:\\Program Files\\Git\\bin\\bash.exe", PS51, WIN_ENV.ComSpec]);
    machine.choice = "cmd";
    expect((await invoke("term:start", sender(), 80, 24)).shell).toBe("Command Prompt");
    expect(spawned[0]).toMatchObject({ file: WIN_ENV.ComSpec, args: ["/k", "claude"] });
  });

  it("says so when no shell is installed", async () => {
    machine.shells = onWindows([]);
    expect(() => invoke("term:start", sender(), 80, 24)).toThrow(/no shell found/);
    expect(spawned).toHaveLength(0);
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
