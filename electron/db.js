// SQLite storage for the job tracker. Source of truth for all jobs.
// better-sqlite3 with one shared connection, opened by initDb(). Status changes go
// through transition(), which enforces workflow.js and writes the event log.
import crypto from "node:crypto";
import Database from "better-sqlite3";

import { migrate } from "./migrate.js";
import {
  COMMITTED,
  QUEUE_ON_ENTER,
  STATUSES,
  FOLDERS,
  actorKind,
  allowedTargets,
  canTransition,
} from "./workflow.js";

// Aggregators / job-board reposters that list other companies' jobs under their own
// name and never name the end employer. New captures from these are filed straight to
// trash (recoverable) instead of cluttering New or spending triage on them.
// Match is on the normalized (lower-cased, trimmed) company name — exact, not substring,
// so an unrelated real company with a similar name is not caught by accident.
export const COMPANY_BLACKLIST = new Set([
  "talenthop",
  "remotehunter",
  "haystack",
  "jobot",
  "scoutbetter",
  "fonzi ai",
]);

export class TransitionError extends Error {
  constructor(message, { code, allowed = [] } = {}) {
    super(message);
    this.name = "TransitionError";
    this.code = code; // 'not_found' | 'not_allowed' | 'bad_status' | 'owned'
    this.allowed = allowed;
  }
}

let db = null;
const listeners = new Set();

// Called after every committed write with {kind, jobId, to?, actor?}; kind is one of
// created | updated | transition | event | queue.
export function onChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit(changes) {
  for (const c of changes) for (const cb of listeners) cb(c);
}

// UTC with whole seconds and an explicit offset ("2026-11-05T14:03:22+00:00"), the
// format existing databases use. Timestamps are compared as strings, so
// toISOString()'s "...22.123Z" must never be stored.
function isoSeconds(date) {
  return date.toISOString().slice(0, 19) + "+00:00";
}

const nowIso = () => isoSeconds(new Date());
const minutesFromNow = (m) => isoSeconds(new Date(Date.now() + m * 60_000));

export function initDb(dbPath) {
  if (db) return db;
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db, dbPath);
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
  listeners.clear();
}

function conn() {
  if (!db) throw new Error("database not initialised (call initDb first)");
  return db;
}

const normCompany = (name) => (name || "").trim().toLowerCase();
const str = (v, dflt = "") => String(v || dflt).trim();

export function linkedinIdFromUrl(url) {
  if (!url) return null;
  const m = /\/jobs\/view\/(\d+)/.exec(url);
  return m ? m[1] : null;
}

// Return the lower-cased host of an http(s) URL (the default account key), or null.
// E.g. 'nvidia.wd5.myworkdayjobs.com' for a Workday tenant.
export function accountHostFromUrl(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

const ATS_HOSTS = [
  [/(^|\.)myworkdayjobs\.com$|(^|\.)myworkdaysite\.com$/, "workday"],
  [/(^|\.)greenhouse\.io$/, "greenhouse"],
  [/(^|\.)ashbyhq\.com$/, "ashby"],
  [/(^|\.)lever\.co$/, "lever"],
  [/(^|\.)linkedin\.com$/, "linkedin"],
  [/(^|\.)successfactors\.(com|eu)$/, "successfactors"],
  [/(^|\.)dayforcehcm\.com$/, "dayforce"],
  [/(^|\.)adp\.com$/, "adp"],
  [/(^|\.)rippling\.com$/, "rippling"],
];

// ATS name for an application URL, from its host; null if the URL doesn't parse.
export function atsFromUrl(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return ATS_HOSTS.find(([re]) => re.test(host))?.[1] ?? "other";
}

function committedCompanies() {
  const rows = conn()
    .prepare(
      `SELECT DISTINCT company FROM jobs WHERE status IN (${COMMITTED.map(() => "?").join(",")}) AND company <> ''`
    )
    .all(...COMMITTED);
  return new Set(rows.map((r) => normCompany(r.company)));
}

// Plain row → API shape: scam_flag as a boolean, duplicateCompany flagged for rows that aren't
// themselves committed while another row with the same company is.
function decorate(row, committed) {
  if (!row) return null;
  const c = normCompany(row.company);
  return {
    ...row,
    scam_flag: Boolean(row.scam_flag),
    duplicateCompany: Boolean(c && committed.has(c) && !COMMITTED.includes(row.status)),
  };
}

function insertEvent(c, jobId, { actor, from = null, to = null, message = null, at = nowIso() }) {
  c.prepare(
    `INSERT INTO job_events (job_id, at, actor, from_status, to_status, message)
       VALUES (?,?,?,?,?,?)`
  ).run(jobId, at, actor, from, to, message);
}

// Insert a job (bookmarklet, MCP, UI), or refresh the captured fields of the row
// with the same LinkedIn id / URL. Returns {id, duplicateCompany, created}.
export function addJob(data, { actor = "bookmarklet", track = null } = {}) {
  const url = str(data.url);
  const company = str(data.company);
  const title = str(data.title);
  const body = str(data.body || data.description);
  const location = str(data.location);
  const source = str(data.source, "linkedin");
  const lid = linkedinIdFromUrl(url);
  const now = nowIso();

  const out = conn().transaction(() => {
    const c = conn();
    let existing;
    if (lid) existing = c.prepare("SELECT id FROM jobs WHERE linkedin_id = ?").get(lid);
    if (!existing && url) existing = c.prepare("SELECT id FROM jobs WHERE url = ?").get(url);

    let id;
    let created = false;
    if (existing) {
      // Refresh the captured fields but keep status, track, notes and history.
      c.prepare(
        `UPDATE jobs SET url=?, company=?, title=?, body=COALESCE(NULLIF(?, ''), body), location=?,
           source=?, updated_at=? WHERE id=?`
      ).run(url, company, title, body, location, source, now, existing.id);
      id = existing.id;
    } else {
      // Blacklisted aggregators go straight to trash (recoverable) so they never
      // reach New or triage; everything else starts in New.
      const blacklisted = COMPANY_BLACKLIST.has(normCompany(company));
      const info = c
        .prepare(
          `INSERT INTO jobs (linkedin_id, url, company, title, location, body, source, track,
             status, notes, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,'new','',?,?)`
        )
        .run(lid, url, company, title, location, body, source, track, now, now);
      id = Number(info.lastInsertRowid);
      created = true;
      insertEvent(c, id, { actor, to: "new", message: "captured", at: now });
      if (blacklisted) {
        c.prepare("UPDATE jobs SET status='trash' WHERE id=?").run(id);
        insertEvent(c, id, { actor, from: "new", to: "trash", message: "blacklisted: " + company, at: now });
      }
    }
    const dup = company ? committedCompanies().has(normCompany(company)) : false;
    return { id, duplicateCompany: dup, created };
  })();
  emit([{ kind: out.created ? "created" : "updated", jobId: out.id }]);
  return out;
}

export function getJob(id) {
  const row = conn().prepare("SELECT * FROM jobs WHERE id=?").get(id);
  return row ? decorate(row, committedCompanies()) : null;
}

export function listEvents(jobId) {
  return conn().prepare("SELECT * FROM job_events WHERE job_id=? ORDER BY at, id").all(jobId);
}

// Job + its event timeline, for the detail pane and get_job.
export function getJobDetail(id) {
  const job = getJob(id);
  return job ? { ...job, events: listEvents(id) } : null;
}

function searchClause(q, args) {
  if (!q) return "";
  const like = `%${q}%`;
  args.push(like, like, like);
  return " AND (company LIKE ? OR title LIKE ? OR body LIKE ?)";
}

// Full rows for MCP (optionally without body), newest activity first.
export function listJobs({ status = null, track = null, q = null } = {}) {
  let sql = "SELECT * FROM jobs WHERE 1=1";
  const args = [];
  if (status) {
    sql += " AND status = ?";
    args.push(status);
  }
  if (track) {
    sql += " AND track = ?";
    args.push(track);
  }
  sql += searchClause(q, args);
  sql += " ORDER BY COALESCE(updated_at, created_at) DESC, id DESC";
  const committed = committedCompanies();
  return conn()
    .prepare(sql)
    .all(...args)
    .map((r) => decorate(r, committed));
}

const folderStatuses = (folder) => FOLDERS.find((f) => f.key === folder)?.statuses ?? null;

// The list pane: one page of light rows (no body) for a folder, plus the total.
// "waiting" sorts oldest first (longest-waiting on top); other folders newest first.
export function listJobSummaries({ folder = "new", track = null, q = null, limit = 50, offset = 0 } = {}) {
  const statuses = folderStatuses(folder);
  if (!statuses) throw new Error(`unknown folder ${folder}`);
  const args = [...statuses];
  let where = `status IN (${statuses.map(() => "?").join(",")})`;
  if (track) {
    where += " AND track = ?";
    args.push(track);
  }
  where += searchClause(q, args);
  const order = folder === "waiting" ? "ASC" : "DESC";
  const c = conn();
  const total = c.prepare(`SELECT COUNT(*) FROM jobs WHERE ${where}`).pluck().get(...args);
  const rows = c
    .prepare(
      `SELECT id, company, title, location, url, apply_url, ats, track, status, created_at,
              updated_at, applied_at, referral, scam_flag, owner, lease_until, tab_id, step,
              (SELECT message FROM job_events e WHERE e.job_id = jobs.id AND e.message IS NOT NULL
                 ORDER BY e.at DESC, e.id DESC LIMIT 1) AS last_event
         FROM jobs WHERE ${where}
         ORDER BY COALESCE(updated_at, created_at) ${order}, id ${order}
         LIMIT ? OFFSET ?`
    )
    .all(...args, Math.max(1, limit), Math.max(0, offset));
  const committed = committedCompanies();
  return { total, jobs: rows.map((r) => decorate(r, committed)) };
}

// Sidebar counts per folder (optionally within one track).
export function folderCounts({ track = null } = {}) {
  const args = [];
  let sql = "SELECT status, COUNT(*) AS n FROM jobs";
  if (track) {
    sql += " WHERE track = ?";
    args.push(track);
  }
  const byStatus = Object.fromEntries(
    conn()
      .prepare(sql + " GROUP BY status")
      .all(...args)
      .map((r) => [r.status, r.n])
  );
  return Object.fromEntries(FOLDERS.map((f) => [f.key, f.statuses.reduce((n, s) => n + (byStatus[s] || 0), 0)]));
}

export function stats() {
  const rows = conn().prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all();
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

// Move a job to `to`. Enforces workflow.js for the actor's kind unless a human
// passes override. Side effects, all in one transaction:
//   - applied_at set the first time the job reaches 'applied'
//   - entering in_progress from triaged/on_hold/ready/blocked queues start/unblock
//   - leaving in_progress drops the owner and closes the job's open queue messages
// Returns the updated job. Throws TransitionError.
export function transition(jobId, to, { actor = "human", message = null, override = false } = {}) {
  const kind = actorKind(actor);
  if (!STATUSES.includes(to)) throw new TransitionError(`unknown status ${to}`, { code: "bad_status" });
  if (!kind) throw new TransitionError(`unknown actor ${actor}`, { code: "not_allowed" });
  const now = nowIso();

  const job = conn().transaction(() => {
    const c = conn();
    const row = c.prepare("SELECT id, status, applied_at FROM jobs WHERE id=?").get(jobId);
    if (!row) throw new TransitionError(`job ${jobId} not found`, { code: "not_found" });
    const from = row.status;
    const forced = override && kind === "human";
    if (from === to || (!forced && !canTransition(from, to, kind))) {
      const allowed = allowedTargets(from, kind);
      throw new TransitionError(
        `cannot move job ${jobId} from ${from} to ${to} as ${kind}; allowed: ${allowed.join(", ") || "none"}`,
        { code: "not_allowed", allowed }
      );
    }

    const sets = ["status=?", "updated_at=?"];
    const args = [to, now];
    if (to === "applied" && !row.applied_at) {
      sets.push("applied_at=?");
      args.push(now);
    }
    if (from === "in_progress") {
      sets.push("owner=NULL", "lease_until=NULL");
      c.prepare("UPDATE job_queue SET done_at=? WHERE job_id=? AND done_at IS NULL").run(now, jobId);
    }
    c.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id=?`).run(...args, jobId);

    const queueKind = to === "in_progress" ? QUEUE_ON_ENTER[from] : null;
    if (queueKind) {
      c.prepare("INSERT INTO job_queue (job_id, kind, created_at) VALUES (?,?,?)").run(jobId, queueKind, now);
    }
    insertEvent(c, jobId, { actor, from, to, message, at: now });
    return c.prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
  })();
  emit([{ kind: "transition", jobId, to, actor }]);
  return decorate(job, committedCompanies());
}

const EDITABLE = ["apply_url", "ats", "step", "tab_id", "referral", "scam_flag", "track", "notes", "account_tenant"];

// Update non-status fields. Unknown keys are ignored; returns null when nothing valid
// was given or the job doesn't exist. ats is detected from apply_url when not given.
export function setJobFields(jobId, fields, { actor = "human" } = {}) {
  const f = {};
  for (const k of EDITABLE) if (k in fields) f[k] = fields[k];
  if (f.apply_url && !("ats" in f)) {
    const cur = conn().prepare("SELECT ats FROM jobs WHERE id=?").get(jobId);
    if (cur && !cur.ats) f.ats = atsFromUrl(f.apply_url);
  }
  if ("scam_flag" in f) f.scam_flag = f.scam_flag ? 1 : 0;
  if ("tab_id" in f) f.tab_id = Number.isInteger(f.tab_id) ? f.tab_id : null;
  for (const k of ["apply_url", "ats", "step", "referral", "track", "account_tenant"]) {
    if (k in f) f[k] = f[k] == null || f[k] === "" ? null : String(f[k]);
  }
  if ("notes" in f) f.notes = f.notes == null ? "" : String(f.notes);
  const keys = Object.keys(f);
  if (!keys.length) return null;

  const info = conn()
    .prepare(`UPDATE jobs SET ${keys.map((k) => `${k}=?`).join(", ")}, updated_at=? WHERE id=?`)
    .run(...keys.map((k) => f[k]), nowIso(), jobId);
  if (!info.changes) return null;
  emit([{ kind: "updated", jobId, actor }]);
  return getJob(jobId);
}

export function addEvent(jobId, { actor, message = null }) {
  if (!conn().prepare("SELECT 1 FROM jobs WHERE id=?").get(jobId)) return null;
  insertEvent(conn(), jobId, { actor, message });
  conn().prepare("UPDATE jobs SET updated_at=? WHERE id=?").run(nowIso(), jobId);
  emit([{ kind: "event", jobId, actor }]);
  return listEvents(jobId).at(-1);
}

// --- agent loop: queue + per-job lease ----------------------------------------

const liveLease = (row, now) => row.owner && row.lease_until && row.lease_until > now;

// Take the oldest open message whose job is in_progress, has no live lease held by
// someone else and no pending referral; lease the job to `agent`. Messages taken by
// an agent whose lease expired become available again. Returns {message, job} or null.
export function queueNext(agent, { leaseMinutes = 30 } = {}) {
  const now = nowIso();
  const out = conn().transaction(() => {
    const c = conn();
    const candidates = c
      .prepare(
        `SELECT q.*, j.owner, j.lease_until FROM job_queue q JOIN jobs j ON j.id = q.job_id
          WHERE q.done_at IS NULL AND j.status = 'in_progress'
            AND (j.referral IS NULL OR j.referral = '')
          ORDER BY q.created_at, q.id`
      )
      .all();
    // Untaken (or taken under a lease that has since expired), on a job nobody else
    // holds right now.
    const msg = candidates.find(
      (m) => (!m.taken_at || !liveLease(m, now)) && (!liveLease(m, now) || m.owner === agent)
    );
    if (!msg) return null;
    c.prepare("UPDATE job_queue SET taken_at=?, taken_by=? WHERE id=?").run(now, agent, msg.id);
    c.prepare("UPDATE jobs SET owner=?, lease_until=? WHERE id=?").run(agent, minutesFromNow(leaseMinutes), msg.job_id);
    insertEvent(c, msg.job_id, { actor: agent, message: `took ${msg.kind}` });
    return {
      message: { id: msg.id, kind: msg.kind, created_at: msg.created_at },
      jobId: msg.job_id,
    };
  })();
  if (!out) return null;
  emit([{ kind: "queue", jobId: out.jobId, actor: agent }]);
  return { message: out.message, job: getJobDetail(out.jobId) };
}

// Throws unless `agent` may act on the job: no live lease, or the lease is theirs.
export function assertOwner(jobId, agent) {
  const row = conn().prepare("SELECT owner, lease_until FROM jobs WHERE id=?").get(jobId);
  if (!row) throw new TransitionError(`job ${jobId} not found`, { code: "not_found" });
  if (liveLease(row, nowIso()) && row.owner !== agent) {
    throw new TransitionError(`job ${jobId} is held by ${row.owner} until ${row.lease_until}`, { code: "owned" });
  }
}

export function renewLease(jobId, agent, { leaseMinutes = 30 } = {}) {
  conn().prepare("UPDATE jobs SET owner=?, lease_until=? WHERE id=?").run(agent, minutesFromNow(leaseMinutes), jobId);
}

// The agent stops without finishing (error stop): status stays, lock and open
// messages are dropped, the reason goes on the timeline.
export function releaseJob(jobId, { actor, message }) {
  const now = nowIso();
  const ok = conn().transaction(() => {
    const c = conn();
    if (!c.prepare("SELECT 1 FROM jobs WHERE id=?").get(jobId)) return false;
    c.prepare("UPDATE jobs SET owner=NULL, lease_until=NULL, updated_at=? WHERE id=?").run(now, jobId);
    c.prepare("UPDATE job_queue SET done_at=? WHERE job_id=? AND done_at IS NULL AND taken_at IS NOT NULL").run(
      now,
      jobId
    );
    insertEvent(c, jobId, { actor, message: message || "released" });
    return true;
  })();
  if (ok) emit([{ kind: "event", jobId, actor }]);
  return ok;
}

// Jobs waiting for the human, longest-waiting first.
export function attention() {
  return listJobSummaries({ folder: "waiting", limit: 1000 }).jobs;
}

// --- matching for bookmarklet ops (/act) ---------------------------------------

function normUrl(u) {
  try {
    const x = new URL(u);
    return (x.hostname.toLowerCase() + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch {
    return null;
  }
}

// Resolve the job a bookmarklet means: by id, by "#<id>" in the page title, by the
// application URL's host+path, then by the posting URL. Returns {job} or
// {error: 'no match' | 'ambiguous', candidates?}.
export function findJob({ jobId = null, title = null, url = null } = {}) {
  const byId = (id) => getJob(id);
  if (Number.isInteger(jobId)) {
    const job = byId(jobId);
    return job ? { job } : { error: "no match" };
  }
  const m = /#(\d+)\b/.exec(title || "");
  if (m) {
    const job = byId(Number(m[1]));
    if (job) return { job };
  }
  const key = normUrl(url);
  if (key) {
    const rows = conn().prepare("SELECT id, apply_url, url FROM jobs WHERE status <> 'trash'").all();
    for (const field of ["apply_url", "url"]) {
      const hits = rows.filter((r) => r[field] && normUrl(r[field]) === key);
      if (hits.length === 1) return { job: byId(hits[0].id) };
      if (hits.length > 1) return { error: "ambiguous", candidates: hits.map((h) => h.id) };
    }
    const lid = linkedinIdFromUrl(url);
    if (lid) {
      const row = conn().prepare("SELECT id FROM jobs WHERE linkedin_id=?").get(lid);
      if (row) return { job: byId(row.id) };
    }
  }
  return { error: "no match" };
}

// --- stats (from jobs + the event log) -----------------------------------------

// Counts since local midnight: jobs captured, first applications, trashings.
export function statsToday() {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const start = isoSeconds(midnight);
  const c = conn();
  const count = (sql) => c.prepare(sql).pluck().get(start);
  return {
    captured: count("SELECT COUNT(*) FROM jobs WHERE created_at >= ?"),
    applied: count("SELECT COUNT(*) FROM jobs WHERE applied_at >= ?"),
    trashed: count("SELECT COUNT(*) FROM job_events WHERE to_status='trash' AND at >= ?"),
  };
}

const pad2 = (n) => String(n).padStart(2, "0");
// Local calendar date as "YYYY-MM-DD" (sorts and compares as a string).
const localDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
// Local-noon Date for a "YYYY-MM-DD" key, shifted by n days (noon dodges DST edges).
function addDays(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  return localDay(new Date(y, m - 1, d + n, 12));
}

// Per-local-day counts of jobs captured, first applications and rejections, zero-filled
// through today. `days` (≥ 1) limits the window; anything else means all history.
export function statsDaily(days = null) {
  const c = conn();
  const counts = new Map();
  const bump = (iso, i) => {
    if (!iso) return;
    const k = localDay(new Date(iso));
    if (!counts.has(k)) counts.set(k, [0, 0, 0]);
    counts.get(k)[i] += 1;
  };
  for (const r of c.prepare("SELECT created_at, applied_at FROM jobs").all()) {
    bump(r.created_at, 0);
    bump(r.applied_at, 1);
  }
  for (const at of c.prepare("SELECT at FROM job_events WHERE to_status='rejected'").pluck().all()) bump(at, 2);
  if (!counts.size) return [];
  const end = localDay(new Date());
  let start = [...counts.keys()].sort()[0];
  if (Number.isInteger(days) && days >= 1) {
    const floor = addDays(end, -(days - 1));
    if (floor > start) start = floor;
  }
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const [cap, app, rej] = counts.get(d) || [0, 0, 0];
    out.push({ date: d, captured: cap, applied: app, rejected: rej });
  }
  return out;
}

// --- ATS login accounts (per-employer ATS sign-ins) ---------------------------

// A strong random password meeting common ATS policies: at least one each
// of upper, lower, digit and a safe special char; ambiguous chars excluded.
export function genPassword(length = 18) {
  length = Math.max(length, 12);
  const lower = "abcdefghijkmnpqrstuvwxyz"; // no l, o
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, O
  const digits = "23456789"; // no 0, 1
  const special = "!@#$%*?-_";
  const alphabet = lower + upper + digits + special;
  const has = (pw, set) => [...pw].some((ch) => set.includes(ch));
  for (;;) {
    let pw = "";
    for (let i = 0; i < length; i++) pw += alphabet[crypto.randomInt(alphabet.length)];
    if (has(pw, lower) && has(pw, upper) && has(pw, digits) && has(pw, special)) return pw;
  }
}

// Return the stored ats_accounts row for a tenant host, or null.
export function getAccount(tenant) {
  tenant = (tenant || "").trim().toLowerCase();
  if (!tenant) return null;
  return conn().prepare("SELECT * FROM ats_accounts WHERE tenant = ?").get(tenant) ?? null;
}

// Upsert an ATS account keyed on the tenant (the login's host, or host/path where the
// host is shared by many employers). Keeps created_at, refreshes updated_at. Returns
// the stored row.
export function saveAccount({ tenant, employer, email, password, ats = null, notes = "" }) {
  ats = ats || atsFromUrl(`https://${(tenant || "").trim()}`) || "other";
  tenant = (tenant || "").trim().toLowerCase();
  const now = nowIso();
  return conn().transaction(() => {
    const c = conn();
    const existing = c.prepare("SELECT id FROM ats_accounts WHERE tenant = ?").get(tenant);
    if (existing) {
      c.prepare(
        `UPDATE ats_accounts SET ats=?, employer=?, email=?, password=?,
           notes=?, updated_at=? WHERE id=?`
      ).run(ats, employer, email, password, notes, now, existing.id);
    } else {
      c.prepare(
        `INSERT INTO ats_accounts
           (ats, tenant, employer, email, password, notes, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?)`
      ).run(ats, tenant, employer, email, password, notes, now, now);
    }
    return c.prepare("SELECT * FROM ats_accounts WHERE tenant = ?").get(tenant);
  })();
}

// The account for a job, if one is stored: the one create_account linked to it
// (account_tenant), else the one keyed on its apply_url or url host.
export function accountForJob(job) {
  if (!job) return null;
  const linked = getAccount(job.account_tenant);
  if (linked) return linked;
  for (const url of [job.apply_url, job.url]) {
    const account = getAccount(accountHostFromUrl(url));
    if (account) return account;
  }
  return null;
}
