// The embedded terminal: one pseudo-terminal running a shell in the data folder, with
// Claude Code started in it. Claude then picks up the folder's .mcp.json (this app's
// MCP), skills and ANSWERS.md. When Claude exits, the same terminal drops into the
// shell, so it can be restarted by hand. macOS/Linux use the login shell; Windows uses
// Git Bash, PowerShell or cmd (the user's pick in Terminal ▸ Shell, saved by main.js).
//
// IPC (behind the same trusted-page check as ipc.js):
//   term:start(cols, rows) → {pid, cwd, shell}   (re)starts the session
//   term:write(data)  term:resize(cols, rows)  term:stop()
//   pushes "term:data" (output) and "term:exit" ({exitCode}) to the page that started it
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ipcMain } from "electron";
import pty from "node-pty";

import { getPaths } from "./config.js";

let session = null; // {proc, sender}

// Windows env names are case-insensitive (Path vs PATH); a plain object isn't.
function envGet(env, name) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase() && env[k]);
  return key ? env[key] : undefined;
}

// The shells this machine can run, in default order. Each is {id, label, file, kind,
// found}; kind is posix | powershell | cmd. Off Windows: just the login shell.
export function detectShells({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (platform !== "win32") {
    return [{ id: "auto", label: "Login shell", file: envGet(env, "SHELL") || "/bin/zsh", kind: "posix", found: true }];
  }
  const w = path.win32;
  const pathDirs = (envGet(env, "PATH") || "").split(";").filter(Boolean);
  const onPath = (exe) => pathDirs.map((d) => w.join(d, exe)).find(exists);
  const sysRoot = envGet(env, "SystemRoot") || "C:\\Windows";
  const under = (base, ...rest) => (base ? w.join(base, ...rest) : null);

  // Git for Windows' bash, never System32\bash.exe (that's the WSL launcher).
  const gitBash = [
    envGet(env, "CLAUDE_CODE_GIT_BASH_PATH"),
    under(envGet(env, "ProgramFiles"), "Git", "bin", "bash.exe"),
    under(envGet(env, "ProgramFiles(x86)"), "Git", "bin", "bash.exe"),
    under(envGet(env, "LOCALAPPDATA"), "Programs", "Git", "bin", "bash.exe"),
    ...pathDirs.filter((d) => exists(w.join(d, "git.exe"))).map((d) => w.join(d, "..", "bin", "bash.exe")),
  ].find((f) => f && exists(f) && !f.toLowerCase().startsWith(w.join(sysRoot, "System32").toLowerCase()));
  const powershell = onPath("pwsh.exe") || w.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const cmd = envGet(env, "ComSpec") || w.join(sysRoot, "System32", "cmd.exe");

  return [
    { id: "gitbash", label: "Git Bash", file: gitBash || null, kind: "posix", found: Boolean(gitBash) },
    { id: "powershell", label: "PowerShell", file: powershell, kind: "powershell", found: exists(powershell) },
    { id: "cmd", label: "Command Prompt", file: cmd, kind: "cmd", found: exists(cmd) },
  ];
}

// The saved choice if it's installed, else the first shell found; null if none is.
export function resolveShell(choice, shells) {
  const found = shells.filter((s) => s.found);
  return found.find((s) => s.id === choice) || found[0] || null;
}

// Run Claude Code first, then stay as an interactive shell. A posix shell starts as a
// login shell (so PATH matches the user's terminal and `claude` is found) and gets its
// own path as $0, so the exec survives spaces (C:\Program Files\Git\…).
export function shellCommand(shell) {
  if (shell.kind === "powershell") return { file: shell.file, args: ["-NoLogo", "-NoExit", "-Command", "claude"] };
  if (shell.kind === "cmd") return { file: shell.file, args: ["/k", "claude"] };
  return { file: shell.file, args: ["-l", "-i", "-c", 'claude; exec "$0" -l -i', shell.file] };
}

// The app's environment minus what only makes sense for Electron itself.
export function shellEnv(base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith("ELECTRON_") || k === "TRACKER_USER_DATA" || k === "TRACKER_DATA_ROOT") continue;
    env[k] = v;
  }
  return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "JobTracker" };
}

const clampSize = (n, dflt) => (Number.isInteger(n) && n > 0 && n < 1000 ? n : dflt);

export function stopTerminal() {
  if (!session) return;
  const { proc } = session;
  session = null;
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
}

function startTerminal(sender, cols, rows, { shellChoice, detect }) {
  stopTerminal();
  const cwd = getPaths().DATA_ROOT || os.homedir();
  const shell = resolveShell(shellChoice(), detect());
  if (!shell) throw new Error("no shell found (install Git for Windows, or check PowerShell / cmd)");
  const { file, args } = shellCommand(shell);
  const proc = pty.spawn(file, args, {
    name: "xterm-256color",
    cols: clampSize(cols, 80),
    rows: clampSize(rows, 24),
    cwd,
    env: shellEnv(),
  });
  const me = { proc, sender };
  session = me;
  proc.onData((data) => {
    if (session === me && !sender.isDestroyed()) sender.send("term:data", data);
  });
  proc.onExit(({ exitCode }) => {
    if (session !== me) return;
    session = null;
    if (!sender.isDestroyed()) sender.send("term:exit", { exitCode });
  });
  sender.once("destroyed", () => session === me && stopTerminal());
  return { pid: proc.pid, cwd, shell: shell.label };
}

// shellChoice() returns the saved Terminal ▸ Shell id (Windows), or undefined;
// detect() lists the installed shells (replaceable in tests).
export function registerTerminalIpc(isTrusted, { shellChoice = () => undefined, detect = () => detectShells() } = {}) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrusted(event.senderFrame?.url || "")) throw new Error(`untrusted sender for ${channel}`);
      return fn(event, ...args);
    });
  handle("term:start", (event, cols, rows) => startTerminal(event.sender, cols, rows, { shellChoice, detect }));
  handle("term:write", (_e, data) => {
    if (session && typeof data === "string") session.proc.write(data);
  });
  handle("term:resize", (_e, cols, rows) => {
    if (session) session.proc.resize(clampSize(cols, 80), clampSize(rows, 24));
  });
  handle("term:stop", () => stopTerminal());
}
