import { describe, expect, it } from "vitest";

import {
  FOLDERS,
  PRE_APPLY,
  STATUSES,
  WAITING,
  actorKind,
  allowedTargets,
  canTransition,
} from "../electron/workflow.js";

describe("actorKind", () => {
  it("maps actor strings to their kind", () => {
    expect(actorKind("human")).toBe("human");
    expect(actorKind("agent:apply-7")).toBe("agent");
    expect(actorKind("gmail")).toBe("gmail");
    expect(actorKind("bookmarklet")).toBe("bookmarklet");
  });
  it("rejects unknown actors (including the migration actor)", () => {
    expect(actorKind("migration")).toBeNull();
    expect(actorKind("")).toBeNull();
    expect(actorKind(undefined)).toBeNull();
  });
});

describe("folders", () => {
  it("cover every status exactly once, with waiting = blocked + ready", () => {
    expect(FOLDERS[0]).toMatchObject({ key: "waiting", statuses: WAITING });
    expect(WAITING).toEqual(["blocked", "ready"]);
    const covered = FOLDERS.flatMap((f) => f.statuses).sort();
    expect(covered).toEqual([...STATUSES].sort());
  });
});

describe("canTransition", () => {
  const ok = (from, to, kind) => expect(canTransition(from, to, kind), `${kind}: ${from} → ${to}`).toBe(true);
  const no = (from, to, kind) => expect(canTransition(from, to, kind), `${kind}: ${from} → ${to}`).toBe(false);

  it("lets humans and agents triage new jobs", () => {
    for (const k of ["human", "agent"]) {
      ok("new", "triaged", k);
      ok("new", "trash", k);
    }
    no("new", "triaged", "gmail");
    no("new", "in_progress", "human"); // must be triaged first
  });

  it("only lets the human Start, Unblock (or the bookmarklet) and send back", () => {
    ok("triaged", "in_progress", "human");
    no("triaged", "in_progress", "agent");
    ok("blocked", "in_progress", "human");
    ok("blocked", "in_progress", "bookmarklet");
    no("blocked", "in_progress", "agent");
    ok("ready", "in_progress", "human");
    ok("on_hold", "in_progress", "human");
    ok("on_hold", "triaged", "human");
    no("on_hold", "triaged", "agent");
  });

  it("only lets agents report blocked / ready from in_progress", () => {
    ok("in_progress", "blocked", "agent");
    ok("in_progress", "ready", "agent");
    no("in_progress", "ready", "human");
    no("triaged", "ready", "agent");
    no("blocked", "ready", "agent");
  });

  it("never lets an agent mark a job applied; human, bookmarklet and Gmail can from any pre-apply status", () => {
    for (const from of PRE_APPLY) {
      no(from, "applied", "agent");
      ok(from, "applied", "human");
      ok(from, "applied", "bookmarklet");
      ok(from, "applied", "gmail");
    }
    no("trash", "applied", "human");
    no("rejected", "applied", "gmail");
  });

  it("routes outcomes: applied → interviewing, anything live → rejected (human or Gmail)", () => {
    ok("applied", "interviewing", "gmail");
    ok("applied", "interviewing", "human");
    no("triaged", "interviewing", "gmail");
    for (const from of [...PRE_APPLY, "applied", "interviewing"]) {
      ok(from, "rejected", "gmail");
      no(from, "rejected", "agent");
    }
    no("trash", "rejected", "human");
  });

  it("lets humans and agents park anything except trash", () => {
    for (const from of STATUSES.filter((s) => !["on_hold", "trash"].includes(s))) {
      ok(from, "on_hold", "human");
      ok(from, "on_hold", "agent");
    }
    no("trash", "on_hold", "human");
  });

  it("lets humans trash anything; agents only at triage; restore goes back to new", () => {
    for (const from of STATUSES.filter((s) => s !== "trash")) ok(from, "trash", "human");
    ok("triaged", "trash", "agent");
    no("in_progress", "trash", "agent");
    no("applied", "trash", "agent");
    ok("trash", "new", "human");
    no("trash", "new", "agent");
    no("trash", "triaged", "human");
  });

  it("never allows staying put or unknown kinds", () => {
    no("new", "new", "human");
    no("new", "triaged", null);
  });
});

describe("allowedTargets", () => {
  it("lists targets in status order", () => {
    expect(allowedTargets("in_progress", "agent")).toEqual(["blocked", "ready", "on_hold"]);
    expect(allowedTargets("trash", "human")).toEqual(["new"]);
    expect(allowedTargets("rejected", "agent")).toEqual(["on_hold"]);
  });
});
