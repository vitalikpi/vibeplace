// Schema versions, tracked in PRAGMA user_version.
//   0  empty file (fresh install) or a v1 database (jobs table, no version)
//   2  staged workflow: job_events, job_queue, agent columns on jobs
// A v1 database is copied next to itself (jobs.backup-v1-<date>.db) before migrating.
import fs from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = 2;

const JOBS_V2 = `
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
  needs       TEXT DEFAULT '[]',        -- JSON [{id, type, text, q?, answers_ref?}]
  referral    TEXT,                     -- contact at the company; blocks the agent loop
  scam_flag   INTEGER DEFAULT 0,
  owner       TEXT,                     -- agent holding the job (per-job lock)
  lease_until TEXT                      -- the lock expires here
);`;

const COMMON_V2 = `
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
  message     TEXT,
  data        TEXT                      -- JSON: answers, needs, override, evidence
);
CREATE INDEX IF NOT EXISTS idx_events_job ON job_events(job_id, at);
CREATE INDEX IF NOT EXISTS idx_events_to ON job_events(to_status, at);

-- Work for the agent loop: 'start' (human pressed Start) or 'unblock' (with answers).
CREATE TABLE IF NOT EXISTS job_queue (
  id          INTEGER PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  payload     TEXT,
  created_at  TEXT NOT NULL,
  taken_at    TEXT,
  taken_by    TEXT,
  done_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_open ON job_queue(done_at, created_at);

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

const NEW_JOB_COLUMNS = [
  "apply_url TEXT",
  "ats TEXT",
  "tab_id INTEGER",
  "step TEXT",
  "needs TEXT DEFAULT '[]'",
  "referral TEXT",
  "scam_flag INTEGER DEFAULT 0",
  "owner TEXT",
  "lease_until TEXT",
];

const hasTable = (db, name) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

function backup(db, dbPath) {
  if (!dbPath || dbPath === ":memory:") return null;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const dest = path.join(path.dirname(dbPath), `jobs.backup-v1-${stamp}.db`);
  if (fs.existsSync(dest)) fs.rmSync(dest);
  db.prepare("VACUUM INTO ?").run(dest);
  return dest;
}

function migrateV1(db) {
  const cols = new Set(db.prepare("PRAGMA table_info(jobs)").all().map((c) => c.name));
  for (const col of NEW_JOB_COLUMNS) {
    if (!cols.has(col.split(" ")[0])) db.exec(`ALTER TABLE jobs ADD COLUMN ${col}`);
  }
  db.exec(COMMON_V2);
  db.exec(`
    DROP INDEX IF EXISTS idx_jobs_status;
    CREATE INDEX idx_jobs_status ON jobs(status, updated_at);
    UPDATE jobs SET status = 'new' WHERE status = 'incoming';
    UPDATE jobs SET status = 'triaged' WHERE status = 'review';
    UPDATE jobs SET needs = '[]' WHERE needs IS NULL;
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

// Bring the database at `db` (opened from `dbPath`) to SCHEMA_VERSION.
// Returns {from, to, backup} where backup is the copy's path for a v1 migration.
export function migrate(db, dbPath) {
  const from = db.pragma("user_version", { simple: true });
  if (from >= SCHEMA_VERSION) return { from, to: from, backup: null };

  const isV1 = from === 0 && hasTable(db, "jobs");
  const backupPath = isV1 ? backup(db, dbPath) : null;
  db.transaction(() => {
    if (isV1) {
      migrateV1(db);
    } else {
      db.exec(JOBS_V2);
      db.exec(COMMON_V2);
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
  return { from: isV1 ? 1 : 0, to: SCHEMA_VERSION, backup: backupPath };
}
