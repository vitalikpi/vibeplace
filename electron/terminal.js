// The embedded terminal: one pseudo-terminal running the user's login shell in the
// data folder, with Claude Code started in it. Claude then picks up the folder's
// .mcp.json (this app's MCP), skills and ANSWERS.md. When Claude exits, the same
// terminal drops into the shell, so it can be restarted by hand.
//
// IPC (behind the same trusted-page check as ipc.js):
//   term:start(cols, rows) → {pid, cwd}   (re)starts the session
//   term:write(data)  term:resize(cols, rows)  term:stop()
//   pushes "term:data" (output) and "term:exit" ({exitCode}) to the page that started it
import os from "node:os";
import { ipcMain } from "electron";
import pty from "node-pty";

import { getPaths } from "./config.js";

let session = null; // {proc, sender}

// The login shell (so PATH matches the user's terminal and `claude` is found), told
// to run Claude Code first and then stay as an interactive shell.
export function shellCommand(shell = process.env.SHELL || "/bin/zsh") {
  return { file: shell, args: ["-l", "-i", "-c", `claude; exec ${shell} -l -i`] };
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

function startTerminal(sender, cols, rows) {
  stopTerminal();
  const cwd = getPaths().DATA_ROOT || os.homedir();
  const { file, args } = shellCommand();
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
  return { pid: proc.pid, cwd };
}

export function registerTerminalIpc(isTrusted) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrusted(event.senderFrame?.url || "")) throw new Error(`untrusted sender for ${channel}`);
      return fn(event, ...args);
    });
  handle("term:start", (event, cols, rows) => startTerminal(event.sender, cols, rows));
  handle("term:write", (_e, data) => {
    if (session && typeof data === "string") session.proc.write(data);
  });
  handle("term:resize", (_e, cols, rows) => {
    if (session) session.proc.resize(clampSize(cols, 80), clampSize(rows, 24));
  });
  handle("term:stop", () => stopTerminal());
}
