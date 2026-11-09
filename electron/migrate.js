// Schema versions, tracked in PRAGMA user_version.
//   0  empty file (fresh install) or a v1 database (jobs table, no version)
//   2  staged workflow: job_events, job_queue, agent columns on jobs
//   3  no structured needs/answers: drops jobs.needs, job_events.data and
//      job_queue.payload; adds jobs.account_tenant
// An existing database is copied next to itself (jobs.backup-v<N>-<date>.db) before migrating.
import fs from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = 3;

const JOBS_V3 = `
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY,
  linkedin_id TEXT UNIQUE,
  url         TEXT,
  company     TEXT,
  title       TEXT,
  location    TEXT,
  body        TEXT,
  source      TEXT DEFAULT 'linkedin',
  track       TEXT,
  status      TEXT DEFAULT 'new',
  notes       TEXT DEFAULT '',          -- the human's own notes; agents write events
  created_at  TEXT,
  updated_at  TEXT,
  applied_at  TEXT,                     -- first time the job reached 'applied'
  apply_url   TEXT,                     -- the employer's application form
  ats         TEXT,                     -- greenhouse, ashby, lever, workday, …
  tab_id      INTEGER,                  -- Chrome tab of the current fill (a hint)
  step        TEXT,                     -- furthest form step reached
  referral    TEXT,                     -- contact at the company; blocks the agent loop
  scam_flag   INTEGER DEFAULT 0,
  owner       TEXT,                     -- agent holding the job (per-job lock)
  lease_until TEXT,                     -- the lock expires here
  account_tenant TEXT                   -- ATS account create_account linked (else matched by URL host)
);`;

const COMMON_V3 = `
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company COLLATE NOCASE);

-- Every status change plus agent / human remarks. Replaces overwriting notes.
CREATE TABLE IF NOT EXISTS job_events (
  id          INTEGER PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,            -- human | agent:<name> | gmail | bookmarklet | migration
  from_status TEXT,
  to_status   TEXT,
  message     TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_job ON job_events(job_id, at);
CREATE INDEX IF NOT EXISTS idx_events_to ON job_events(to_status, at);

-- Work for the agent loop: 'start' (human pressed Start) or 'unblock' (human resolved a block).
CREATE TABLE IF NOT EXISTS job_queue (
  id          INTEGER PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  taken_at    TEXT,
  taken_by    TEXT,
  done_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_open ON job_queue(done_at, created_at);

-- Per-employer ATS login accounts (Workday, iCIMS, Taleo, … need one per employer).
-- Keyed on the tenant (the login's host, or host/path on shared hosts), which is the
-- same login across all of that employer's postings. Plaintext creds in this git-ignored local DB (single-user tool).
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

const NEW_JOB_COLUMNS = [
  "apply_url TEXT",
  "ats TEXT",
  "tab_id INTEGER",
  "step TEXT",
  "referral TEXT",
  "scam_flag INTEGER DEFAULT 0",
  "owner TEXT",
  "lease_until TEXT",
  "account_tenant TEXT",
];

const hasTable = (db, name) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

const columns = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));

function backup(db, dbPath, version) {
  if (!dbPath || dbPath === ":memory:") return null;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const dest = path.join(path.dirname(dbPath), `jobs.backup-v${version}-${stamp}.db`);
  if (fs.existsSync(dest)) fs.rmSync(dest);
  db.prepare("VACUUM INTO ?").run(dest);
  return dest;
}

function migrateV1(db) {
  const cols = columns(db, "jobs");
  for (const col of NEW_JOB_COLUMNS) {
    if (!cols.has(col.split(" ")[0])) db.exec(`ALTER TABLE jobs ADD COLUMN ${col}`);
  }
  db.exec(COMMON_V3);
  db.exec(`
    DROP INDEX IF EXISTS idx_jobs_status;
    CREATE INDEX idx_jobs_status ON jobs(status, updated_at);
    UPDATE jobs SET status = 'new' WHERE status = 'incoming';
    UPDATE jobs SET status = 'triaged' WHERE status = 'review';
  `);

  // Rebuild the history the v1 tracker kept only as timestamps.
  const ev = (sql) => db.exec(`INSERT INTO job_events (job_id, at, actor, from_status, to_status, message) ${sql}`);
  ev(`SELECT id, COALESCE(created_at, updated_at, ''), 'migration', NULL, 'new', 'captured' FROM jobs`);
  ev(`SELECT id, applied_at, 'migration', NULL, 'applied', 'applied' FROM jobs WHERE applied_at IS NOT NULL`);
  ev(`SELECT id, COALESCE(updated_at, created_at, ''), 'migration', NULL, status, status
        FROM jobs WHERE status IN ('triaged', 'rejected', 'trash')`);
  // All existing notes become events; notes is the human's own field from now on.
  ev(`SELECT id, COALESCE(updated_at, created_at, ''), 'migration', NULL, NULL, notes
        FROM jobs WHERE notes IS NOT NULL AND trim(notes) <> ''`);
  db.exec("UPDATE jobs SET notes = ''");
}

// v2 → v3: the agent's structured needs and the human's answers are gone (a blocked
// job carries a plain timeline message instead). The one other use of
// job_events.data, create_account's link to a job, moves to jobs.account_tenant.
function migrateV2(db) {
  if (!columns(db, "jobs").has("account_tenant")) db.exec("ALTER TABLE jobs ADD COLUMN account_tenant TEXT");
  if (columns(db, "job_events").has("data")) {
    db.exec(`
      UPDATE jobs SET account_tenant = (
        SELECT json_extract(e.data, '$.account') FROM job_events e
         WHERE e.job_id = jobs.id AND json_extract(e.data, '$.account') IS NOT NULL
         ORDER BY e.at DESC, e.id DESC LIMIT 1)
       WHERE account_tenant IS NULL`);
  }
  // Open needs become one timeline note per job, so a job that is blocked right now
  // keeps what it asks of the human.
  if (columns(db, "jobs").has("needs")) {
    db.exec(`
      INSERT INTO job_events (job_id, at, actor, message)
      SELECT j.id, strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now'), 'migration',
             'needs:' || char(10) || group_concat('- ' || COALESCE(json_extract(n.value, '$.text'), json_extract(n.value, '$.q')), char(10))
        FROM jobs j, json_each(CASE WHEN json_valid(j.needs) THEN j.needs ELSE '[]' END) n
       GROUP BY j.id`);
  }
  for (const [table, col] of [["jobs", "needs"], ["job_events", "data"], ["job_queue", "payload"]]) {
    if (columns(db, table).has(col)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`);
  }
}

// Bring the database at `db` (opened from `dbPath`) to SCHEMA_VERSION.
// Returns {from, to, backup} where backup is the copy's path (null for a fresh file).
export function migrate(db, dbPath) {
  let from = db.pragma("user_version", { simple: true });
  if (from >= SCHEMA_VERSION) return { from, to: from, backup: null };

  if (from === 0 && hasTable(db, "jobs")) from = 1;
  const backupPath = from > 0 ? backup(db, dbPath, from) : null;
  db.transaction(() => {
    if (from === 0) {
      db.exec(JOBS_V3);
      db.exec(COMMON_V3);
    }
    if (from === 1) migrateV1(db);
    if (from === 2) migrateV2(db);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
  return { from, to: SCHEMA_VERSION, backup: backupPath };
}
