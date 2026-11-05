// SQLite storage for the job tracker. Source of truth for all jobs.
// Port of db.py on better-sqlite3: one shared connection, opened by initDb().
import crypto from "node:crypto";
import Database from "better-sqlite3";

export const STATUSES = ["incoming", "review", "applied", "rejected", "trash"];
export const TRACKS = ["remote", "nyc", "boston", "sf", "florida"];
// Statuses that count as "committed to this company" for the dedup warning.
export const DEDUP_STATUSES = ["review", "applied", "rejected"];

// Aggregators / job-board reposters that list other companies' jobs under their own
// name and never name the end employer. New captures from these are filed straight to
// trash (recoverable) instead of cluttering Incoming or spending triage on them.
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

function normCompany(name) {
  return (name || "").trim().toLowerCase();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY,
  linkedin_id TEXT UNIQUE,
  url         TEXT,
  company     TEXT,
  title       TEXT,
  location    TEXT,
  body        TEXT,
  source      TEXT DEFAULT 'linkedin',
  track       TEXT DEFAULT 'remote',
  status      TEXT DEFAULT 'incoming',
  notes       TEXT DEFAULT '',
  created_at  TEXT,
  updated_at  TEXT,
  applied_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company COLLATE NOCASE);

-- Per-employer ATS login accounts (Workday needs a separate account per tenant).
-- Keyed on the tenant host, which is the same login across all of that employer's
-- postings. Plaintext creds in this git-ignored local DB (single-user tool).
CREATE TABLE IF NOT EXISTS ats_accounts (
  id          INTEGER PRIMARY KEY,
  ats         TEXT DEFAULT 'workday',
  tenant      TEXT UNIQUE,          -- e.g. 'nvidia.wd5.myworkdayjobs.com' (normalized host)
  employer    TEXT,
  email       TEXT,
  password    TEXT,
  notes       TEXT DEFAULT '',
  created_at  TEXT,
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_accounts_tenant ON ats_accounts(tenant);
`;

let db = null;

// Same format as Python's datetime.isoformat(timespec="seconds") on a UTC datetime
// ("2026-11-05T14:03:22+00:00"). Timestamps are compared as strings (statsToday), so
// toISOString()'s "...22.123Z" must never be stored.
function isoSeconds(date) {
  return date.toISOString().slice(0, 19) + "+00:00";
}

function nowIso() {
  return isoSeconds(new Date());
}

// Python str() for the values a JSON body can carry in "notes".
function pyStr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

export function initDb(dbPath) {
  if (db) return db;
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

function conn() {
  if (!db) throw new Error("database not initialised (call initDb first)");
  return db;
}

export function linkedinIdFromUrl(url) {
  if (!url) return null;
  const m = /\/jobs\/view\/(\d+)/.exec(url);
  return m ? m[1] : null;
}

function appliedCompanies() {
  // Lower-cased set of company names already committed to (review/applied/rejected).
  const rows = conn()
    .prepare(
      `SELECT DISTINCT company FROM jobs WHERE status IN (${DEDUP_STATUSES.map(() => "?").join(",")}) AND company <> ''`
    )
    .all(...DEDUP_STATUSES);
  return new Set(rows.map((r) => (r.company || "").trim().toLowerCase()));
}

const str = (v, dflt = "") => String(v || dflt).trim();

// Insert a job from the bookmarklet, or update the existing row with the same
// linkedin_id. Returns {id, duplicateCompany}.
export function addJob(data) {
  const url = str(data.url);
  const company = str(data.company);
  const title = str(data.title);
  const body = str(data.body);
  const location = str(data.location);
  const source = str(data.source, "linkedin");
  const lid = linkedinIdFromUrl(url);
  const now = nowIso();

  return conn().transaction(() => {
    const c = conn();
    let existing;
    if (lid) existing = c.prepare("SELECT id FROM jobs WHERE linkedin_id = ?").get(lid);
    if (!existing && url) existing = c.prepare("SELECT id FROM jobs WHERE url = ?").get(url);

    let jobId;
    if (existing) {
      // Refresh the captured fields but keep the user's status/track/notes.
      c.prepare(
        `UPDATE jobs SET url=?, company=?, title=?, body=?, location=?,
           source=?, updated_at=? WHERE id=?`
      ).run(url, company, title, body, location, source, now, existing.id);
      jobId = existing.id;
    } else {
      // Blacklisted aggregators go straight to trash (recoverable) so they never
      // reach Incoming or triage; everything else starts in Incoming.
      const blacklisted = COMPANY_BLACKLIST.has(normCompany(company));
      const status = blacklisted ? "trash" : "incoming";
      const notes = blacklisted ? "blacklisted: " + company : "";
      const info = c
        .prepare(
          `INSERT INTO jobs (linkedin_id, url, company, title, location, body,
             source, track, status, notes, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(lid, url, company, title, location, body, source, "remote", status, notes, now, now);
      jobId = Number(info.lastInsertRowid);
    }

    const dup = company ? appliedCompanies().has(normCompany(company)) : false;
    return { id: jobId, duplicateCompany: dup };
  })();
}

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
  if (q) {
    sql += " AND (company LIKE ? OR title LIKE ? OR body LIKE ?)";
    const like = `%${q}%`;
    args.push(like, like, like);
  }
  sql += " ORDER BY COALESCE(updated_at, created_at) DESC";

  const rows = conn().prepare(sql).all(...args);
  const applied = appliedCompanies();
  for (const r of rows) {
    const c = (r.company || "").trim().toLowerCase();
    // Flag as duplicate only if a *different* committed row shares the company.
    r.duplicateCompany = Boolean(c && applied.has(c) && !DEDUP_STATUSES.includes(r.status));
  }
  return rows;
}

export function updateJob(jobId, fields) {
  const allowed = {};
  if ("status" in fields && STATUSES.includes(fields.status)) allowed.status = fields.status;
  if ("track" in fields && TRACKS.includes(fields.track)) allowed.track = fields.track;
  if ("notes" in fields) allowed.notes = pyStr(fields.notes);
  if (!Object.keys(allowed).length) return null;

  const now = nowIso();
  let sets = Object.keys(allowed).map((k) => `${k}=?`).join(", ");
  const args = Object.values(allowed);
  sets += ", updated_at=?";
  args.push(now);
  if (allowed.status === "applied") {
    sets += ", applied_at=COALESCE(applied_at, ?)";
    args.push(now);
  }
  args.push(jobId);

  return conn().transaction(() => {
    conn().prepare(`UPDATE jobs SET ${sets} WHERE id=?`).run(...args);
    return conn().prepare("SELECT * FROM jobs WHERE id=?").get(jobId) ?? null;
  })();
}

// Return one job object (with full body + duplicateCompany flag), or null.
export function getJob(jobId) {
  const d = conn().prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
  if (!d) return null;
  const applied = appliedCompanies();
  const c = (d.company || "").trim().toLowerCase();
  d.duplicateCompany = Boolean(c && applied.has(c) && !DEDUP_STATUSES.includes(d.status));
  return d;
}

export function stats() {
  const rows = conn().prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all();
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

// Counts of jobs that entered incoming / applied / trash since local midnight.
export function statsToday() {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const start = isoSeconds(midnight);
  const c = conn();
  const count = (sql) => c.prepare(sql).pluck().get(start);
  return {
    incoming: count("SELECT COUNT(*) FROM jobs WHERE created_at >= ?"),
    applied: count("SELECT COUNT(*) FROM jobs WHERE applied_at >= ?"),
    trashed: count("SELECT COUNT(*) FROM jobs WHERE status='trash' AND updated_at >= ?"),
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

// Per-local-day counts of jobs captured (incoming), applied, and rejected, with
// zero-filled gaps. Rejections have no own timestamp, so updated_at stands in.
export function statsDaily(days = null) {
  const rows = conn().prepare("SELECT status, created_at, applied_at, updated_at FROM jobs").all();
  const counts = new Map();
  const bump = (iso, i) => {
    const k = localDay(new Date(iso));
    if (!counts.has(k)) counts.set(k, [0, 0, 0]);
    counts.get(k)[i] += 1;
  };
  for (const r of rows) {
    if (r.created_at) bump(r.created_at, 0);
    if (r.applied_at) bump(r.applied_at, 1);
    if (r.status === "rejected" && r.updated_at) bump(r.updated_at, 2);
  }
  if (!counts.size) return [];
  const end = localDay(new Date());
  let start = [...counts.keys()].sort()[0];
  if (days) {
    const floor = addDays(end, -(days - 1));
    if (floor > start) start = floor;
  }
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const [inc, app, rej] = counts.get(d) || [0, 0, 0];
    out.push({ date: d, incoming: inc, applied: app, rejected: rej });
  }
  return out;
}

export function exportAll() {
  return conn().prepare("SELECT * FROM jobs ORDER BY id").all();
}

// --- ATS login accounts (per-employer Workday sign-ins) -----------------------

// Return the lower-cased Workday tenant host (the account key) from a
// *.myworkdayjobs.com URL, or null. E.g. 'nvidia.wd5.myworkdayjobs.com'.
export function workdayTenantFromUrl(url) {
  if (!url) return null;
  const m = /https?:\/\/([^/]*\.myworkdayjobs\.com)/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

// A strong random password meeting common Workday policies: at least one each
// of upper, lower, digit and a safe special char; ambiguous chars excluded.
export function genPassword(length = 18) {
  length = Math.max(length, 12);
  const lower = "abcdefghijkmnpqrstuvwxyz"; // no l, o
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, O
  const digits = "23456789"; // no 0, 1
  const special = "!@#$%*?-_";
  const alphabet = lower + upper + digits + special;
  const has = (pw, set) => [...pw].some((c) => set.includes(c));
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

// Upsert an ATS account keyed on the tenant host. Keeps created_at, refreshes
// updated_at. Returns the stored row.
export function saveAccount({ tenant, employer, email, password, ats = "workday", notes = "" }) {
  tenant = (tenant || "").trim().toLowerCase();
  const now = nowIso();
  return conn().transaction(() => {
    const c = conn();
    const existing = c.prepare("SELECT id, created_at FROM ats_accounts WHERE tenant = ?").get(tenant);
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
