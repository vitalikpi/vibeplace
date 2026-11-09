import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { closeDb, getJobDetail, initDb, listEvents, stats } from "../electron/db.js";
import { SCHEMA_VERSION } from "../electron/migrate.js";

// The schema the v1 tracker (Flask and the first Electron port) created.
const V1_SCHEMA = `
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY, linkedin_id TEXT UNIQUE, url TEXT, company TEXT, title TEXT,
  location TEXT, body TEXT, source TEXT DEFAULT 'linkedin', track TEXT DEFAULT 'remote',
  status TEXT DEFAULT 'incoming', notes TEXT DEFAULT '', created_at TEXT, updated_at TEXT,
  applied_at TEXT
);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_company ON jobs(company COLLATE NOCASE);
CREATE TABLE ats_accounts (
  id INTEGER PRIMARY KEY, ats TEXT DEFAULT 'workday', tenant TEXT UNIQUE, employer TEXT,
  email TEXT, password TEXT, notes TEXT DEFAULT '', created_at TEXT, updated_at TEXT
);
CREATE INDEX idx_accounts_tenant ON ats_accounts(tenant);
`;

const T = (d) => `2026-10-${d}T12:00:00+00:00`;
const V1_ROWS = [
  // id, status, notes, created, updated, applied
  [1, "incoming", "", T(10), T(10), null],
  [2, "review", "looks good", T(10), T(11), null],
  [3, "applied", "", T(10), T(12), T(12)],
  [4, "rejected", "NO-GO: staffing agency", T(10), T(14), T(12)],
  [5, "trash", "blacklisted: Jobot", T(10), T(10), null],
  [6, "incoming", "   ", T(15), T(15), null],
];

let dir;
function v1Db() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobtracker-migrate-"));
  const file = path.join(dir, "jobs.db");
  const raw = new Database(file);
  raw.exec(V1_SCHEMA);
  const ins = raw.prepare(
    `INSERT INTO jobs (id, linkedin_id, url, company, title, status, notes, created_at, updated_at, applied_at, track)
       VALUES (?,?,?,?,?,?,?,?,?,?,'boston')`
  );
  for (const [id, status, notes, c, u, a] of V1_ROWS) {
    ins.run(id, String(1000 + id), `https://www.linkedin.com/jobs/view/${1000 + id}/`, `Co${id}`, `T${id}`, status, notes, c, u, a);
  }
  raw.prepare("INSERT INTO ats_accounts (tenant, email, password) VALUES ('acme.wd1.myworkdayjobs.com', 'a@x', 'pw')").run();
  raw.close();
  return file;
}

afterEach(() => {
  closeDb();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("v1 → v2 migration", () => {
  it("backs the v1 file up before touching it", () => {
    const file = v1Db();
    initDb(file);
    const backups = fs.readdirSync(dir).filter((f) => /^jobs\.backup-v1-.*\.db$/.test(f));
    expect(backups).toHaveLength(1);
    const copy = new Database(path.join(dir, backups[0]), { readonly: true });
    expect(copy.pragma("user_version", { simple: true })).toBe(0);
    expect(copy.prepare("SELECT status, COUNT(*) n FROM jobs GROUP BY status ORDER BY status").all()).toEqual([
      { status: "applied", n: 1 },
      { status: "incoming", n: 2 },
      { status: "rejected", n: 1 },
      { status: "review", n: 1 },
      { status: "trash", n: 1 },
    ]);
    copy.close();
  });

  it("renames statuses, keeps every row, account and track", () => {
    const db = initDb(v1Db());
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(stats()).toEqual({ new: 2, triaged: 1, applied: 1, rejected: 1, trash: 1 });
    expect(db.prepare("SELECT COUNT(*) FROM ats_accounts").pluck().get()).toBe(1);
    expect(db.prepare("SELECT DISTINCT track FROM jobs").pluck().all()).toEqual(["boston"]);
    expect(getJobDetail(3)).toMatchObject({ applied_at: T(12), needs: [], scam_flag: false, apply_url: null });
  });

  it("rebuilds the history as events and moves every note into one", () => {
    initDb(v1Db());
    const summary = (id) => listEvents(id).map((e) => [e.actor, e.to_status, e.message, e.at]);
    expect(summary(1)).toEqual([["migration", "new", "captured", T(10)]]);
    expect(summary(2)).toEqual([
      ["migration", "new", "captured", T(10)],
      ["migration", "triaged", "triaged", T(11)],
      ["migration", null, "looks good", T(11)],
    ]);
    expect(summary(4)).toEqual([
      ["migration", "new", "captured", T(10)],
      ["migration", "applied", "applied", T(12)],
      ["migration", "rejected", "rejected", T(14)],
      ["migration", null, "NO-GO: staffing agency", T(14)],
    ]);
    expect(summary(5).map((e) => e[2])).toEqual(["captured", "trash", "blacklisted: Jobot"]);
    expect(summary(6)).toHaveLength(1); // whitespace-only note dropped
    expect(getJobDetail(2).notes).toBe("");
    expect(getJobDetail(4).notes).toBe("");
  });

  it("is idempotent: reopening a migrated file changes nothing", () => {
    const file = v1Db();
    initDb(file);
    const before = new Database(file, { readonly: true });
    const counts = () => before.prepare("SELECT (SELECT COUNT(*) FROM job_events) e, (SELECT COUNT(*) FROM jobs) j").get();
    const first = counts();
    closeDb();
    initDb(file);
    expect(counts()).toEqual(first);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("jobs.backup-v1-"))).toHaveLength(1);
    before.close();
  });
});

// The v2 jobs table: keyed on linkedin_id, which v3 drops.
const V2_SCHEMA = `
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY, linkedin_id TEXT UNIQUE, url TEXT, company TEXT, title TEXT,
  location TEXT, body TEXT, source TEXT DEFAULT 'linkedin', track TEXT, status TEXT DEFAULT 'new',
  notes TEXT DEFAULT '', created_at TEXT, updated_at TEXT, applied_at TEXT, apply_url TEXT,
  ats TEXT, tab_id INTEGER, step TEXT, needs TEXT DEFAULT '[]', referral TEXT,
  scam_flag INTEGER DEFAULT 0, owner TEXT, lease_until TEXT
);
CREATE TABLE job_events (
  id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  at TEXT NOT NULL, actor TEXT NOT NULL, from_status TEXT, to_status TEXT, message TEXT, data TEXT
);
CREATE TABLE job_queue (
  id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL, taken_at TEXT, taken_by TEXT, done_at TEXT
);
CREATE TABLE ats_accounts (
  id INTEGER PRIMARY KEY, ats TEXT DEFAULT 'workday', tenant TEXT UNIQUE, employer TEXT,
  email TEXT, password TEXT, notes TEXT DEFAULT '', created_at TEXT, updated_at TEXT
);
PRAGMA user_version = 2;
`;

function v2Db() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobtracker-migrate-v2-"));
  const file = path.join(dir, "jobs.db");
  const raw = new Database(file);
  raw.exec(V2_SCHEMA);
  const ins = raw.prepare(
    "INSERT INTO jobs (id, linkedin_id, url, company, status, apply_url, ats, source) VALUES (?,?,?,?,?,?,?,?)"
  );
  ins.run(1, "1001", "https://www.linkedin.com/jobs/view/1001/?trk=abc", "Acme", "blocked", "https://acme.wd1.myworkdayjobs.com/1", "workday", "linkedin");
  ins.run(2, null, "https://www.indeed.com/viewjob?jk=9f&from=serp", "Beta", "new", null, null, "indeed");
  ins.run(3, null, "https://careers.gamma.com/jobs/3", "Gamma", "in_progress", null, null, "manual");
  raw.prepare("INSERT INTO job_events (job_id, at, actor, to_status, message) VALUES (?, ?, 'human', 'new', 'captured')").run(1, T(10));
  raw.prepare("INSERT INTO job_queue (job_id, kind, created_at) VALUES (3, 'start', ?)").run(T(11));
  raw.close();
  return file;
}

describe("v2 → v3 migration", () => {
  it("drops linkedin_id and canonicalizes posting URLs, keeping everything else", () => {
    const file = v2Db();
    const db = initDb(file);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    const cols = db.prepare("PRAGMA table_info(jobs)").all().map((c) => c.name);
    expect(cols).not.toContain("linkedin_id");
    expect(db.prepare("SELECT id, url FROM jobs ORDER BY id").all()).toEqual([
      { id: 1, url: "https://www.linkedin.com/jobs/view/1001/" },
      { id: 2, url: "https://www.indeed.com/viewjob?jk=9f" },
      { id: 3, url: "https://careers.gamma.com/jobs/3" },
    ]);
    expect(getJobDetail(1)).toMatchObject({ status: "blocked", ats: "workday", source: "linkedin", company: "Acme" });
    expect(listEvents(1)).toMatchObject([{ message: "captured" }]);
    expect(db.prepare("SELECT job_id FROM job_queue").pluck().all()).toEqual([3]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='jobs' ORDER BY name").pluck().all())
      .toEqual(["idx_jobs_company", "idx_jobs_status", "idx_jobs_url"]);
  });

  it("backs the v2 file up first", () => {
    const file = v2Db();
    initDb(file);
    const backups = fs.readdirSync(dir).filter((f) => /^jobs\.backup-v2-.*\.db$/.test(f));
    expect(backups).toHaveLength(1);
    const copy = new Database(path.join(dir, backups[0]), { readonly: true });
    expect(copy.pragma("user_version", { simple: true })).toBe(2);
    copy.close();
  });

  it("a recaptured posting with new tracking params updates the migrated row", async () => {
    initDb(v2Db());
    const { addJob } = await import("../electron/db.js");
    expect(addJob({ url: "https://www.indeed.com/rc/clk?jk=9f&tk=z", title: "again" })).toMatchObject({ id: 2, created: false });
  });

  it("also takes a v1 file all the way to v3", () => {
    const db = initDb(v1Db());
    expect(db.prepare("PRAGMA table_info(jobs)").all().map((c) => c.name)).not.toContain("linkedin_id");
    expect(listEvents(2).length).toBeGreaterThan(1);
  });
});

describe("fresh database", () => {
  it("is created straight at the current version with no backup", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobtracker-fresh-"));
    const db = initDb(path.join(dir, "jobs.db"));
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all();
    expect(tables).toEqual(["ats_accounts", "job_events", "job_queue", "jobs"]);
    expect(db.prepare("PRAGMA table_info(jobs)").all().map((c) => c.name)).not.toContain("linkedin_id");
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("jobs.backup"))).toEqual([]);
  });
});
