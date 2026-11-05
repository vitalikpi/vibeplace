// Paths and settings for the tracker. Pure Node (no `electron` import), so the
// headless serve.js can use it under ELECTRON_RUN_AS_NODE.
//
// Everything personal lives in a user-picked data folder (flat layout):
//   <root>/jobs.db              SQLite database (created on first run)
//   <root>/resume.txt           resume text for the get_resume MCP tool
//   <root>/bookmarklets/*.js    the user's own bookmarklets (the app ships none)
//   <root>/settings.json        {"email": "...", "links": [{"label", "value"}]}
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DIST_DIR = path.join(HERE, "..", "dist");
// 8775 rather than the original tracker's 8765, so both can run side by side. The
// bookmarklets served by /api/bookmarklet are rewritten to target this port.
export const PORT = Number(process.env.PORT || 8775);

let paths = null;

export function setDataRoot(dataRoot) {
  const root = path.resolve(dataRoot);
  paths = {
    DATA_ROOT: root,
    DB_PATH: path.join(root, "jobs.db"),
    RESUME_PATH: path.join(root, "resume.txt"),
    BOOKMARKLET_DIR: path.join(root, "bookmarklets"),
    SETTINGS_PATH: path.join(root, "settings.json"),
  };
  return paths;
}

export function getPaths() {
  if (!paths) throw new Error("data folder not set (call setDataRoot first)");
  return paths;
}

// Data folder from the environment (tests, serve.js); takes priority over the
// folder saved by the app.
export function envDataRoot() {
  return process.env.TRACKER_DATA_ROOT || null;
}

const DEFAULT_SETTINGS = { email: "", links: [] };

// settings.json merged over defaults; re-read on every call so edits apply without a
// restart. Never throws: a missing or malformed file yields the defaults.
export function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(getPaths().SETTINGS_PATH, "utf-8"));
    return {
      email: typeof s.email === "string" ? s.email : DEFAULT_SETTINGS.email,
      links: Array.isArray(s.links) ? s.links : DEFAULT_SETTINGS.links,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
