// Bookmarklets for the UI's Bookmarklets page: the app's own workflow bookmarklets
// (electron/builtin-bookmarklets/, not tied to any site), then the user's
// (<data folder>/bookmarklets/*.js), whose files on disk are the single source of truth.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PORT, getPaths } from "./config.js";

const BUILTIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "builtin-bookmarklets");
const BUILTIN = [{ file: "unblocked.js", label: "✅ Unblocked" }];

// "add-job.js" -> "Add job"
function bookmarkletLabel(file) {
  const s = file.replace(/\.js$/i, "").replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Turn a .js source into a draggable `javascript:` bookmarklet.
//
// A file that is already a built bookmarklet (starts with `javascript:`) is served
// as-is. Otherwise the source is treated as readable, normally-formatted JS and
// URL-encoded (newlines preserved, so `//` comments stay valid after decoding).
// Percent-encodes everything except A-Za-z0-9 and -_.~ (encodeURIComponent leaves !'()*).
// The sources may hardcode another tracker port; point every local address at this
// app's capture server so captures land here.
function toBookmarklet(src) {
  src = src.trim().replace(/\b(?:127\.0\.0\.1|localhost):\d+/g, `127.0.0.1:${PORT}`);
  if (src.startsWith("javascript:")) return src;
  return (
    "javascript:" +
    encodeURIComponent(src).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
  );
}

// [{file, label, code, builtin}]: the built-ins first, then the user's sorted by file
// name (none if there is no bookmarklets/ folder).
export function listBookmarklets() {
  const out = BUILTIN.map(({ file, label }) => ({
    file,
    label,
    code: toBookmarklet(fs.readFileSync(path.join(BUILTIN_DIR, file), "utf-8")),
    builtin: true,
  }));
  const dir = getPaths().BOOKMARKLET_DIR;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".js")).sort();
  } catch {
    return out;
  }
  for (const file of files) {
    try {
      const code = toBookmarklet(fs.readFileSync(path.join(dir, file), "utf-8"));
      if (code !== "javascript:") out.push({ file, label: bookmarkletLabel(file), code, builtin: false });
    } catch {
      /* unreadable file: skip */
    }
  }
  return out;
}
