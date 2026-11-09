import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import * as db from "../electron/db.js";
import { createServer } from "../electron/server.js";
import { HOST, freshDb, tempDataRoot } from "./helpers.js";

let app;
beforeEach(() => {
  freshDb();
  tempDataRoot({ "settings.json": JSON.stringify({ tracks: ["remote", "nyc"] }) });
  app = createServer();
});

// Every request needs the app's own Host (DNS-rebinding guard).
const get = (p) => request(app).get(p).set("Host", HOST);
const post = (p) => request(app).post(p).set("Host", HOST);

describe("Host guard", () => {
  it("rejects requests whose Host is not 127.0.0.1/localhost on the app's port", async () => {
    await request(app).get("/capture").set("Host", "evil.example:17085").expect(403);
    await request(app).get("/capture").set("Host", "127.0.0.1:9999").expect(403);
    await request(app).get("/capture").set("Host", `localhost:${process.env.PORT}`).expect(200);
  });
});

describe("POST /api/jobs (ingestion)", () => {
  it("accepts a text/plain JSON body from any origin and answers {id, duplicateCompany}", async () => {
    const res = await post("/api/jobs")
      .set("Origin", "https://jobs.example")
      .set("Content-Type", "text/plain")
      .send(JSON.stringify({ url: "https://example.com/j/1", company: "Acme", title: "Eng" }))
      .expect(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.body).toEqual({ id: expect.any(Number), duplicateCompany: false });
    expect(db.getJob(res.body.id)).toMatchObject({ company: "Acme", status: "new" });
  });

  it("accepts application/json too, maps description to the body and files the job on the first track", async () => {
    const res = await post("/api/jobs").send({ title: "Only a title", description: "selected text" }).expect(200);
    expect(db.getJob(res.body.id)).toMatchObject({ title: "Only a title", body: "selected text", track: "remote", status: "new" });
    expect(db.listEvents(res.body.id)[0].actor).toBe("bookmarklet");
  });

  it("rejects bodies without url or title, non-objects and invalid JSON", async () => {
    for (const body of ['{"company":"x"}', "[1,2]", "null", "not json", ""]) {
      const res = await post("/api/jobs").set("Content-Type", "text/plain").send(body).expect(400);
      expect(res.body).toEqual({ error: "missing url/title" });
    }
    expect(db.stats()).toEqual({});
  });

  it("answers the CORS / Private Network Access preflight", async () => {
    const res = await request(app)
      .options("/api/jobs")
      .set("Host", HOST)
      .set("Origin", "https://jobs.example")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Private-Network", "true")
      .expect(204);
    expect(res.headers).toMatchObject({
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-private-network": "true",
    });
  });
});

describe("capture pages", () => {
  it.each([
    ["/capture", "/api/jobs"],
    ["/capture-batch", "/api/jobs"],
    ["/act", "/api/act"],
  ])("%s is an HTML page that posts to %s and checks the response status", async (p, api) => {
    const res = await get(p).expect(200).expect("Content-Type", /html/);
    expect(res.text).toContain(`fetch('${api}'`);
    expect(res.text).toContain("r.ok");
  });
});

describe("POST /api/act (✅ Unblocked / ✅ Submitted)", () => {
  const LI = (n) => `https://www.linkedin.com/jobs/view/${n}/`;
  function blockedJob(n = 1) {
    const { id } = db.addJob({ url: LI(n), title: "t" });
    db.transition(id, "triaged", { actor: "human" });
    db.transition(id, "in_progress", { actor: "human" });
    db.queueNext("agent:a");
    db.transition(id, "blocked", { actor: "agent:a", message: "Accept the privacy consent" });
    db.setJobFields(id, { apply_url: "https://acme.wd1.myworkdayjobs.com/en-US/job/9/apply" });
    return id;
  }
  const act = (body) => post("/api/act").set("Content-Type", "text/plain").send(JSON.stringify(body));

  it("unblocks by job id, queueing an unblock for the agent", async () => {
    const id = blockedJob();
    const res = await act({ op: "unblock", job_id: id }).expect(200);
    expect(res.body).toEqual({ ok: true, job_id: id, status: "in_progress" });
    expect(db.listEvents(id).at(-1)).toMatchObject({ actor: "bookmarklet", from_status: "blocked", to_status: "in_progress" });
    expect(db.queueNext("agent:b").message).toMatchObject({ kind: "unblock" });
  });

  it("finds the job from '#<id>' in the page title, or from the application URL", async () => {
    const a = blockedJob(1);
    await act({ op: "unblock", title: `🟡 #${a} Apply – Acme` }).expect(200);
    const b = blockedJob(2);
    db.setJobFields(b, { apply_url: "https://boards.greenhouse.io/acme/jobs/77" });
    const res = await act({ op: "submitted", url: "https://boards.greenhouse.io/acme/jobs/77?gh_src=x" }).expect(200);
    expect(res.body).toEqual({ ok: true, job_id: b, status: "applied" });
    expect(db.getJob(b).applied_at).not.toBeNull();
  });

  it("accepts the id as a string", async () => {
    const id = blockedJob();
    await act({ op: "submitted", job_id: String(id) }).expect(200);
  });

  it("answers 404 when nothing matches and 409 when several jobs do", async () => {
    expect((await act({ op: "unblock", url: "https://nowhere.example/x" }).expect(404)).body).toEqual({ error: "no match" });
    const x = db.addJob({ url: "https://example.com/a", title: "t" }).id;
    const y = db.addJob({ url: "https://example.com/b", title: "t" }).id;
    db.setJobFields(x, { apply_url: "https://jobs.lever.co/acme/1" });
    db.setJobFields(y, { apply_url: "https://jobs.lever.co/acme/1" });
    expect((await act({ op: "submitted", url: "https://jobs.lever.co/acme/1" }).expect(409)).body).toEqual({
      error: "ambiguous",
      candidates: [x, y],
    });
  });

  it("answers 409 with the reason when the move isn't allowed", async () => {
    const { id } = db.addJob({ url: LI(5), title: "t" });
    const res = await act({ op: "unblock", job_id: id }).expect(409);
    expect(res.body).toMatchObject({ job_id: id, status: "new", error: expect.stringMatching(/cannot move/) });
  });

  it("rejects unknown ops and bad bodies", async () => {
    for (const body of [{ op: "delete", job_id: 1 }, {}, [1]]) await act(body).expect(400);
  });

  it("answers the preflight like /api/jobs", async () => {
    await request(app)
      .options("/api/act")
      .set("Host", HOST)
      .set("Access-Control-Request-Private-Network", "true")
      .expect(204)
      .expect("Access-Control-Allow-Private-Network", "true");
  });
});

describe("no UI API over HTTP", () => {
  it.each([
    ["get", "/api/jobs"],
    ["get", "/api/export"],
    ["get", "/api/stats"],
    ["get", "/api/stats/today"],
    ["get", "/api/stats/daily"],
    ["get", "/api/me"],
    ["get", "/api/bookmarklet"],
    ["patch", "/api/jobs/1"],
  ])("%s %s is not served", async (method, p) => {
    await request(app)[method](p).set("Host", HOST).expect(404);
  });

  it("serves a plain note at /", async () => {
    const res = await get("/").expect(200);
    expect(res.text).toMatch(/capture endpoint/);
  });
});
