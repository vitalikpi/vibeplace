import { afterEach, describe, expect, it, vi } from "vitest";

import * as api from "../src/api.js";

afterEach(() => {
  delete globalThis.window;
});

function bridge(overrides = {}) {
  const methods = [
    "listJobs",
    "getJob",
    "folderCounts",
    "transition",
    "bulkTransition",
    "setFields",
    "addNote",
    "revealPassword",
    "stats",
    "statsToday",
    "statsDaily",
    "bookmarklets",
    "settings",
  ];
  const t = Object.fromEntries(methods.map((m) => [m, vi.fn(async (...args) => ({ method: m, args }))]));
  t.onChange = vi.fn(() => () => {});
  globalThis.window = { tracker: { ...t, ...overrides } };
  return globalThis.window.tracker;
}

describe("src/api.js", () => {
  it("forwards each call to the matching bridge method", async () => {
    const t = bridge();
    await api.listJobs({ folder: "new" });
    expect(t.listJobs).toHaveBeenCalledWith({ folder: "new" });
    await api.transition(3, "trash", { message: "m" });
    expect(t.transition).toHaveBeenCalledWith(3, "trash", { message: "m" });
    await api.bulkTransition([1, 2], "on_hold");
    expect(t.bulkTransition).toHaveBeenCalledWith([1, 2], "on_hold", undefined);
    await api.folderCounts("");
    expect(t.folderCounts).toHaveBeenCalledWith(null);
    await api.getDailyStats(0);
    expect(t.statsDaily).toHaveBeenCalledWith(null);
    expect(await api.revealPassword(4)).toEqual({ method: "revealPassword", args: [4] });
    for (const [fn, m] of [
      [api.getJob, "getJob"],
      [api.setFields, "setFields"],
      [api.addNote, "addNote"],
      [api.getStats, "stats"],
      [api.getTodayStats, "statsToday"],
      [api.getBookmarklets, "bookmarklets"],
      [api.getSettings, "settings"],
    ]) {
      await fn(1, 2);
      expect(t[m]).toHaveBeenCalled();
    }
  });

  it("strips Electron's remote-method prefix and the error class from errors", async () => {
    bridge({
      transition: async () => {
        throw new Error("Error invoking remote method 'jobs:transition': TransitionError: cannot move job 1 from new to ready");
      },
      setFields: async () => {
        throw new Error("Error invoking remote method 'jobs:setFields': Error: unknown track mars");
      },
    });
    await expect(api.transition(1, "ready")).rejects.toThrow(/^cannot move job 1 from new to ready$/);
    await expect(api.setFields(1, {})).rejects.toThrow(/^unknown track mars$/);
  });

  it("fails clearly outside the app, and onChange is a no-op there", async () => {
    globalThis.window = {};
    await expect(api.getStats()).rejects.toThrow(/not running inside the vibeplace app/);
    expect(api.onChange(() => {})()).toBeUndefined();
  });

  it("onChange subscribes through the bridge", () => {
    const t = bridge();
    const cb = () => {};
    api.onChange(cb);
    expect(t.onChange).toHaveBeenCalledWith(cb);
  });
});
