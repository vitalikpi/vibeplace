# Tracker v2 — Application Workflow Spec

The tracker moves each job through a pipeline. The human triages, agents prefill application forms, the human submits, and Gmail tracks the outcome. The rules for agents (never submit, never type passwords, leave consents to the human) are in the skill; this spec covers the tracker, its states, data, API and the agent loop.

## 1. State machine

```
new ──triage──▶ triaged ──human "Start"──▶ in_progress ──agent──▶ blocked ──human ✅──▶ in_progress …
 │                │                                                │
 └──▶ trash ◀─────┘                                                └──agent──▶ ready ──human submits──▶ applied
                                                                                              │
                                     on_hold ◀── agent: wall it can't pass / human: park      ├─▶ interviewing ─▶ offer
                                                                                              └─▶ rejected
```

| Status | Set by | Meaning |
|---|---|---|
| `new` | bookmarklet, UI, MCP | URL (required) plus description, if known. Duplicate companies are flagged when the job is created. |
| `triaged` | agent or human | Passed fit, geo, level and duplicate checks. |
| `trash` | agent or human | Rejected at triage. The reason goes in the event log. |
| `in_progress` | human ("Start" button), or the loop after an unblock | A subagent owns the job. At most one subagent per job. |
| `blocked` | agent | Needs the human before the agent can continue. Has a `needs[]` list (see §2). |
| `ready` | agent | Form fully filled and waiting for the human to click Submit. **The agent never submits.** |
| `on_hold` | agent or human | Parked: Greenhouse verification wall, possible scam, retry later, waiting on a referral. |
| `applied` | human (✅ Submitted bookmarklet or UI), or the Gmail watcher | Submitted. Sets `applied_at`. |
| `interviewing` / `offer` / `rejected` | human or the Gmail watcher | Outcome. |

Allowed transitions, per actor kind (`human`, `agent`, `gmail`, `bookmarklet`), live in `electron/workflow.js`. `db.transition()` enforces them for every caller: UI, MCP and bookmarklets. Any non-trash status can move to `on_hold`. Humans can trash anything, agents only at triage (`new` / `triaged`). From `on_hold`, a job can go back to `triaged` or `in_progress`. `trash` restores to `new`. The human can also use **Move to…**, an override recorded on the event. Agents can never set `applied`.

## 2. Data model (`electron/db.js`, `electron/migrate.js`)

New columns on `jobs` (plus `owner` / `lease_until`, the per-job agent lock):

| Column | Type | Purpose |
|---|---|---|
| `apply_url` | TEXT | The employer's application form URL (Workday, Ashby, Greenhouse…), which is often not `url`. |
| `ats` | TEXT | `greenhouse`, `ashby`, `lever`, `workday`, `linkedin`, `successfactors`, `dayforce`, `adp`, `rippling`, `other`. |
| `tab_id` | INTEGER | Chrome tab of the current fill. A hint only; it can go stale. |
| `step` | TEXT | The furthest step reached, e.g. `workday:4/7 Application Questions`. |
| `needs` | TEXT (JSON) | `[{"type":"consent","text":"Privacy dropdown"},{"type":"question","q":"Java level 1–3","answers_ref":146}]`. Types are `account`, `consent`, `question`, `captcha`, `review`, `wrong_page`. |
| `referral` | TEXT | A contact at the company. While it's set, the loop won't start the job until the human clears it. |
| `scam_flag` | INTEGER | 1 means the agent found no verifiable employer. The UI shows a warning. |

New table `job_events`. It replaces overwriting `notes`.

```sql
CREATE TABLE job_events (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  at TEXT NOT NULL,           -- UTC ISO, seconds, +00:00
  actor TEXT NOT NULL,        -- 'human' | 'agent:<name>' | 'gmail' | 'bookmarklet' | 'migration'
  from_status TEXT, to_status TEXT,
  message TEXT,
  data TEXT                   -- JSON: answers, needs, override, evidence
);
```

New table `job_queue` (`id, job_id, kind 'start' | 'unblock', payload, created_at, taken_at, taken_by, done_at`). `transition()` adds a message when a job enters `in_progress` (Start, send back, or Unblock with the answers). `queue_next` takes the oldest message whose job no other agent holds and that has no pending `referral`, and leases the job (default 30 min). A taken message whose lease expired is offered again.

- `notes` becomes a free-text field that only the human edits. Agents write events.
- Passwords live only on `ats_accounts` rows, never in notes or events. The UI fetches one only when you click Show.
- Stats come from the event log (`applied_at` and `rejected` events), not from `updated_at`.
- Migration: versioned with `PRAGMA user_version`. Before touching a v1 database, `VACUUM INTO` copies it to `jobs.backup-v1-<date>.db`. Then `incoming` → `new` and `review` → `triaged`. The history is rebuilt as `migration` events from `created_at` / `applied_at` / `updated_at`, and every existing note becomes an event (notes start empty). There's no `apply_url` / `ats` backfill from notes; those notes are now on the timeline.

## 3. API

The operations are split by who calls them:

- **UI → main process over IPC** (`electron/ipc.js`, as `human`): list (paged, by folder), get (with timeline), transition (Start, Hold, Submitted, Rejected, Interviewing, Trash, Restore, Unblock with answers, Move to… override), bulk transition, set fields (apply_url, ats, track, referral, notes), resolve a need, add a timeline note, reveal the account password.
- **Bookmarklets → HTTP** on `127.0.0.1:7085` (`electron/server.js`):

| Method | Path | Body | Effect |
|---|---|---|---|
| POST | `/api/jobs` (or open `/capture#…`) | `{url, title?, company?, description?, location?, source?}` | Create a `new` job. |
| POST | `/api/act` (or open `/act#…`) | `{op: "unblock" \| "submitted", job_id?, url?, title?, answers?}` | Unblock (`blocked` → `in_progress`, answers queued) or Submitted (→ `applied`). 404 when no job matches, 409 when several do or the move isn't allowed. |

- **Agents → MCP** at `/mcp` (`electron/mcp.js`): `list_jobs`, `get_job`, `attention`, `stats`, `get_resume`, `add_job`, `triage_job`, `queue_next`, `update_progress`, `mark_blocked`, `mark_ready`, `hold_job`, `release_job`, `add_event`, `record_outcome`, `get_account`, `create_account`. There is no agent tool for Start, Unblock or `applied`.

**Bookmarklet requests from ATS pages:**
- The pages are HTTPS and the API is localhost, so the server answers the CORS preflight with `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Private-Network: true`. The `/capture` and `/act` pages avoid CORS entirely: they're served by the app and post same-origin.
- *Deferred:* a shared bookmarklet token, an MCP bearer token, and encrypting stored passwords. Until then, any web page can create or unblock/submit jobs, and any local program can call `/mcp`.
- *Deferred:* `check_ats_budget` (the earlier ATS-budget plan isn't in this repo).

## 4. Tab marking and bookmarklets

**Agent marks the tab** when it sets `blocked` or `ready`. The title becomes `<emoji> #<job_id> <original title>`:
- 🟢 means `ready` (submit).
- 🟡 means `blocked`.
- 🔴 means the agent stopped with an error.

ATS single-page apps (Workday, Ashby) rewrite `document.title`, so the agent also installs a `MutationObserver` on `<title>` that puts the prefix back.

**✅ Unblocked bookmarklet** (ships with the app, `electron/builtin-bookmarklets/unblocked.js`; the others are user-defined in the data folder):
1. It reads `#(\d+)` from `document.title`. If there's no ID, it sends `location.href`.
2. It POSTs to `/api/unblock` with that ID or URL.
3. It can prompt for short answers ("Java level?") and send them as `answers`.
4. The server resolves the job: first by `job_id`, then by `#<id>` in the title, then by `apply_url` host and path, then by the posting `url`. A page can't read its own Chrome tab id, so there's no `tab_id` match.

**✅ Submitted bookmarklet:** works the same way and calls `/api/submitted`.

**Add-job bookmarklet:** posts the current URL plus the selected text as the description to `/api/jobs`.

## 5. Agent loop (Claude Code)

A long-running loop (`/loop` or a Monitor) does the following:

1. **Polls** `queue_next`. For each `start` or `unblock` message:
   - **Skip if busy:** if a subagent already owns the job, leave the message queued. This is the per-job lock.
   - **Pre-flight checks:**
     - `check_ats_budget(ats)`.
     - LinkedIn 429 state. After a 429, don't use LinkedIn; find `apply_url` on the employer's own careers site.
     - `referral` not cleared means skip.
   - **Spawn a fresh subagent.** It must not depend on a previous subagent's memory.
2. **Subagent resume contract:**
   - It reads the job, `apply_url`, `ats`, `step`, `needs` and the event log from the tracker.
   - If `tab_id` still exists in the tab group, it continues there. Otherwise it opens `apply_url` and tells the human if a consent or login has to be redone.
   - It applies `answers` from the unblock message, appends them to ANSWERS.md, and removes the resolved items from `needs`.
   - It ends by calling `mark_ready`, `mark_blocked` (with `needs`) or `on_hold` (with a reason). It never calls `applied`.
3. **Concurrency:**
   - Run at most about 5 subagents at once.
   - Use one shared tab group. Never reset it. If it disappears, stop the batch and report it; never recreate it silently.
4. **Hard stops**, already in the skill: LinkedIn 429, Greenhouse verification code, non-Workday account walls, payment/SSN/ID requests, and citizenship- or clearance-only roles.

## 6. Gmail watcher

- **Runs** on a schedule, or as part of the loop.
- **Searches** the user's inbox for application emails: confirmations, rejections, interview requests and assessments.
- **Matches** each email to a job by company and role. If more than one job could match, it adds an event and leaves the status unchanged.
- **Sets status:**
  - `applied` on a confirmation.
  - `rejected` on a rejection.
  - `interviewing` on a scheduling request or interview invite.
  - Every change also writes an event.
- **Read and classify only.** Replying, scheduling or confirming always needs the human's explicit OK in chat.

## 7. UI

Gmail-style, three panes (`src/App.jsx`):

- **Sidebar folders** follow §1, with counts. **⏰ Waiting for me** (`blocked` + `ready`, oldest first) is the default view, and its count is also the dock badge. The tracks from `settings.json` are filter labels. Stats and Bookmarklets are separate pages.
- **List:** dense rows (checkbox, 🟡/🟢/⏸/▶ mark, company, title, a snippet of the needs or the last event, badges for ATS / track / dup / referral / scam, time), bold while the job waits for you. 50 per page. Bulk actions on the selection. Shortcuts: `j`/`k`, `Enter`, `x`, `e`, `s`, `h`, `/`, `Esc`.
- **Reading pane:** links to the posting and the application, the actions allowed from the current status plus **Move to…**, the needs checklist with answer fields and **Unblock**, editable apply URL / track / ATS / referral, your notes, the account record (password hidden until clicked), the description, and the event timeline (newest first).
- **Live:** the list and the open job reload when anything writes (an agent over MCP, a bookmarklet, another action). A macOS notification fires when an agent hands a job back.

## 8. Open questions

- Should the triage agent also fill `apply_url` (by finding the employer posting) so the apply step can skip LinkedIn?
- Daily target: should the loop stop starting new jobs after N `ready` jobs pile up unsubmitted?
- Is `offer` needed now, or later? *(Decided: later; not in v2.)*
