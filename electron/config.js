// Paths and settings for the tracker. Pure Node (no `electron` import), so the
// headless serve.js can use it under ELECTRON_RUN_AS_NODE.
//
// Everything personal lives in a user-picked data folder (flat layout):
//   <root>/jobs.db              SQLite database (created on first run)
//   <root>/resume.txt           resume text for the get_resume MCP tool
//   <root>/bookmarklets/*.js    the user's own bookmarklets (the app ships only ✅ Unblocked)
//   <root>/settings.json        {"email", "links": [{label, value}], "tracks": [...]}
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DIST_DIR = path.join(HERE, "..", "dist");
// 7085 = "J0B5" in leetspeak. Also clear of the original tracker's 8765, so both can
// run side by side. The bookmarklets the app hands out are rewritten to this port.
export const PORT = Number(process.env.PORT || 7085);

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

const DEFAULT_SETTINGS = { email: "", links: [], tracks: [] };

const isStr = (v) => typeof v === "string" && v.trim() !== "";

// Me links: [{label, value}] with both non-empty strings; anything else is dropped.
function cleanLinks(links) {
  return Array.isArray(links)
    ? links.filter((l) => l && isStr(l.label) && isStr(l.value)).map((l) => ({ label: l.label, value: l.value }))
    : [];
}

// Tracks (the user's target locations, used to label jobs): ["remote", …] or
// [{key, label}]; keys are unique.
function cleanTracks(tracks) {
  if (!Array.isArray(tracks)) return [];
  const out = [];
  for (const t of tracks) {
    const key = typeof t === "string" ? t : t?.key;
    if (!isStr(key) || out.some((o) => o.key === key)) continue;
    out.push({ key, label: isStr(t?.label) ? t.label : key });
  }
  return out;
}

// settings.json merged over defaults; re-read on every call so edits apply without a
// restart. Never throws: a missing or malformed file yields the defaults.
//   {"email": "...", "links": [{label, value}], "tracks": ["remote", {key, label}]}
export function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(getPaths().SETTINGS_PATH, "utf-8"));
    return {
      email: typeof s.email === "string" ? s.email : DEFAULT_SETTINGS.email,
      links: cleanLinks(s.links),
      tracks: cleanTracks(s.tracks),
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

// Track for a newly captured job: the first configured one, or none.
export function defaultTrack() {
  return readSettings().tracks[0]?.key ?? null;
}

// A track a job may be set to: a configured key, or null to clear it.
export function isValidTrack(track) {
  return track === null || readSettings().tracks.some((t) => t.key === track);
}
