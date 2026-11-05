import { afterEach, describe, expect, it, vi } from "vitest";

import * as api from "../src/api.js";

afterEach(() => {
  delete globalThis.window;
});

const bridge = (overrides = {}) => {
  globalThis.window = {
    tracker: {
      listJobs: vi.fn(async () => []),
      updateJob: vi.fn(async (id, fields) => ({ id, ...fields })),
      stats: vi.fn(async () => ({ incoming: 1 })),
      statsToday: vi.fn(async () => ({})),
      statsDaily: vi.fn(async () => []),
      bookmarklets: vi.fn(async () => []),
      me: vi.fn(async () => ({ links: [] })),
      ...overrides,
    },
  };
  return globalThis.window.tracker;
};

describe("src/api.js", () => {
  it("forwards each call to the matching bridge method", async () => {
    const t = bridge();
    await api.listJobs({ track: "sf", q: "eng" });
    expect(t.listJobs).toHaveBeenCalledWith({ track: "sf", q: "eng" });
    expect(await api.updateJob(3, { status: "review" })).toEqual({ id: 3, status: "review" });
    expect(await api.getStats()).toEqual({ incoming: 1 });
    await api.getDailyStats(14);
    expect(t.statsDaily).toHaveBeenCalledWith(14);
    await api.getDailyStats(0);
    expect(t.statsDaily).toHaveBeenLastCalledWith(null);
    await api.getBookmarklet();
    await api.getMe();
    await api.getTodayStats();
    expect(t.bookmarklets).toHaveBeenCalled();
    expect(t.me).toHaveBeenCalled();
    expect(t.statsToday).toHaveBeenCalled();
  });

  it("strips Electron's 'Error invoking remote method' prefix from errors", async () => {
    bridge({
      updateJob: async () => {
        throw new Error("Error invoking remote method 'jobs:update': Error: no valid fields or job not found");
      },
    });
    await expect(api.updateJob(1, {})).rejects.toThrow(/^no valid fields or job not found$/);
  });

  it("fails clearly outside the app (no bridge)", async () => {
    globalThis.window = {};
    await expect(api.getStats()).rejects.toThrow(/not running inside the Job Tracker app/);
  });
});
