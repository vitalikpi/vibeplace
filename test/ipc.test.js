import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as db from "../electron/db.js";
import { freshDb, tempDataRoot } from "./helpers.js";

// Capture what ipc.js registers instead of talking to a real Electron.
const handlers = new Map();
vi.mock("electron", () => ({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } }));

const APP = "file:///app/dist/index.html";
const invoke = (channel, ...args) => handlers.get(channel)({ senderFrame: { url: APP } }, ...args);

beforeAll(async () => {
  const { registerIpc } = await import("../electron/ipc.js");
  registerIpc((url) => url.startsWith("file:///app/dist/"));
});

beforeEach(() => {
  freshDb();
  tempDataRoot({
    "settings.json": JSON.stringify({ links: [{ label: "GitHub", value: "https://g" }] }),
    "bookmarklets/add.js": "alert(1)",
  });
});

describe("IPC bridge", () => {
  it("registers exactly the channels the preload exposes", () => {
    expect([...handlers.keys()].sort()).toEqual(
      ["bookmarklets:list", "jobs:list", "jobs:update", "me:get", "stats:daily", "stats:get", "stats:today"].sort()
    );
  });

  it("refuses calls from any page other than the app's own", () => {
    for (const url of ["https://evil.example/", "file:///other/index.html", ""]) {
      expect(() => handlers.get("stats:get")({ senderFrame: { url } })).toThrow(/untrusted sender/);
    }
    expect(() => handlers.get("stats:get")({})).toThrow(/untrusted sender/);
  });

  it("jobs:list passes string filters through and ignores anything else", () => {
    db.addJob({ url: "https://example.com/1", title: "Engineer" });
    db.addJob({ url: "https://example.com/2", title: "Designer" });
    expect(invoke("jobs:list")).toHaveLength(2);
    expect(invoke("jobs:list", { q: "engineer" }).map((j) => j.title)).toEqual(["Engineer"]);
    expect(invoke("jobs:list", { q: 5, status: ["x"], track: "" })).toHaveLength(2);
  });

  it("jobs:update validates arguments and surfaces 'nothing valid' as an error", () => {
    const { id } = db.addJob({ url: "https://example.com/1", title: "t" });
    expect(invoke("jobs:update", id, { status: "review" })).toMatchObject({ id, status: "review" });
    expect(() => invoke("jobs:update", "1", { status: "review" })).toThrow(/bad job id/);
    expect(() => invoke("jobs:update", 1.5, { status: "review" })).toThrow(/bad job id/);
    expect(() => invoke("jobs:update", id, ["status"])).toThrow(/bad job id/);
    expect(() => invoke("jobs:update", id, { status: "bogus" })).toThrow(/no valid fields/);
  });

  it("serves stats, today's counts and the daily series", () => {
    db.addJob({ url: "https://example.com/1", title: "t" });
    expect(invoke("stats:get")).toEqual({ incoming: 1 });
    expect(invoke("stats:today")).toEqual({ incoming: 1, applied: 0, trashed: 0 });
    expect(invoke("stats:daily", 7)).toHaveLength(1);
    expect(invoke("stats:daily", "7")).toHaveLength(1); // non-integer → whole history
  });

  it("serves bookmarklets and the Me links from the data folder", () => {
    expect(invoke("bookmarklets:list").map((b) => b.file)).toEqual(["add.js"]);
    expect(invoke("me:get")).toEqual({ links: [{ label: "GitHub", value: "https://g" }] });
  });
});
