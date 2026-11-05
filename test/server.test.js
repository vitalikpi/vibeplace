import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import * as db from "../electron/db.js";
import { createServer } from "../electron/server.js";
import { HOST, freshDb, tempDataRoot } from "./helpers.js";

let app;
beforeEach(() => {
  freshDb();
  tempDataRoot();
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
    expect(db.getJob(res.body.id)).toMatchObject({ company: "Acme", status: "incoming" });
  });

  it("accepts application/json too", async () => {
    const res = await post("/api/jobs").send({ title: "Only a title" }).expect(200);
    expect(db.getJob(res.body.id).title).toBe("Only a title");
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
  it.each(["/capture", "/capture-batch"])("%s is an HTML page that posts to /api/jobs", async (p) => {
    const res = await get(p).expect(200).expect("Content-Type", /html/);
    expect(res.text).toContain("fetch('/api/jobs'");
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
