import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import * as db from "../electron/db.js";
import { createServer } from "../electron/server.js";
import { HOST, freshDb, tempDataRoot } from "./helpers.js";

let app;
beforeEach(() => {
  freshDb();
  tempDataRoot({ "resume.txt": "My resume" });
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
const texts = (result) => result.content.map((c) => JSON.parse(c.text));

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

describe("tools", () => {
  it("lists the 8 tools existing skills rely on", async () => {
    const { tools } = await rpc("tools/list");
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["add_job", "create_account", "get_account", "get_job", "get_resume", "list_jobs", "stats", "update_job"].sort()
    );
    const listJobs = tools.find((t) => t.name === "list_jobs");
    expect(Object.keys(listJobs.inputSchema.properties)).toEqual(["status", "track", "q", "include_body", "limit"]);
  });

  it("stats returns one JSON text block and no structured content", async () => {
    db.addJob({ url: "https://example.com/1", title: "t" });
    const r = await call("stats");
    expect(texts(r)).toEqual([{ incoming: 1 }]);
    expect(r.structuredContent).toBeUndefined();
  });

  it("add_job inserts with source 'manual' by default", async () => {
    const r = await call("add_job", { url: "https://example.com/2", company: "Acme" });
    const [{ id, duplicateCompany }] = texts(r);
    expect(duplicateCompany).toBe(false);
    expect(db.getJob(id)).toMatchObject({ source: "manual", company: "Acme" });
  });

  it("list_jobs omits bodies by default and truncates them to 4000 chars on request", async () => {
    db.addJob({ url: "https://example.com/1", title: "big", body: "x".repeat(5000) });
    db.addJob({ url: "https://example.com/2", title: "small", body: "short" });

    const lean = await call("list_jobs");
    expect(lean.structuredContent.result).toHaveLength(2);
    expect(lean.structuredContent.result.every((j) => !("body" in j))).toBe(true);
    expect(lean.content).toHaveLength(2); // one text block per job

    const full = await call("list_jobs", { include_body: true });
    const byTitle = Object.fromEntries(full.structuredContent.result.map((j) => [j.title, j]));
    expect(byTitle.big.body).toHaveLength(4000);
    expect(byTitle.big.bodyTruncated).toBe(true);
    expect(byTitle.small).toMatchObject({ body: "short", bodyTruncated: false });
  });

  it("list_jobs applies filters and a minimum limit of 1", async () => {
    db.addJob({ url: "https://example.com/1", title: "a" });
    db.addJob({ url: "https://example.com/2", title: "b" });
    expect((await call("list_jobs", { limit: 0 })).structuredContent.result).toHaveLength(1);
    expect((await call("list_jobs", { status: "applied" })).structuredContent.result).toEqual([]);
  });

  it("get_job returns {result: null} with no text for a missing job", async () => {
    const r = await call("get_job", { job_id: 999 });
    expect(r.content).toEqual([]);
    expect(r.structuredContent).toEqual({ result: null });
  });

  it("update_job returns the updated row, or an error string when nothing valid is given", async () => {
    const { id } = db.addJob({ url: "https://example.com/1", title: "t" });
    const ok = await call("update_job", { job_id: id, status: "review", track: "sf", notes: "go" });
    expect(ok.structuredContent.result).toMatchObject({ id, status: "review", track: "sf", notes: "go" });
    const bad = await call("update_job", { job_id: id, status: "bogus" });
    expect(bad.structuredContent.result).toBe("error: no valid fields (bad status/track?) or job not found");
    expect(bad.isError).toBeFalsy();
  });

  it("get_resume reads resume.txt from the data folder", async () => {
    expect((await call("get_resume")).structuredContent.result).toBe("My resume");
    tempDataRoot();
    expect((await call("get_resume")).structuredContent.result).toBe("resume.txt not found");
  });

  it("create_account creates once, then returns the stored account", async () => {
    const first = texts(await call("create_account", { tenant: "Acme.wd1.myworkdayjobs.com", employer: "Acme", email: "a@x" }))[0];
    expect(first).toMatchObject({ tenant: "acme.wd1.myworkdayjobs.com", email: "a@x", created: true });
    expect(first.password).toHaveLength(18);
    const again = texts(await call("create_account", { tenant: "acme.wd1.myworkdayjobs.com" }))[0];
    expect(again).toMatchObject({ id: first.id, password: first.password, created: false });
    const stored = await call("get_account", { tenant: "acme.wd1.myworkdayjobs.com" });
    expect(stored.structuredContent.result).toMatchObject({ id: first.id });
  });

  it("create_account takes the default email from settings.json", async () => {
    tempDataRoot({ "settings.json": JSON.stringify({ email: "me@example.com" }) });
    const rec = texts(await call("create_account", { tenant: "b.wd1.myworkdayjobs.com" }))[0];
    expect(rec.email).toBe("me@example.com");
    tempDataRoot();
    expect(texts(await call("create_account", { tenant: "c.wd1.myworkdayjobs.com" }))[0].email).toBe("");
  });

  it("rejects arguments of the wrong type", async () => {
    const r = await call("get_job", { job_id: "seven" });
    expect(r.isError).toBe(true);
  });
});
