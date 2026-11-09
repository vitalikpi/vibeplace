import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as db from "../electron/db.js";
import { freshDb, tempDataRoot } from "./helpers.js";

// Capture what ipc.js registers instead of talking to a real Electron.
const handlers = new Map();
vi.mock("electron", () => ({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } }));

const APP = "file:///app/dist/index.html";
const invoke = (channel, ...args) => handlers.get(channel)({ senderFrame: { url: APP } }, ...args);
const POST = (n) => `https://jobs.example.com/${n}`;

beforeAll(async () => {
  const { registerIpc } = await import("../electron/ipc.js");
  registerIpc((url) => url.startsWith("file:///app/dist/"));
});

beforeEach(() => {
  freshDb();
  tempDataRoot({
    "settings.json": JSON.stringify({ links: [{ label: "GitHub", value: "https://g" }], tracks: ["remote", "nyc"] }),
    "bookmarklets/add.js": "alert(1)",
  });
});

describe("IPC bridge", () => {
  it("registers exactly the channels the preload exposes", () => {
    expect([...handlers.keys()].sort()).toEqual(
      [
        "account:reveal",
        "bookmarklets:list",
        "folders:counts",
        "jobs:add",
        "jobs:addNote",
        "jobs:bulkTransition",
        "jobs:get",
        "jobs:list",
        "jobs:resolveNeed",
        "jobs:setFields",
        "jobs:transition",
        "settings:get",
        "stats:daily",
        "stats:get",
        "stats:today",
      ].sort()
    );
  });

  it("refuses calls from any page other than the app's own", () => {
    for (const url of ["https://evil.example/", "file:///other/index.html", ""]) {
      expect(() => handlers.get("stats:get")({ senderFrame: { url } })).toThrow(/untrusted sender/);
    }
    expect(() => handlers.get("stats:get")({})).toThrow(/untrusted sender/);
  });

  it("jobs:list pages a folder, defaulting bad options", () => {
    for (let n = 1; n <= 3; n++) db.addJob({ url: POST(n), title: `T${n}` });
    expect(invoke("jobs:list", { folder: "new", limit: 2 })).toMatchObject({ total: 3, jobs: [{}, {}] });
    expect(invoke("jobs:list", { folder: "bogus", limit: "x", offset: -1 }).total).toBe(3);
    expect(invoke("jobs:list").jobs).toHaveLength(3);
    expect(invoke("jobs:list", { folder: "waiting" }).total).toBe(0);
  });

  it("jobs:get returns the detail with events, and the account without its password", () => {
    const { id } = db.addJob({ url: POST(1), title: "t" });
    db.setJobFields(id, { apply_url: "https://acme.wd1.myworkdayjobs.com/x" });
    db.saveAccount({ tenant: "acme.wd1.myworkdayjobs.com", email: "a@x", password: "secret" });
    const job = invoke("jobs:get", id);
    expect(job.events).toHaveLength(1);
    expect(job.account).toEqual({ tenant: "acme.wd1.myworkdayjobs.com", email: "a@x" });
    expect(JSON.stringify(job)).not.toContain("secret");
    expect(invoke("account:reveal", id)).toBe("secret");
    expect(invoke("jobs:get", 999)).toBeNull();
    expect(() => invoke("jobs:get", "1")).toThrow(/bad job id/);
  });

  it("jobs:transition acts as the human, passing message, answers and override", () => {
    const { id } = db.addJob({ url: POST(1), title: "t" });
    expect(invoke("jobs:transition", id, "triaged", { message: "looks good" })).toMatchObject({ status: "triaged" });
    expect(db.listEvents(id).at(-1)).toMatchObject({ actor: "human", message: "looks good" });
    expect(() => invoke("jobs:transition", id, "ready")).toThrow(/cannot move/);
    invoke("jobs:transition", id, "rejected");
    expect(invoke("jobs:transition", id, "applied", { override: true }).status).toBe("applied");
  });

  it("jobs:bulkTransition moves what it can and reports the rest", () => {
    const a = db.addJob({ url: POST(1), title: "t" }).id;
    const b = db.addJob({ url: POST(2), title: "t" }).id;
    db.transition(b, "trash", { actor: "human" });
    const out = invoke("jobs:bulkTransition", [a, b], "triaged");
    expect(out.moved).toEqual([a]);
    expect(out.refused).toMatchObject([{ id: b, reason: expect.stringMatching(/cannot move/) }]);
    expect(() => invoke("jobs:bulkTransition", [], "trash")).toThrow(/no jobs/);
  });

  it("jobs:add creates a job by hand in New, dedups by URL and validates input", () => {
    const r = invoke("jobs:add", { url: ` ${POST(1)} `, title: "Eng", company: "Acme", bogus: "x" });
    expect(r).toMatchObject({ created: true, duplicateCompany: false });
    expect(db.getJob(r.id)).toMatchObject({ url: POST(1), title: "Eng", status: "new", source: "manual", track: "remote" });
    expect(db.listEvents(r.id)[0]).toMatchObject({ actor: "human", to_status: "new", message: "captured" });

    expect(invoke("jobs:add", { url: POST(1), title: "Eng II", track: "nyc" })).toMatchObject({ id: r.id, created: false });
    expect(db.getJob(r.id).title).toBe("Eng II");
    expect(db.getJob(invoke("jobs:add", { title: "No URL", track: null }).id).track).toBeNull();

    expect(() => invoke("jobs:add", { company: "Acme" })).toThrow(/missing url\/title/);
    expect(() => invoke("jobs:add", "x")).toThrow(/bad job/);
    expect(() => invoke("jobs:add", { title: "x", track: "mars" })).toThrow(/unknown track/);
  });

  it("jobs:setFields validates the track against settings.json", () => {
    const { id } = db.addJob({ url: POST(1), title: "t" });
    expect(invoke("jobs:setFields", id, { track: "nyc", notes: "mine" })).toMatchObject({ track: "nyc", notes: "mine" });
    expect(invoke("jobs:setFields", id, { track: null }).track).toBeNull();
    expect(() => invoke("jobs:setFields", id, { track: "mars" })).toThrow(/unknown track/);
    expect(() => invoke("jobs:setFields", id, { title: "x" })).toThrow(/no valid fields/);
  });

  it("jobs:resolveNeed and jobs:addNote", () => {
    const { id } = db.addJob({ url: POST(1), title: "t" });
    db.transition(id, "triaged", { actor: "human" });
    db.transition(id, "in_progress", { actor: "human" });
    db.transition(id, "blocked", { actor: "agent:a", data: { needs: [{ type: "consent", text: "Privacy" }] } });
    expect(invoke("jobs:resolveNeed", id, "n1")).toEqual([]);
    expect(() => invoke("jobs:resolveNeed", id, "n1")).toThrow(/need not found/);
    expect(invoke("jobs:addNote", id, "called the recruiter")).toMatchObject({ actor: "human", message: "called the recruiter" });
    expect(() => invoke("jobs:addNote", id, "")).toThrow(/empty note/);
  });

  it("folder counts, stats, bookmarklets and settings", () => {
    db.addJob({ url: POST(1), title: "t" }, { track: "nyc" });
    expect(invoke("folders:counts")).toMatchObject({ new: 1, waiting: 0 });
    expect(invoke("folders:counts", "remote").new).toBe(0);
    expect(invoke("stats:get")).toEqual({ new: 1 });
    expect(invoke("stats:today")).toEqual({ captured: 1, applied: 0, trashed: 0 });
    expect(invoke("stats:daily", 7)).toHaveLength(1);
    expect(invoke("stats:daily", -1)).toHaveLength(1);
    expect(invoke("bookmarklets:list").map((b) => b.file)).toEqual(["unblocked.js", "add.js"]);
    expect(invoke("settings:get")).toEqual({
      links: [{ label: "GitHub", value: "https://g" }],
      tracks: [
        { key: "remote", label: "remote" },
        { key: "nyc", label: "nyc" },
      ],
    });
  });
});
