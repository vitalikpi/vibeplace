// Starter files for a fresh data folder: AGENTS.md (onboards the user's coding agent on
// the tracker's flows) and CLAUDE.md (imports it, since Claude Code reads only CLAUDE.md).
// Copied only into an empty folder, so an existing tracker's files are never touched.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ONBOARDING_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "onboarding");
export const ONBOARDING_FILES = ["AGENTS.md", "CLAUDE.md"];

// OS clutter that doesn't make a folder non-empty.
const IGNORED = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

export function isEmptyFolder(root) {
  return fs.readdirSync(root).every((f) => IGNORED.has(f));
}

// Copy the starter files into `root` if it's empty. Returns the files copied.
export function seedDataFolder(root) {
  if (!isEmptyFolder(root)) return [];
  for (const f of ONBOARDING_FILES) fs.copyFileSync(path.join(ONBOARDING_DIR, f), path.join(root, f));
  return ONBOARDING_FILES;
}
