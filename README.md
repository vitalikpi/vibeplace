# Job Tracker

A desktop kanban for a job search. Postings come in through your own bookmarklets or
through Claude Code over MCP, and move through Incoming → Review → Applied → Rejected.

## Running the desktop app

```sh
npm install              # also rebuilds native modules for Electron
npm run electron:dev     # Vite on :5173 with hot reload + Electron
npm run electron:start   # build the UI, run the app
npm run dist             # build release/Job Tracker-<version>-arm64.dmg (unsigned)
```

### How it's wired

```
window (React UI) ──IPC: window.tracker──► main process: db.js (SQLite)
                                               ▲
bookmarklets ──► http://127.0.0.1:8775 ────────┤  /capture, /capture-batch, POST /api/jobs
Claude Code  ──► http://127.0.0.1:8775/mcp ────┘
```

- **UI:** loaded from `dist/` on disk (from Vite on :5173 in dev). It reads and edits
  data only through the preload bridge (`electron/preload.cjs` → `electron/ipc.js`), so
  none of the board's data is readable over the network.
- **HTTP server:** on `127.0.0.1:8775` (set `PORT` to override). It has only the
  ingestion routes and MCP. `POST /api/jobs` is the one cross-origin endpoint: it only
  inserts and answers `{id, duplicateCompany}`. Every request must carry
  `Host: 127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS rebinding.
- **Lifecycle:** on macOS, closing the window leaves the server running. Cmd+Q stops it.

## Data folder

On first launch the app asks for a data folder. It remembers the choice in
`~/Library/Application Support/Job Tracker/config.json`, and you can change it later
with **File → Change Data Folder…**. An empty folder starts a fresh tracker. The
folder layout:

```
<data folder>/
  jobs.db              # SQLite (WAL mode), created on first run
  resume.txt           # returned by the get_resume MCP tool
  bookmarklets/        # your own *.js bookmarklets (the app ships none)
  settings.json        # optional, see below
```

`settings.json`:

```json
{
  "email": "you@example.com",
  "links": [
    { "label": "LinkedIn", "value": "https://www.linkedin.com/in/you/" },
    { "label": "GitHub", "value": "https://github.com/you" }
  ]
}
```

`email` is the default login for `create_account`. `links` fill the **Me** panel; the
button is hidden when there are none. The file is re-read on every request, so edits
apply without a restart.

## Bookmarklets

Bookmarklets are user-defined, like Claude Code skills, and the app ships none. Every
`.js` file in `bookmarklets/` shows up in the **＋ Bookmarklet** panel as a draggable
button labeled after its file name. A file can be readable JS, which the app URL-encodes,
or an already-built `javascript:` URL. Any `127.0.0.1:<port>` / `localhost:<port>` in
it is rewritten to the app's port.

To save a posting, a bookmarklet opens `http://127.0.0.1:8775/capture#<url-encoded JSON>`
with `{url, company, title, body, location, source}`, or `/capture-batch#<JSON array>`
for several. These pages are served by the app itself, so they work on sites whose
Content-Security-Policy blocks requests to localhost.

## Claude Code (MCP)

While the app runs, point Claude Code at it in `.mcp.json`:

```json
{ "mcpServers": { "jobtracker": { "type": "http", "url": "http://127.0.0.1:8775/mcp" } } }
```

Tools: `list_jobs`, `get_job`, `update_job`, `stats`, `get_resume`, `add_job`,
`get_account`, `create_account`. `/mcp` rejects any request that carries an `Origin`
header, and any request whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>`, so
web pages can't reach it.

## Headless server

To run the capture endpoints and MCP without a window (for tests):

```sh
TRACKER_DATA_ROOT=/path/to/folder PORT=8799 ELECTRON_RUN_AS_NODE=1 npx electron electron/serve.js
```

`better-sqlite3` is built for Electron, so run any script that opens the database with
`ELECTRON_RUN_AS_NODE=1 npx electron <script>`, not plain `node`.
