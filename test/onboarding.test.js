import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ONBOARDING_FILES, isEmptyFolder, seedDataFolder } from "../electron/onboarding.js";
import { tempDataRoot } from "./helpers.js";

const read = (root, f) => fs.readFileSync(path.join(root, f), "utf-8");

describe("seedDataFolder", () => {
  it("copies AGENTS.md and CLAUDE.md into an empty folder", () => {
    const root = tempDataRoot();
    expect(seedDataFolder(root)).toEqual(ONBOARDING_FILES);
    expect(fs.readdirSync(root).sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(read(root, "AGENTS.md")).toMatch(/^# vibeplace data folder/);
    expect(read(root, "CLAUDE.md").trim()).toBe("@AGENTS.md");
  });

  it("treats a folder holding only OS clutter as empty", () => {
    const root = tempDataRoot({ ".DS_Store": "x", "Thumbs.db": "x", "desktop.ini": "x" });
    expect(isEmptyFolder(root)).toBe(true);
    expect(seedDataFolder(root)).toEqual(ONBOARDING_FILES);
  });

  it("leaves a folder with anything else in it alone", () => {
    const root = tempDataRoot({ "jobs.db": "", "AGENTS.md": "mine" });
    expect(seedDataFolder(root)).toEqual([]);
    expect(read(root, "AGENTS.md")).toBe("mine");
    expect(fs.existsSync(path.join(root, "CLAUDE.md"))).toBe(false);
  });

  it("doesn't reseed once the folder is in use", () => {
    const root = tempDataRoot();
    seedDataFolder(root);
    fs.writeFileSync(path.join(root, "AGENTS.md"), "edited");
    expect(seedDataFolder(root)).toEqual([]);
    expect(read(root, "AGENTS.md")).toBe("edited");
  });
});
