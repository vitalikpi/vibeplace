import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import * as db from "../electron/db.js";
import { createServer } from "../electron/server.js";
import { HOST, freshDb, tempDataRoot } from "./helpers.js";

let app;
beforeEach(() => {
  freshDb();
  tempDataRoot({
    "resume.txt": "My resume",
    "settings.json": JSON.stringify({ email: "me@example.com", tracks: ["remote", { key: "nyc", label: "NYC" }] }),
  });
  app = createServer();
});

let nextId = 1;
async function rpc(method, params = {}) {
  const res = await request(app)
    .post("/mcp")
    .set("Host", HOST)
    .set("Accept", "application/json, text/event-stream")
    .send({ jsonrpc: "2.0", id: nextId++, method, params })
    .expect(200);
  if (res.body.error) throw new Error(JSON.stringify(res.body.error));
  return res.body.result;
}
const call = (name, args = {}) => rpc("tools/call", { name, arguments: args });
// The tool's value, or throws with the tool error text.
async function value(name, args) {
  const r = await call(name, args);
  if (r.isError) throw new Error(r.content[0].text);
  return r.structuredContent.result;
}

const LI = (n) => `https://www.linkedin.com/jobs/view/${n}/`;
const started = (n = 1) => {
  const { id } = db.addJob({ url: LI(n), company: `Co${n}`, title: "Eng" });
  db.transition(id, "triaged", { actor: "human" });
  db.transition(id, "in_progress", { actor: "human" });
  return id;
};

describe("transport guard", () => {
  it("refuses any request with an Origin header (browsers)", async () => {
    await request(app).post("/mcp").set("Host", HOST).set("Origin", "https://evil.example").send({}).expect(403);
  });
  it("refuses a foreign Host", async () => {
    await request(app).post("/mcp").set("Host", "evil.example:17085").send({}).expect(403);
  });
  it("answers GET and DELETE with 405 (stateless server)", async () => {
    await request(app).get("/mcp").set("Host", HOST).expect(405);
    await request(app).delete("/mcp").set("Host", HOST).expect(405);
  });
});

describe("tool list", () => {
  it("exposes the workflow verbs and no direct status setter", async () => {
    const { tools } = await rpc("tools/list");
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "add_event",
        "add_job",
        "attention",
        "create_account",
        "get_account",
        "get_job",
        "get_resume",
        "hold_job",
        "list_jobs",
        "mark_blocked",
        "mark_ready",
        "queue_next",
        "record_outcome",
        "release_job",
        "stats",
        "triage_job",
        "update_progress",
      ].sort()
    );
    expect(tools.every((t) => t.outputSchema)).toBe(true);
  });
});

describe("reading", () => {
  it("list_jobs filters by status, omits bodies by default and truncates them on request", async () => {
    db.addJob({ url: LI(1), title: "big", body: "x".repeat(5000) });
    db.addJob({ url: LI(2), title: "small", body: "short" });
    const lean = await call("list_jobs", { status: "new" });
    expect(lean.structuredContent.result).toHaveLength(2);
    expect(lean.structuredContent.result.every((j) => !("body" in j))).toBe(true);
    const full = await value("list_jobs", { include_body: true });
    const byTitle = Object.fromEntries(full.map((j) => [j.title, j]));
    expect(byTitle.big).toMatchObject({ bodyTruncated: true });
    expect(byTitle.big.body).toHaveLength(4000);
    expect(byTitle.small).toMatchObject({ body: "short", bodyTruncated: false });
    expect(await value("list_jobs", { limit: 0 })).toHaveLength(1);
  });

  it("list_jobs rejects old status names", async () => {
    expect((await call("list_jobs", { status: "incoming" })).isError).toBe(true);
  });

  it("get_job returns the record with its timeline, or null with no text", async () => {
    const { id } = db.addJob({ url: LI(1), title: "t" });
    const job = await value("get_job", { job_id: id });
    expect(job.events).toMatchObject([{ to_status: "new", message: "captured" }]);
    const missing = await call("get_job", { job_id: 999 });
    expect(missing.content).toEqual([]);
    expect(missing.structuredContent).toEqual({ result: null });
  });

  it("stats returns counts and today's numbers; get_resume reads resume.txt", async () => {
    db.addJob({ url: LI(1), title: "t" });
    expect(await value("stats")).toEqual({ counts: { new: 1 }, today: { captured: 1, applied: 0, trashed: 0 } });
    expect(await value("get_resume")).toBe("My resume");
  });
});

describe("capture + triage", () => {
  it("add_job creates a 'new' job on the first configured track, as the named agent", async () => {
    const { id, created } = await value("add_job", { url: LI(1), company: "Acme", description: "desc", agent: "scout" });
    expect(created).toBe(true);
    expect(db.getJob(id)).toMatchObject({ status: "new", source: "manual", body: "desc", track: "remote" });
    expect(db.listEvents(id)[0].actor).toBe("agent:scout");
  });

  it("triage_job go → triaged with a track; no_go → trash; reason on the timeline", async () => {
    const a = db.addJob({ url: LI(1), title: "t" }).id;
    const b = db.addJob({ url: LI(2), title: "t" }).id;
    expect(await value("triage_job", { job_id: a, decision: "go", reason: "fits", track: "nyc" })).toMatchObject({
      status: "triaged",
      track: "nyc",
    });
    await value("triage_job", { job_id: b, decision: "no_go", reason: "agency" });
    expect(db.getJob(b).status).toBe("trash");
    expect(db.listEvents(b).at(-1)).toMatchObject({ actor: "agent:triage", message: "NO-GO: agency" });
  });

  it("triage_job refuses unknown tracks, unknown jobs and already-triaged jobs", async () => {
    const id = db.addJob({ url: LI(1), title: "t" }).id;
    await expect(value("triage_job", { job_id: id, decision: "go", reason: "r", track: "mars" })).rejects.toThrow(
      /unknown track mars; known: remote, nyc/
    );
    expect(db.getJob(id).status).toBe("new");
    await expect(value("triage_job", { job_id: 999, decision: "go", reason: "r" })).rejects.toThrow(/not found/);
    await value("triage_job", { job_id: id, decision: "go", reason: "r" });
    await expect(value("triage_job", { job_id: id, decision: "go", reason: "r" })).rejects.toThrow(/cannot move/);
  });
});

describe("the apply loop", () => {
  it("runs start → blocked (with a message) → (human unblock) → ready, with leases", async () => {
    const id = started();
    const work = await value("queue_next", { agent: "apply-1" });
    expect(work.message).toMatchObject({ kind: "start" });
    expect(work.job).toMatchObject({ id, owner: "agent:apply-1" });
    expect(await value("queue_next", { agent: "apply-2" })).toBeNull();

    await value("update_progress", {
      job_id: id,
      agent: "apply-1",
      step: "workday:4/7",
      tab_id: 1234,
      apply_url: "https://acme.wd1.myworkdayjobs.com/job/1/apply",
      message: "filled contact info",
    });
    expect(db.getJob(id)).toMatchObject({ step: "workday:4/7", tab_id: 1234, ats: "workday" });

    const blocked = await value("mark_blocked", { job_id: id, agent: "apply-1", message: "Accept the privacy consent" });
    expect(blocked).toMatchObject({ status: "blocked", owner: null });
    expect(db.listEvents(id).at(-1)).toMatchObject({ actor: "agent:apply-1", to_status: "blocked", message: "Accept the privacy consent" });

    db.transition(id, "in_progress", { actor: "human" });
    const resume = await value("queue_next", { agent: "apply-2" });
    expect(resume.message).toMatchObject({ kind: "unblock" });

    expect(await value("mark_ready", { job_id: id, agent: "apply-2", message: "all filled" })).toMatchObject({ status: "ready" });
    expect(db.getJob(id).owner).toBeNull();
  });

  it("refuses agents acting on a job another agent holds", async () => {
    const id = started();
    await value("queue_next", { agent: "apply-1" });
    await expect(value("mark_ready", { job_id: id, agent: "apply-2" })).rejects.toThrow(/held by agent:apply-1/);
    await expect(value("update_progress", { job_id: id, agent: "apply-2", step: "x" })).rejects.toThrow(/held by/);
    expect(db.getJob(id).step).toBeNull();
  });

  it("refuses moves the workflow forbids (agents never set applied, never ready from triaged)", async () => {
    const { id } = db.addJob({ url: LI(1), title: "t" });
    db.transition(id, "triaged", { actor: "human" });
    await expect(value("mark_ready", { job_id: id, agent: "a" })).rejects.toThrow(
      /cannot move job \d+ from triaged to ready as agent; allowed: on_hold, trash/
    );
  });

  it("hold_job parks the job and can flag it as a scam", async () => {
    const id = started();
    await value("queue_next", { agent: "a" });
    expect(await value("hold_job", { job_id: id, agent: "a", reason: "no verifiable employer", scam: true })).toMatchObject({
      status: "on_hold",
      scam_flag: true,
    });
  });

  it("release_job drops the lease and logs the stop; add_event notes the timeline", async () => {
    const id = started();
    await value("queue_next", { agent: "a" });
    expect(await value("release_job", { job_id: id, agent: "a", message: "tab group vanished" })).toMatchObject({
      status: "in_progress",
      owner: null,
    });
    expect(await value("add_event", { job_id: id, agent: "a", message: "will retry" })).toMatchObject({ actor: "agent:a" });
    await expect(value("add_event", { job_id: 999, agent: "a", message: "x" })).rejects.toThrow(/not found/);
  });

  it("attention lists jobs waiting for the human", async () => {
    const id = started();
    await value("queue_next", { agent: "a" });
    await value("mark_ready", { job_id: id, agent: "a" });
    expect((await value("attention")).map((j) => j.id)).toEqual([id]);
  });
});

describe("outcomes", () => {
  it("record_outcome moves the job as actor gmail with the evidence", async () => {
    const id = db.addJob({ url: LI(1), title: "t" }).id;
    expect(await value("record_outcome", { job_id: id, outcome: "applied", evidence: "Thanks for applying" })).toMatchObject({
      status: "applied",
    });
    await value("record_outcome", { job_id: id, outcome: "interviewing", evidence: "Let's schedule" });
    expect(db.listEvents(id).at(-1)).toMatchObject({ actor: "gmail", to_status: "interviewing", message: "Let's schedule" });
  });
  it("record_outcome refuses impossible outcomes", async () => {
    const id = db.addJob({ url: LI(1), title: "t" }).id;
    await expect(value("record_outcome", { job_id: id, outcome: "interviewing", evidence: "x" })).rejects.toThrow(/cannot move/);
  });
});

describe("accounts", () => {
  it("create_account creates once with the settings email, then returns the stored account", async () => {
    const first = await value("create_account", { tenant: "Acme.wd1.myworkdayjobs.com", employer: "Acme" });
    expect(first).toMatchObject({ tenant: "acme.wd1.myworkdayjobs.com", email: "me@example.com", created: true });
    expect(first.password).toHaveLength(18);
    const again = await value("create_account", { tenant: "acme.wd1.myworkdayjobs.com", email: "other@x" });
    expect(again).toMatchObject({ id: first.id, email: "me@example.com", created: false });
    expect(await value("get_account", { tenant: "acme.wd1.myworkdayjobs.com" })).toMatchObject({ id: first.id });
  });

  it("create_account works for any ATS and links the account to job_id once, without the password", async () => {
    const id = started();
    const rec = await value("create_account", { tenant: "jobs.dayforcehcm.com/acme", job_id: id, agent: "apply-1" });
    expect(rec).toMatchObject({ tenant: "jobs.dayforcehcm.com/acme", ats: "dayforce", created: true });
    expect(db.accountForJob(db.getJob(id))).toMatchObject({ id: rec.id });
    await value("create_account", { tenant: "jobs.dayforcehcm.com/acme", job_id: id, agent: "apply-1" });
    expect(db.getJob(id).account_tenant).toBe("jobs.dayforcehcm.com/acme");
    const linked = db.listEvents(id).filter((e) => /account for/.test(e.message || ""));
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ actor: "agent:apply-1" });
    expect(JSON.stringify(db.listEvents(id))).not.toContain(rec.password);
  });

  it("create_account rejects an unknown job_id without creating the account", async () => {
    await expect(value("create_account", { tenant: "acme.icims.com", job_id: 999 })).rejects.toThrow(/not found/);
    expect(db.getAccount("acme.icims.com")).toBeNull();
  });
});

describe("argument validation", () => {
  it("rejects arguments of the wrong type", async () => {
    expect((await call("get_job", { job_id: "seven" })).isError).toBe(true);
    expect((await call("mark_blocked", { job_id: 1, agent: "a", message: 42 })).isError).toBe(true);
  });
});
