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

// A job walked to `status` through legal moves.
function jobIn(status, { track = null, ...extra } = {}) {
  const { id } = db.addJob({ url: LI(Math.floor(Math.random() * 1e9)), title: "t", ...extra }, { track });
  const path = {
    new: [],
    triaged: [["triaged", "human"]],
    in_progress: [["triaged", "human"], ["in_progress", "human"]],
    blocked: [["triaged", "human"], ["in_progress", "human"], ["blocked", "agent:a"]],
    ready: [["triaged", "human"], ["in_progress", "human"], ["ready", "agent:a"]],
    on_hold: [["on_hold", "human"]],
    applied: [["applied", "human"]],
    interviewing: [["applied", "human"], ["interviewing", "gmail"]],
    rejected: [["rejected", "human"]],
    trash: [["trash", "human"]],
  }[status];
  for (const [to, actor] of path) db.transition(id, to, { actor });
  return id;
}

describe("URL helpers", () => {
  it("extracts LinkedIn ids", () => {
    expect(db.linkedinIdFromUrl(LI(4486579587))).toBe("4486579587");
    expect(db.linkedinIdFromUrl("https://example.com/job/1")).toBeNull();
    expect(db.linkedinIdFromUrl(undefined)).toBeNull();
  });
  it("finds the Workday tenant", () => {
    expect(db.accountHostFromUrl("https://NVIDIA.wd5.myworkdayjobs.com/en-US/job/1")).toBe("nvidia.wd5.myworkdayjobs.com");
    expect(db.accountHostFromUrl("https://careers-acme.icims.com/jobs/1/login")).toBe("careers-acme.icims.com");
    expect(db.accountHostFromUrl("javascript:alert(1)")).toBeNull();
    expect(db.accountHostFromUrl(null)).toBeNull();
  });
  it("detects the ATS from an application URL's host", () => {
    expect(db.atsFromUrl("https://acme.wd1.myworkdayjobs.com/x")).toBe("workday");
    expect(db.atsFromUrl("https://boards.greenhouse.io/acme/jobs/1")).toBe("greenhouse");
    expect(db.atsFromUrl("https://job-boards.greenhouse.io/acme/jobs/1")).toBe("greenhouse");
    expect(db.atsFromUrl("https://jobs.ashbyhq.com/acme/1")).toBe("ashby");
    expect(db.atsFromUrl("https://jobs.lever.co/acme/1")).toBe("lever");
    expect(db.atsFromUrl("https://careers.acme.com/1")).toBe("other");
    expect(db.atsFromUrl("not a url")).toBeNull();
  });
});

describe("addJob", () => {
  it("creates a new job with a 'captured' event and seconds-precision UTC timestamps", () => {
    const { id, duplicateCompany, created } = db.addJob(
      { url: ` ${LI(1)} `, company: "  Acme ", title: " Engineer ", description: " text ", location: " NYC " },
      { actor: "bookmarklet", track: "remote" }
    );
    expect({ duplicateCompany, created }).toEqual({ duplicateCompany: false, created: true });
    const job = db.getJob(id);
    expect(job).toMatchObject({
      linkedin_id: "1",
      company: "Acme",
      title: "Engineer",
      body: "text",
      location: "NYC",
      source: "linkedin",
      track: "remote",
      status: "new",
      notes: "",
      needs: [],
      applied_at: null,
    });
    expect(job.created_at).toMatch(ISO_SECONDS);
    expect(db.listEvents(id)).toMatchObject([{ actor: "bookmarklet", from_status: null, to_status: "new", message: "captured" }]);
  });

  it("upserts on the LinkedIn id, refreshing captured fields but keeping status, notes and an existing body", () => {
    const { id } = db.addJob({ url: LI(7), company: "Acme", title: "v1", body: "full text" });
    db.transition(id, "triaged", { actor: "human" });
    db.setJobFields(id, { notes: "mine" });
    const again = db.addJob({ url: LI(7) + "?trk=abc", company: "Acme", title: "v2" });
    expect(again).toMatchObject({ id, created: false });
    expect(db.getJob(id)).toMatchObject({ title: "v2", body: "full text", status: "triaged", notes: "mine" });
  });

  it("upserts on the exact URL when there is no LinkedIn id", () => {
    const a = db.addJob({ url: "https://example.com/job/9", title: "v1" });
    expect(db.addJob({ url: "https://example.com/job/9", title: "v2" }).id).toBe(a.id);
  });

  it("files blacklisted aggregators to trash with the reason as an event", () => {
    const { id } = db.addJob({ url: LI(2), company: "  JOBOT ", title: "t" });
    expect(db.getJob(id).status).toBe("trash");
    expect(db.listEvents(id).at(-1)).toMatchObject({ from_status: "new", to_status: "trash", message: "blacklisted: JOBOT" });
    expect(db.getJob(db.addJob({ url: LI(3), company: "Jobot Labs", title: "t" }).id).status).toBe("new");
  });

  it("flags duplicateCompany once the company has a committed (triaged or later) job", () => {
    const first = db.addJob({ url: LI(10), company: "Acme", title: "t" });
    expect(db.addJob({ url: LI(11), company: "acme", title: "t" }).duplicateCompany).toBe(false);
    db.transition(first.id, "triaged", { actor: "agent:triage" });
    expect(db.addJob({ url: LI(12), company: " ACME ", title: "t" }).duplicateCompany).toBe(true);
  });
});

describe("transition", () => {
  it("moves the job, records who/when/why, and returns the updated job", () => {
    at("2026-11-01T10:00:00Z");
    const { id } = db.addJob({ url: LI(1), title: "t" });
    at("2026-11-01T11:00:00Z");
    const job = db.transition(id, "triaged", { actor: "agent:triage", message: "fits" });
    expect(job).toMatchObject({ id, status: "triaged", updated_at: "2026-11-01T11:00:00+00:00" });
    expect(db.listEvents(id).at(-1)).toMatchObject({
      actor: "agent:triage",
      from_status: "new",
      to_status: "triaged",
      message: "fits",
      at: "2026-11-01T11:00:00+00:00",
    });
  });

  it("refuses moves the actor may not make, naming the allowed ones, and changes nothing", () => {
    const id = jobIn("ready");
    expect(() => db.transition(id, "applied", { actor: "agent:a" })).toThrowError(
      expect.objectContaining({ name: "TransitionError", code: "not_allowed", allowed: ["on_hold"] })
    );
    expect(db.getJob(id).status).toBe("ready");
    expect(() => db.transition(id, "ready", { actor: "human" })).toThrow(/cannot move/);
    expect(() => db.transition(id, "bogus", { actor: "human" })).toThrow(/unknown status/);
    expect(() => db.transition(id, "applied", { actor: "migration" })).toThrow(/unknown actor/);
    expect(() => db.transition(999, "trash", { actor: "human" })).toThrowError(expect.objectContaining({ code: "not_found" }));
  });

  it("lets a human override the rules, and records that", () => {
    const id = jobIn("rejected");
    db.transition(id, "applied", { actor: "human", override: true, message: "fixing a misclick" });
    expect(db.getJob(id).status).toBe("applied");
    expect(db.listEvents(id).at(-1).data).toEqual({ override: true });
    const other = jobIn("rejected");
    expect(() => db.transition(other, "applied", { actor: "agent:a", override: true })).toThrow(/cannot move/);
  });

  it("sets applied_at the first time only", () => {
    at("2026-11-02T10:00:00Z");
    const id = jobIn("applied");
    at("2026-11-03T10:00:00Z");
    db.transition(id, "rejected", { actor: "gmail" });
    db.transition(id, "applied", { actor: "human", override: true });
    expect(db.getJob(id).applied_at).toBe("2026-11-02T10:00:00+00:00");
  });

  it("queues 'start' on Start and 'unblock' with the answers on Unblock, and clears needs", () => {
    const id = jobIn("triaged");
    db.transition(id, "in_progress", { actor: "human" });
    const first = db.queueNext("agent:a");
    expect(first.message).toMatchObject({ kind: "start", payload: null });

    db.transition(id, "blocked", { actor: "agent:a", data: { needs: [{ type: "question", q: "Java level 1–3" }, { type: "consent", text: "Privacy" }] } });
    expect(db.getJob(id).needs).toEqual([
      { id: "n1", type: "question", q: "Java level 1–3", text: "Java level 1–3" },
      { id: "n2", type: "consent", text: "Privacy" },
    ]);
    db.transition(id, "in_progress", { actor: "bookmarklet", data: { answers: { n1: "3" } } });
    expect(db.getJob(id).needs).toEqual([]);
    expect(db.queueNext("agent:b").message).toMatchObject({ kind: "unblock", payload: { n1: "3" } });
  });

  it("drops the owner and closes open queue messages when the job leaves in_progress", () => {
    const id = jobIn("in_progress");
    db.queueNext("agent:a");
    expect(db.getJob(id).owner).toBe("agent:a");
    db.transition(id, "ready", { actor: "agent:a" });
    expect(db.getJob(id)).toMatchObject({ owner: null, lease_until: null });
    db.transition(id, "in_progress", { actor: "human" }); // send back: a new start message
    expect(db.queueNext("agent:b").message.kind).toBe("start");
    db.transition(id, "on_hold", { actor: "human" });
    expect(db.queueNext("agent:c")).toBeNull();
  });
});

describe("agent queue + lease", () => {
  it("returns null when there is nothing to do", () => {
    expect(db.queueNext("agent:a")).toBeNull();
  });

  it("hands each message out once, oldest first, with the job and its events", () => {
    at("2026-11-01T10:00:00Z");
    const a = jobIn("in_progress");
    at("2026-11-01T10:05:00Z");
    const b = jobIn("in_progress");
    const first = db.queueNext("agent:1");
    expect(first.job).toMatchObject({ id: a, owner: "agent:1" });
    expect(first.job.events.at(-1)).toMatchObject({ actor: "agent:1", message: "took start" });
    expect(db.queueNext("agent:2").job.id).toBe(b);
    expect(db.queueNext("agent:3")).toBeNull();
  });

  it("keeps a job with a live lease away from other agents (one subagent per job)", () => {
    at("2026-11-01T10:00:00Z");
    const id = jobIn("in_progress");
    db.queueNext("agent:1");
    db.transition(id, "on_hold", { actor: "agent:1" });
    db.transition(id, "in_progress", { actor: "human" });
    db.renewLease(id, "agent:1");
    expect(db.queueNext("agent:2")).toBeNull();
    expect(db.queueNext("agent:1").job.id).toBe(id);
  });

  it("re-offers a message whose agent's lease expired", () => {
    at("2026-11-01T10:00:00Z");
    const id = jobIn("in_progress");
    db.queueNext("agent:dead", { leaseMinutes: 30 });
    at("2026-11-01T10:29:00Z");
    expect(db.queueNext("agent:2")).toBeNull();
    at("2026-11-01T10:31:00Z");
    const again = db.queueNext("agent:2");
    expect(again.job).toMatchObject({ id, owner: "agent:2" });
  });

  it("skips jobs with a pending referral", () => {
    const id = jobIn("in_progress");
    db.setJobFields(id, { referral: "Jane at Acme" });
    expect(db.queueNext("agent:a")).toBeNull();
    db.setJobFields(id, { referral: "" });
    expect(db.queueNext("agent:a").job.id).toBe(id);
  });

  it("assertOwner refuses agents other than the lease holder", () => {
    const id = jobIn("in_progress");
    expect(() => db.assertOwner(id, "agent:x")).not.toThrow();
    db.queueNext("agent:a");
    expect(() => db.assertOwner(id, "agent:a")).not.toThrow();
    expect(() => db.assertOwner(id, "agent:b")).toThrowError(expect.objectContaining({ code: "owned" }));
  });

  it("releaseJob keeps the status, drops the lock and logs the stop", () => {
    const id = jobIn("in_progress");
    db.queueNext("agent:a");
    expect(db.releaseJob(id, { actor: "agent:a", message: "tab group vanished" })).toBe(true);
    expect(db.getJob(id)).toMatchObject({ status: "in_progress", owner: null });
    expect(db.listEvents(id).at(-1)).toMatchObject({ message: "tab group vanished", data: { stopped: true } });
    expect(db.queueNext("agent:b")).toBeNull(); // the taken message is closed, not re-offered
  });
});

describe("fields, needs, events", () => {
  it("setJobFields updates only editable fields and detects the ATS from apply_url", () => {
    const { id } = db.addJob({ url: LI(1), title: "t" });
    const job = db.setJobFields(id, { apply_url: "https://jobs.ashbyhq.com/acme/1", status: "applied", tab_id: 42, scam_flag: 1 });
    expect(job).toMatchObject({ apply_url: "https://jobs.ashbyhq.com/acme/1", ats: "ashby", status: "new", tab_id: 42, scam_flag: true });
    expect(db.setJobFields(id, { apply_url: "https://boards.greenhouse.io/x", ats: "other" }).ats).toBe("other");
    expect(db.setJobFields(id, { title: "nope" })).toBeNull();
    expect(db.setJobFields(999, { notes: "x" })).toBeNull();
    expect(db.setJobFields(id, { referral: "", tab_id: "7" })).toMatchObject({ referral: null, tab_id: null });
  });

  it("resolveNeed removes one item and logs it", () => {
    const id = jobIn("in_progress");
    db.transition(id, "blocked", { actor: "agent:a", data: { needs: [{ type: "consent", text: "Privacy" }, { type: "captcha", text: "hCaptcha" }] } });
    expect(db.resolveNeed(id, "n1")).toEqual([{ id: "n2", type: "captcha", text: "hCaptcha" }]);
    expect(db.listEvents(id).at(-1).message).toBe("resolved: Privacy");
    expect(db.resolveNeed(id, "nope")).toBeNull();
  });

  it("addEvent appends a timeline note and bumps activity", () => {
    at("2026-11-01T10:00:00Z");
    const { id } = db.addJob({ url: LI(1), title: "t" });
    at("2026-11-01T12:00:00Z");
    expect(db.addEvent(id, { actor: "agent:a", message: "step 4/7" })).toMatchObject({ message: "step 4/7", to_status: null });
    expect(db.getJob(id).updated_at).toBe("2026-11-01T12:00:00+00:00");
    expect(db.addEvent(999, { actor: "human", message: "x" })).toBeNull();
  });

  it("onChange reports every committed write", () => {
    const seen = [];
    db.onChange((c) => seen.push(c));
    const { id } = db.addJob({ url: LI(1), title: "t" });
    db.transition(id, "triaged", { actor: "human" });
    db.setJobFields(id, { notes: "x" });
    db.addEvent(id, { actor: "human", message: "m" });
    expect(seen).toEqual([
      { kind: "created", jobId: id },
      { kind: "transition", jobId: id, to: "triaged", actor: "human" },
      { kind: "updated", jobId: id, actor: "human" },
      { kind: "event", jobId: id, actor: "human" },
    ]);
  });
});

describe("list queries", () => {
  it("listJobSummaries pages a folder without bodies, with the latest event as a snippet", () => {
    at("2026-11-01T10:00:00Z");
    const ids = [1, 2, 3].map((n) => db.addJob({ url: LI(n), title: `T${n}`, company: "Co", body: "long text" }).id);
    at("2026-11-02T10:00:00Z");
    db.addEvent(ids[0], { actor: "human", message: "called recruiter" });
    const page = db.listJobSummaries({ folder: "new", limit: 2 });
    expect(page.total).toBe(3);
    expect(page.jobs.map((j) => j.id)).toEqual([ids[0], ids[2]]);
    expect(page.jobs[0]).toMatchObject({ last_event: "called recruiter", needs: [] });
    expect("body" in page.jobs[0]).toBe(false);
    expect(db.listJobSummaries({ folder: "new", limit: 2, offset: 2 }).jobs.map((j) => j.id)).toEqual([ids[1]]);
  });

  it("sorts 'waiting for me' oldest first and filters by track and text", () => {
    at("2026-11-01T10:00:00Z");
    const older = jobIn("blocked", { company: "Old", track: "nyc" });
    at("2026-11-02T10:00:00Z");
    const newer = jobIn("ready", { company: "New" });
    expect(db.listJobSummaries({ folder: "waiting" }).jobs.map((j) => j.id)).toEqual([older, newer]);
    expect(db.listJobSummaries({ folder: "waiting", q: "new" }).jobs.map((j) => j.id)).toEqual([newer]);
    expect(() => db.listJobSummaries({ folder: "nope" })).toThrow(/unknown folder/);
  });

  it("folderCounts covers every folder, optionally per track", () => {
    jobIn("new");
    jobIn("blocked");
    jobIn("ready");
    jobIn("trash");
    const counts = db.folderCounts();
    expect(counts).toEqual({ waiting: 2, new: 1, triaged: 0, in_progress: 0, on_hold: 0, applied: 0, interviewing: 0, rejected: 0, trash: 1 });
    expect(db.folderCounts({ track: "nyc" }).waiting).toBe(0);
    jobIn("ready", { track: "nyc" });
    expect(db.folderCounts({ track: "nyc" })).toMatchObject({ waiting: 1, new: 0 });
    expect(db.listJobSummaries({ folder: "waiting", track: "nyc" }).total).toBe(1);
  });

  it("attention lists blocked and ready jobs", () => {
    const b = jobIn("blocked");
    jobIn("new");
    expect(db.attention().map((j) => j.id)).toEqual([b]);
  });
});

describe("findJob (bookmarklet ops)", () => {
  it("matches by id, then #id in the title, then apply_url host+path, then posting URL", () => {
    const a = jobIn("blocked");
    db.setJobFields(a, { apply_url: "https://acme.wd1.myworkdayjobs.com/en-US/job/123/apply/" });
    const b = db.addJob({ url: "https://example.com/careers/9", title: "t" }).id;
    expect(db.findJob({ jobId: a }).job.id).toBe(a);
    expect(db.findJob({ title: `🟡 #${a} Apply – Acme` }).job.id).toBe(a);
    expect(db.findJob({ url: "https://ACME.wd1.myworkdayjobs.com/en-US/job/123/apply?x=1" }).job.id).toBe(a);
    expect(db.findJob({ url: "https://example.com/careers/9/" }).job.id).toBe(b);
    expect(db.findJob({ url: LI(db.getJob(a).linkedin_id) + "?trk=x" }).job.id).toBe(a);
  });

  it("reports no match and ambiguity", () => {
    expect(db.findJob({ jobId: 99 })).toEqual({ error: "no match" });
    expect(db.findJob({ url: "https://nowhere.example/x" })).toEqual({ error: "no match" });
    const x = db.addJob({ url: "https://example.com/a", title: "t" }).id;
    const y = db.addJob({ url: "https://example.com/b", title: "t" }).id;
    db.setJobFields(x, { apply_url: "https://boards.greenhouse.io/acme/1" });
    db.setJobFields(y, { apply_url: "https://boards.greenhouse.io/acme/1" });
    expect(db.findJob({ url: "https://boards.greenhouse.io/acme/1" })).toEqual({ error: "ambiguous", candidates: [x, y] });
  });
});

describe("stats", () => {
  it("counts jobs per status", () => {
    jobIn("new");
    jobIn("applied");
    expect(db.stats()).toEqual({ new: 1, applied: 1 });
  });

  it("statsToday counts captures, first applications and trashings since local midnight", () => {
    at("2026-11-05T04:59:59Z"); // 23:59:59 local on Nov 4 (New York)
    const old = db.addJob({ url: LI(1), title: "t" }).id;
    at("2026-11-05T05:00:00Z");
    const fresh = db.addJob({ url: LI(2), title: "t" }).id;
    db.addJob({ url: LI(3), company: "Jobot", title: "t" }); // trashed on capture
    db.transition(old, "applied", { actor: "human" });
    db.transition(fresh, "trash", { actor: "human" });
    expect(db.statsToday()).toEqual({ captured: 2, applied: 1, trashed: 2 });
  });

  it("statsDaily groups by local day from the event log, zero-filled through today", () => {
    at("2026-11-02T03:00:00Z"); // Nov 1, 23:00 local
    const a = db.addJob({ url: LI(1), title: "t" }).id;
    at("2026-11-03T15:00:00Z");
    db.transition(a, "applied", { actor: "human" });
    at("2026-11-04T15:00:00Z");
    db.transition(a, "rejected", { actor: "gmail" });
    db.setJobFields(a, { notes: "edited later" }); // doesn't move the rejection
    at("2026-11-05T15:00:00Z");
    expect(db.statsDaily()).toEqual([
      { date: "2026-11-01", captured: 1, applied: 0, rejected: 0 },
      { date: "2026-11-02", captured: 0, applied: 0, rejected: 0 },
      { date: "2026-11-03", captured: 0, applied: 1, rejected: 0 },
      { date: "2026-11-04", captured: 0, applied: 0, rejected: 1 },
      { date: "2026-11-05", captured: 0, applied: 0, rejected: 0 },
    ]);
  });

  it("statsDaily limits to `days` ≥ 1 and treats anything else as all history", () => {
    at("2026-10-01T15:00:00Z");
    db.addJob({ url: LI(1), title: "t" });
    at("2026-11-05T15:00:00Z");
    expect(db.statsDaily(3).map((d) => d.date)).toEqual(["2026-11-03", "2026-11-04", "2026-11-05"]);
    expect(db.statsDaily(0)).toHaveLength(36);
    expect(db.statsDaily(-5)).toHaveLength(36);
  });

  it("returns [] for an empty database", () => {
    expect(db.statsDaily()).toEqual([]);
  });
});

describe("accounts", () => {
  it("genPassword meets the policy", () => {
    for (let i = 0; i < 200; i++) {
      const pw = db.genPassword();
      expect(pw).toHaveLength(18);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[2-9]/);
      expect(pw).toMatch(/[!@#$%*?\-_]/);
      expect(pw).not.toMatch(/[lIoO01]/);
    }
    expect(db.genPassword(4)).toHaveLength(12);
  });

  it("upserts on the normalized tenant, keeping created_at", () => {
    at("2026-11-01T10:00:00Z");
    const first = db.saveAccount({ tenant: " Acme.WD1.myworkdayjobs.com ", employer: "Acme", email: "a@x", password: "p1" });
    at("2026-11-02T10:00:00Z");
    const second = db.saveAccount({ tenant: "acme.wd1.myworkdayjobs.com", employer: "Acme", email: "b@x", password: "p2" });
    expect(second).toMatchObject({ id: first.id, email: "b@x", created_at: first.created_at });
    expect(db.getAccount("ACME.wd1.myworkdayjobs.com").id).toBe(first.id);
    expect(db.getAccount("  ")).toBeNull();
  });

  it("infers the ATS from the tenant unless given", () => {
    expect(db.saveAccount({ tenant: "acme.wd1.myworkdayjobs.com", email: "a@x", password: "p" }).ats).toBe("workday");
    expect(db.saveAccount({ tenant: "acme.icims.com", email: "a@x", password: "p" }).ats).toBe("other");
    expect(db.saveAccount({ tenant: "acme.taleo.net", email: "a@x", password: "p", ats: "taleo" }).ats).toBe("taleo");
  });

  it("accountForJob finds the account from the job's apply_url or url host, any ATS", () => {
    db.saveAccount({ tenant: "acme.wd1.myworkdayjobs.com", employer: "Acme", email: "a@x", password: "p" });
    db.saveAccount({ tenant: "careers-beta.icims.com", employer: "Beta", email: "b@x", password: "p" });
    expect(db.accountForJob({ apply_url: "https://acme.wd1.myworkdayjobs.com/job/1" })).toMatchObject({ email: "a@x" });
    expect(db.accountForJob({ url: "https://careers-beta.icims.com/jobs/9" })).toMatchObject({ email: "b@x" });
    expect(db.accountForJob({ url: "https://example.com" })).toBeNull();
  });

  it("accountForJob prefers the account linked by an event (shared ATS hosts)", () => {
    const { id } = db.addJob({ url: "https://jobs.dayforcehcm.com/en-US/acme/1", title: "t" });
    db.saveAccount({ tenant: "jobs.dayforcehcm.com", email: "wrong@x", password: "p" });
    db.saveAccount({ tenant: "jobs.dayforcehcm.com/acme", email: "a@x", password: "p" });
    expect(db.accountForJob(db.getJob(id))).toMatchObject({ email: "wrong@x" });
    db.addEvent(id, { actor: "agent:a", message: "linked", data: { account: "jobs.dayforcehcm.com/acme" } });
    expect(db.accountForJob(db.getJob(id))).toMatchObject({ email: "a@x" });
  });
});
