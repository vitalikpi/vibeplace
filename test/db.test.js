import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as db from "../electron/db.js";
import { ISO_SECONDS, freshDb } from "./helpers.js";

const LI = (n) => `https://www.linkedin.com/jobs/view/${n}/`;

beforeEach(freshDb);
afterEach(() => vi.useRealTimers());

// Pin the clock (Date only, so better-sqlite3 and timers are unaffected).
const at = (iso) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};

describe("linkedinIdFromUrl", () => {
  it("extracts the numeric id from a /jobs/view/ URL", () => {
    expect(db.linkedinIdFromUrl(LI(4486579587))).toBe("4486579587");
    expect(db.linkedinIdFromUrl("https://www.linkedin.com/jobs/view/123?trk=x")).toBe("123");
  });
  it("returns null for other URLs or nothing", () => {
    expect(db.linkedinIdFromUrl("https://example.com/job/1")).toBeNull();
    expect(db.linkedinIdFromUrl("")).toBeNull();
    expect(db.linkedinIdFromUrl(undefined)).toBeNull();
  });
});

describe("addJob", () => {
  it("inserts a new job into incoming/remote with trimmed fields and seconds-precision UTC timestamps", () => {
    const { id, duplicateCompany } = db.addJob({
      url: ` ${LI(1)} `,
      company: "  Acme ",
      title: " Engineer ",
      body: " b ",
      location: " NYC ",
    });
    expect(duplicateCompany).toBe(false);
    const job = db.getJob(id);
    expect(job).toMatchObject({
      linkedin_id: "1",
      url: LI(1),
      company: "Acme",
      title: "Engineer",
      body: "b",
      location: "NYC",
      source: "linkedin",
      track: "remote",
      status: "incoming",
      notes: "",
      applied_at: null,
    });
    expect(job.created_at).toMatch(ISO_SECONDS);
    expect(job.updated_at).toBe(job.created_at);
  });

  it("keeps an explicit source", () => {
    const { id } = db.addJob({ url: "https://example.com/1", title: "t", source: "manual" });
    expect(db.getJob(id).source).toBe("manual");
  });

  it("upserts on the LinkedIn id, refreshing captured fields but keeping status/track/notes", () => {
    const { id } = db.addJob({ url: LI(7), company: "Acme", title: "v1" });
    db.updateJob(id, { status: "review", track: "nyc", notes: "mine" });
    const again = db.addJob({ url: LI(7) + "?trk=abc", company: "Acme", title: "v2" });
    expect(again.id).toBe(id);
    expect(db.getJob(id)).toMatchObject({ title: "v2", status: "review", track: "nyc", notes: "mine" });
    expect(db.stats()).toEqual({ review: 1 });
  });

  it("upserts on the exact URL when there is no LinkedIn id", () => {
    const a = db.addJob({ url: "https://example.com/job/9", title: "v1" });
    const b = db.addJob({ url: "https://example.com/job/9", title: "v2" });
    expect(b.id).toBe(a.id);
    expect(db.getJob(a.id).title).toBe("v2");
  });

  it("files blacklisted aggregators straight to trash, matching the normalized name exactly", () => {
    const { id } = db.addJob({ url: LI(2), company: "  JOBOT ", title: "t" });
    expect(db.getJob(id)).toMatchObject({ status: "trash", notes: "blacklisted: JOBOT" });
    const real = db.addJob({ url: LI(3), company: "Jobot Labs", title: "t" });
    expect(db.getJob(real.id).status).toBe("incoming");
  });

  it("flags duplicateCompany when the company already has a committed job", () => {
    const first = db.addJob({ url: LI(10), company: "Acme", title: "t" });
    expect(db.addJob({ url: LI(11), company: "acme", title: "t" }).duplicateCompany).toBe(false);
    db.updateJob(first.id, { status: "applied" });
    expect(db.addJob({ url: LI(12), company: " ACME ", title: "t" }).duplicateCompany).toBe(true);
    expect(db.addJob({ url: LI(13), company: "", title: "t" }).duplicateCompany).toBe(false);
  });
});

describe("listJobs", () => {
  beforeEach(() => {
    at("2026-11-01T12:00:00Z");
    db.addJob({ url: LI(1), company: "Alpha", title: "Backend Engineer", body: "python" });
    at("2026-11-02T12:00:00Z");
    const b = db.addJob({ url: LI(2), company: "Beta", title: "Designer", body: "figma" });
    db.updateJob(b.id, { track: "boston" });
    at("2026-11-03T12:00:00Z");
    const c = db.addJob({ url: LI(3), company: "Alpha", title: "Data", body: "sql" });
    db.updateJob(c.id, { status: "applied" });
  });

  it("returns every job, most recently updated first", () => {
    expect(db.listJobs().map((j) => j.linkedin_id)).toEqual(["3", "2", "1"]);
  });

  it("filters by status, track and free text over company/title/body", () => {
    expect(db.listJobs({ status: "applied" }).map((j) => j.linkedin_id)).toEqual(["3"]);
    expect(db.listJobs({ track: "boston" }).map((j) => j.linkedin_id)).toEqual(["2"]);
    expect(db.listJobs({ q: "engineer" }).map((j) => j.linkedin_id)).toEqual(["1"]);
    expect(db.listJobs({ q: "FIGMA" }).map((j) => j.linkedin_id)).toEqual(["2"]);
    expect(db.listJobs({ q: "alpha", status: "incoming" }).map((j) => j.linkedin_id)).toEqual(["1"]);
  });

  it("flags duplicateCompany only on uncommitted rows of a committed company", () => {
    const byId = Object.fromEntries(db.listJobs().map((j) => [j.linkedin_id, j.duplicateCompany]));
    expect(byId).toEqual({ 1: true, 2: false, 3: false });
  });
});

describe("updateJob", () => {
  it("only accepts known statuses and tracks, and returns null when nothing valid is given", () => {
    const { id } = db.addJob({ url: LI(1), title: "t" });
    expect(db.updateJob(id, { status: "bogus", track: "mars" })).toBeNull();
    expect(db.updateJob(id, { title: "nope" })).toBeNull();
    expect(db.updateJob(id, { status: "bogus", track: "sf" })).toMatchObject({ status: "incoming", track: "sf" });
  });

  it("returns null for a missing job", () => {
    expect(db.updateJob(999, { status: "review" })).toBeNull();
  });

  it("stringifies notes the way existing rows store them", () => {
    const { id } = db.addJob({ url: LI(1), title: "t" });
    expect(db.updateJob(id, { notes: "hello" }).notes).toBe("hello");
    expect(db.updateJob(id, { notes: null }).notes).toBe("None");
    expect(db.updateJob(id, { notes: true }).notes).toBe("True");
    expect(db.updateJob(id, { notes: 42 }).notes).toBe("42");
  });

  it("sets applied_at the first time a job becomes applied and never moves it", () => {
    at("2026-11-01T10:00:00Z");
    const { id } = db.addJob({ url: LI(1), title: "t" });
    expect(db.updateJob(id, { status: "review" }).applied_at).toBeNull();
    at("2026-11-02T10:00:00Z");
    expect(db.updateJob(id, { status: "applied" }).applied_at).toBe("2026-11-02T10:00:00+00:00");
    at("2026-11-03T10:00:00Z");
    db.updateJob(id, { status: "rejected" });
    const again = db.updateJob(id, { status: "applied" });
    expect(again.applied_at).toBe("2026-11-02T10:00:00+00:00");
    expect(again.updated_at).toBe("2026-11-03T10:00:00+00:00");
  });
});

describe("getJob / stats", () => {
  it("returns null for a missing job", () => {
    expect(db.getJob(1)).toBeNull();
  });

  it("counts jobs per status", () => {
    const a = db.addJob({ url: LI(1), title: "t" });
    db.addJob({ url: LI(2), title: "t" });
    db.updateJob(a.id, { status: "applied" });
    expect(db.stats()).toEqual({ applied: 1, incoming: 1 });
  });
});

describe("statsToday", () => {
  it("counts captures, applications and trashings since local midnight", () => {
    // 01:30 New York on Nov 5 = 06:30 UTC; local midnight is 05:00 UTC.
    at("2026-11-05T04:59:59Z"); // 23:59:59 local on Nov 4
    const old = db.addJob({ url: LI(1), title: "t" });
    at("2026-11-05T05:00:00Z");
    const fresh = db.addJob({ url: LI(2), title: "t" });
    db.addJob({ url: LI(3), company: "Jobot", title: "t" }); // trashed on capture
    db.updateJob(old.id, { status: "applied" });
    at("2026-11-05T06:30:00Z");
    db.updateJob(fresh.id, { status: "trash" });
    expect(db.statsToday()).toEqual({ incoming: 2, applied: 1, trashed: 2 });
  });
});

describe("statsDaily", () => {
  it("returns [] for an empty database", () => {
    expect(db.statsDaily()).toEqual([]);
  });

  it("groups by local day, zero-fills gaps through today, and counts rejections on updated_at", () => {
    at("2026-11-02T03:00:00Z"); // Nov 1, 23:00 local (UTC date would say Nov 2)
    const a = db.addJob({ url: LI(1), title: "t" });
    at("2026-11-03T15:00:00Z");
    db.updateJob(a.id, { status: "applied" });
    at("2026-11-04T15:00:00Z");
    db.updateJob(a.id, { status: "rejected" });
    at("2026-11-05T15:00:00Z");
    expect(db.statsDaily()).toEqual([
      { date: "2026-11-01", incoming: 1, applied: 0, rejected: 0 },
      { date: "2026-11-02", incoming: 0, applied: 0, rejected: 0 },
      { date: "2026-11-03", incoming: 0, applied: 1, rejected: 0 },
      { date: "2026-11-04", incoming: 0, applied: 0, rejected: 1 },
      { date: "2026-11-05", incoming: 0, applied: 0, rejected: 0 },
    ]);
  });

  it("limits the window to the last `days` days", () => {
    at("2026-10-01T15:00:00Z");
    db.addJob({ url: LI(1), title: "t" });
    at("2026-11-05T15:00:00Z");
    db.addJob({ url: LI(2), title: "t" });
    const out = db.statsDaily(3);
    expect(out.map((d) => d.date)).toEqual(["2026-11-03", "2026-11-04", "2026-11-05"]);
    expect(out[2].incoming).toBe(1);
  });

  it("zero-fills across a DST change without skipping or repeating days", () => {
    at("2026-10-31T15:00:00Z"); // US DST ends Nov 1
    db.addJob({ url: LI(1), title: "t" });
    at("2026-11-03T15:00:00Z");
    expect(db.statsDaily().map((d) => d.date)).toEqual([
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
    ]);
  });
});

describe("workdayTenantFromUrl", () => {
  it("returns the lower-cased tenant host", () => {
    expect(db.workdayTenantFromUrl("https://NVIDIA.wd5.myworkdayjobs.com/en-US/job/123")).toBe(
      "nvidia.wd5.myworkdayjobs.com"
    );
  });
  it("returns null for non-Workday URLs", () => {
    expect(db.workdayTenantFromUrl("https://example.com/myworkdayjobs.com")).toBeNull();
    expect(db.workdayTenantFromUrl(null)).toBeNull();
  });
});

describe("genPassword", () => {
  it("meets the policy: length, all four classes, no ambiguous characters", () => {
    for (let i = 0; i < 200; i++) {
      const pw = db.genPassword();
      expect(pw).toHaveLength(18);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[2-9]/);
      expect(pw).toMatch(/[!@#$%*?\-_]/);
      expect(pw).not.toMatch(/[lIoO01]/);
    }
  });
  it("never goes below 12 characters", () => {
    expect(db.genPassword(4)).toHaveLength(12);
    expect(db.genPassword(30)).toHaveLength(30);
  });
});

describe("ATS accounts", () => {
  it("returns null for unknown or empty tenants", () => {
    expect(db.getAccount("nope.wd1.myworkdayjobs.com")).toBeNull();
    expect(db.getAccount("  ")).toBeNull();
  });

  it("upserts on the normalized tenant, keeping created_at", () => {
    at("2026-11-01T10:00:00Z");
    const first = db.saveAccount({ tenant: " Acme.WD1.myworkdayjobs.com ", employer: "Acme", email: "a@x", password: "p1" });
    expect(first).toMatchObject({ tenant: "acme.wd1.myworkdayjobs.com", ats: "workday", notes: "" });
    at("2026-11-02T10:00:00Z");
    const second = db.saveAccount({ tenant: "acme.wd1.myworkdayjobs.com", employer: "Acme", email: "b@x", password: "p2" });
    expect(second).toMatchObject({ id: first.id, email: "b@x", password: "p2", created_at: first.created_at });
    expect(second.updated_at).toBe("2026-11-02T10:00:00+00:00");
    expect(db.getAccount("ACME.wd1.myworkdayjobs.com").id).toBe(first.id);
  });
});
