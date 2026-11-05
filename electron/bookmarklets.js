// The user's bookmarklets (<data folder>/bookmarklets/*.js). The app ships none; the
// files on disk are the single source of truth.
import fs from "node:fs";
import path from "node:path";

import { PORT, getPaths } from "./config.js";

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

// [{file, label, code}] sorted by file name; empty if there is no bookmarklets/ folder.
export function listBookmarklets() {
  const dir = getPaths().BOOKMARKLET_DIR;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".js")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    try {
      const code = toBookmarklet(fs.readFileSync(path.join(dir, file), "utf-8"));
      if (code !== "javascript:") out.push({ file, label: bookmarkletLabel(file), code });
    } catch {
      /* unreadable file: skip */
    }
  }
  return out;
}
