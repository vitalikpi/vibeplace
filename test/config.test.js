import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PORT, defaultTrack, envDataRoot, getPaths, isValidTrack, readSettings, setDataRoot } from "../electron/config.js";
import { tempDataRoot } from "./helpers.js";

describe("config", () => {
  afterEach(() => {
    delete process.env.TRACKER_DATA_ROOT;
  });

  it("reads PORT from the environment", () => {
    expect(PORT).toBe(17085);
  });

  it("derives the flat data-folder layout from the root", () => {
    const p = setDataRoot("/tmp/x/../data");
    expect(p).toEqual({
      DATA_ROOT: path.resolve("/tmp/data"),
      DB_PATH: path.resolve("/tmp/data/jobs.db"),
      RESUME_PATH: path.resolve("/tmp/data/resume.txt"),
      BOOKMARKLET_DIR: path.resolve("/tmp/data/bookmarklets"),
      SETTINGS_PATH: path.resolve("/tmp/data/settings.json"),
    });
    expect(getPaths()).toBe(p);
  });

  it("takes the data root from TRACKER_DATA_ROOT when set", () => {
    expect(envDataRoot()).toBeNull();
    process.env.TRACKER_DATA_ROOT = "/some/folder";
    expect(envDataRoot()).toBe("/some/folder");
  });

  describe("readSettings", () => {
    const EMPTY = { email: "", links: [], tracks: [] };

    it("defaults when settings.json is missing", () => {
      tempDataRoot();
      expect(readSettings()).toEqual(EMPTY);
    });

    it("defaults when settings.json is malformed", () => {
      tempDataRoot({ "settings.json": "{broken" });
      expect(readSettings()).toEqual(EMPTY);
    });

    it("reads email and links, ignoring wrongly-typed values", () => {
      tempDataRoot({
        "settings.json": JSON.stringify({ email: "me@example.com", links: [{ label: "GitHub", value: "https://g" }] }),
      });
      expect(readSettings()).toMatchObject({ email: "me@example.com", links: [{ label: "GitHub", value: "https://g" }] });
      tempDataRoot({ "settings.json": JSON.stringify({ email: 5, links: "nope", tracks: "nyc" }) });
      expect(readSettings()).toEqual(EMPTY);
    });

    it("drops malformed links", () => {
      tempDataRoot({
        "settings.json": JSON.stringify({
          links: ["https://g", { label: "", value: "x" }, { label: "A", value: 5 }, { label: "Ok", value: "https://ok", extra: 1 }],
        }),
      });
      expect(readSettings().links).toEqual([{ label: "Ok", value: "https://ok" }]);
    });

    it("reads tracks as strings or {key, label}, dropping blanks and duplicates", () => {
      tempDataRoot({
        "settings.json": JSON.stringify({ tracks: ["remote", { key: "nyc", label: "New York" }, "", "remote", { label: "x" }, 4] }),
      });
      expect(readSettings().tracks).toEqual([
        { key: "remote", label: "remote" },
        { key: "nyc", label: "New York" },
      ]);
      expect(defaultTrack()).toBe("remote");
      expect(isValidTrack("nyc")).toBe(true);
      expect(isValidTrack("mars")).toBe(false);
      expect(isValidTrack(null)).toBe(true);
    });

    it("has no default track when none are configured", () => {
      tempDataRoot();
      expect(defaultTrack()).toBeNull();
      expect(isValidTrack("remote")).toBe(false);
    });

    it("re-reads the file on every call", () => {
      const root = tempDataRoot({ "settings.json": JSON.stringify({ email: "a@x" }) });
      expect(readSettings().email).toBe("a@x");
      fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ email: "b@x" }));
      expect(readSettings().email).toBe("b@x");
    });
  });
});
