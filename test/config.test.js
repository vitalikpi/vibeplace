import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PORT, envDataRoot, getPaths, readSettings, setDataRoot } from "../electron/config.js";
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
    it("defaults when settings.json is missing", () => {
      tempDataRoot();
      expect(readSettings()).toEqual({ email: "", links: [] });
    });

    it("defaults when settings.json is malformed", () => {
      tempDataRoot({ "settings.json": "{broken" });
      expect(readSettings()).toEqual({ email: "", links: [] });
    });

    it("reads email and links, ignoring wrongly-typed values", () => {
      tempDataRoot({
        "settings.json": JSON.stringify({ email: "me@example.com", links: [{ label: "GitHub", value: "https://g" }] }),
      });
      expect(readSettings()).toEqual({ email: "me@example.com", links: [{ label: "GitHub", value: "https://g" }] });
      tempDataRoot({ "settings.json": JSON.stringify({ email: 5, links: "nope" }) });
      expect(readSettings()).toEqual({ email: "", links: [] });
    });

    it("re-reads the file on every call", () => {
      const root = tempDataRoot({ "settings.json": JSON.stringify({ email: "a@x" }) });
      expect(readSettings().email).toBe("a@x");
      fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ email: "b@x" }));
      expect(readSettings().email).toBe("b@x");
    });
  });
});
