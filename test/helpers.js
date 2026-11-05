import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setDataRoot } from "../electron/config.js";
import { closeDb, initDb } from "../electron/db.js";

export const HOST = `127.0.0.1:${process.env.PORT}`;

// Fresh in-memory database for each test.
export function freshDb() {
  closeDb();
  initDb(":memory:");
}

// Empty temporary data folder, set as the app's data root. `files` maps relative
// paths to contents.
export function tempDataRoot(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobtracker-test-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  setDataRoot(root);
  return root;
}

export const ISO_SECONDS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/;
