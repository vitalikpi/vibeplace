# vibeplace

A desktop app for a job search, laid out like a mail client. Postings come in through
your own bookmarklets, through Claude Code over MCP, or by hand (**＋ New job**). You triage them, Claude-in-Chrome
agents prefill the application forms and hand them back to you, you submit, and Gmail
evidence records the outcome. The full workflow is in [`job-flow.md`](job-flow.md).

## Running the desktop app

```sh
npm install              # also rebuilds native modules for Electron
npm run electron:dev     # Vite on :5173 with hot reload + Electron
npm run electron:start   # build the UI, run the app
npm run dist:mac         # build release/vibeplace-<version>-arm64.dmg (unsigned; `dist` = this)
npm run dist:win         # on Windows: build release/vibeplace Setup <version>.exe (unsigned)
npm test                 # unit + UI tests (Vitest); npm run test:watch to rerun on change
```

### Windows

Install Node 20+ and [Git for Windows](https://git-scm.com/download/win). Git is
optional: it adds Git Bash as a terminal choice (and Claude Code on Windows wants it). The commands above work as they are in cmd, PowerShell or Git Bash. Build the
`.exe` on Windows: node-pty and better-sqlite3 are native modules, so a build from a Mac
would carry the wrong binaries. The installer is unsigned, so SmartScreen asks first
(**More info → Run anyway**).

Tests live in `test/` (UI tests in `test/ui/`, on jsdom). They use in-memory SQLite,
temporary data folders, a fixed time zone (`America/New_York`) and a mocked `electron`
module, so they never touch your data or open a port.

### How it's wired

```
window (React UI) ──IPC: window.tracker──► main process: db.js (SQLite) ──► dock badge,
                                               ▲      │                      notifications
bookmarklets ──► http://127.0.0.1:7085 ────────┤      └── change push ──► window
Claude Code  ──► http://127.0.0.1:7085/mcp ────┘
```

- **UI:** loaded from `dist/` on disk (from Vite on :5173 in dev). It reads and edits
  data only through the preload bridge (`electron/preload.cjs` → `electron/ipc.js`), so
  none of the tracker's data is readable over the network.
- **Live:** every write (UI, MCP, bookmarklet) goes through the main process, which pushes
  a change to the window, keeps the dock badge (the window title on Windows) at the
  "Waiting for me" count, and shows a
  notification when an agent hands a job back.
- **HTTP server:** on `127.0.0.1:7085` ("J0B5"; set `PORT` to override). It has only the
  ingestion routes and MCP. Every request must carry `Host: 127.0.0.1:<port>` or
  `localhost:<port>`, which blocks DNS rebinding.
- **Lifecycle:** on macOS, closing the window leaves the server running. Cmd+Q stops it
  once in-flight requests finish. On Windows, closing the window (or File ▸ Exit) quits
  the app and the server with it.

## Workflow

| Folder | Statuses | Who moves jobs here |
|---|---|---|
| ⏰ Waiting for me | `blocked`, `ready` | an agent hands the job back |
| 📥 New | `new` | bookmarklet, MCP `add_job`, you (**＋ New job**) |
| ✓ Triaged | `triaged` | you or a triage agent |
| ▶ In progress | `in_progress` | you (**Start** or **Unblock**); an agent then holds it |
| ⏸ On hold | `on_hold` | you or an agent |
| 📤 Applied | `applied` | you, the ✅ Submitted bookmarklet, or Gmail |
| 💬 Interviewing | `interviewing` | you or Gmail |
| ✗ Rejected | `rejected` | you or Gmail |
| 🗑 Trash | `trash` | you, or a triage agent (NO-GO) |

The rules live in `electron/workflow.js`. The UI only offers the moves you may make, and
**Move to…** in the reading pane overrides them; the override is recorded on the
timeline. Every move and every agent note is an event in `job_events`. Your own notes
stay in the job's **notes** field, which agents never write.

Shortcuts: `j`/`k` move, `Enter` opens, `x` selects, `e` trashes, `s` starts, `h` holds,
`/` searches, `Esc` closes. With a selection they apply to the whole selection.

## Terminal pane

**Ctrl+`** (or **⌨ Terminal** in the sidebar) opens a plain shell under the tracker, in
the data folder. On macOS it's your login shell (zsh by default). On Windows it's
PowerShell (`pwsh` 7 if it's on PATH) by default; **Git Bash** (found through
`CLAUDE_CODE_GIT_BASH_PATH`, the usual install folders, or `git.exe` on PATH) and
**Command Prompt** can be picked under **Terminal ▸ Shell**. The pick is saved per machine
and applies on the next **Restart**. Run `claude` (or any agent) there yourself and it
picks up the folder's `.mcp.json`, skills and `ANSWERS.md`. Hiding the pane keeps the
session; **Restart** starts a fresh one, and changing the data folder or quitting the app
ends it.

| | macOS | Windows |
|---|---|---|
| Show / hide the pane | ⌃` | Ctrl+` |
| Copy the selection | ⌘C | Ctrl+C (with a selection) or Ctrl+Shift+C |
| Paste | ⌘V | Ctrl+V or Ctrl+Shift+V |
| Interrupt | ⌃C | Ctrl+C (without a selection) |

The shell runs in the main process through `node-pty` (`electron/terminal.js`), drawn by
xterm.js in the window. Like the rest of the UI, it's reachable over IPC only, never over
HTTP. `npm install` makes node-pty's `spawn-helper` executable on macOS/Linux
(`scripts/postinstall.js`), and the packaged app keeps node-pty's native files (including
the Windows ConPTY/winpty binaries) outside the asar archive.

## Data folder

On first launch the app asks for a data folder. It remembers the choice in
`~/Library/Application Support/vibeplace/config.json`, and you can change it later
with **File → Change Data Folder…**. An empty folder starts a fresh tracker, and the
app copies `AGENTS.md` (which teaches a coding agent the tracker's flows and walks a new
user through setup) and a `CLAUDE.md` that imports it (`electron/onboarding/`) into it.
A folder with anything else in it is left alone. The folder layout:

```
<data folder>/
  jobs.db              # SQLite (WAL mode), created on first run
  AGENTS.md, CLAUDE.md # onboarding for the agent in the terminal pane (fresh folders)
  jobs.backup-v1-*.db  # made once if an old (v1) jobs.db was migrated
  resume.txt           # returned by the get_resume MCP tool
  bookmarklets/        # your own *.js bookmarklets (the app ships only ✅ Unblocked)
  settings.json        # optional, see below
```

**Migration from v1:** opening a v1 `jobs.db` (statuses `incoming` / `review` / …)
copies it to `jobs.backup-v1-<date>.db` first, then renames `incoming` → `new` and
`review` → `triaged`. It rebuilds the history as events from the stored timestamps and
moves every existing note into an event.

**Migration to v3:** opening a v2 `jobs.db` copies it to `jobs.backup-v2-<date>.db`,
drops the `linkedin_id` column and rewrites each job's `url` to its canonical posting
URL (`electron/postings.js`). Jobs are deduplicated on that URL: known boards (LinkedIn,
Indeed) ignore tracking params; any other URL must match exactly.

`settings.json`:

```json
{
  "email": "you@example.com",
  "links": [
    { "label": "Portfolio", "value": "https://you.example.com" },
    { "label": "GitHub", "value": "https://github.com/you" }
  ],
  "tracks": ["remote", { "key": "nyc", "label": "NYC" }]
}
```

- **`email`:** the default login for `create_account`.
- **`links`:** copy buttons at the bottom of the sidebar.
- **`tracks`:** your target locations. They label jobs and filter the list. New jobs get
  the first one, and agents may only set configured keys.

The file is re-read on every request, so edits apply without a restart.

## Bookmarklets

The app ships one bookmarklet, **✅ Unblocked**, because it's part of the workflow rather
than tied to a site. When an agent hands an application tab back as blocked, do what it
needed, then press it on that tab. It finds the job by `#<id>` in the tab title (else by
the page URL), asks for an optional short answer, and sends the job back to the agent
through `/act`.

Everything else is user-defined, like Claude Code skills. Every `.js` file in
`bookmarklets/` shows up on the **Bookmarklets** page as a draggable button labeled after
its file name. A file can be readable JS, which the app URL-encodes,
or an already-built `javascript:` URL. Any `127.0.0.1:<port>` / `localhost:<port>` in
it is rewritten to the app's port.

The pages a bookmarklet can open are served by the app itself, so they work on sites
whose Content-Security-Policy blocks requests to localhost:

| Open | Hash (URL-encoded JSON) | Effect |
|---|---|---|
| `/capture#…` | `{url, title?, company?, description?, location?, source?}` | a `new` job |
| `/capture-batch#…` | an array of the above | several jobs |
| `/act#…` | `{op: "unblock" \| "submitted", job_id?, url?, title?, answers?}` | Unblock or mark applied |

`/act` finds the job by `job_id`, then by `#<id>` in `title` (agents prefix the tab title
with it), then by the page `url` against each job's application URL, then its posting
URL. When nothing matches, or several jobs do, the page stays open and says so.

## Claude Code (MCP)

While the app runs, point Claude Code at it in `.mcp.json`:

```json
{ "mcpServers": { "vibeplace": { "type": "http", "url": "http://127.0.0.1:7085/mcp" } } }
```

| Group | Tools |
|---|---|
| read | `list_jobs`, `get_job` (with timeline), `attention`, `stats`, `get_resume` |
| capture / triage | `add_job`, `triage_job(go \| no_go, reason, track?)` |
| apply loop | `queue_next` (leases the job), `update_progress`, `mark_blocked(needs)`, `mark_ready`, `hold_job`, `release_job`, `add_event` |
| outcomes | `record_outcome(applied \| interviewing \| rejected, evidence)` (actor `gmail`) |
| accounts | `get_account`, `create_account` |

There's no tool to Start, Unblock or mark a job applied as an agent; those are yours.
A refused move comes back as a tool error that lists the allowed moves. `/mcp` rejects
any request that carries an `Origin` header, so web pages can't reach it.

## Headless server

To run the capture endpoints and MCP without a window (for tests):

```sh
TRACKER_DATA_ROOT=/path/to/folder PORT=8799 ELECTRON_RUN_AS_NODE=1 npx electron electron/serve.js
```

To run a second, windowed instance next to your real one (its own settings folder and
single-instance lock), add `TRACKER_USER_DATA=/some/empty/folder`.
