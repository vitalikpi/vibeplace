// Express backend for the job tracker (port of app.py).
//
// Serves the built React app (dist/), a small JSON API for the UI and the
// bookmarklets, and the MCP endpoint at /mcp. SQLite is the source of truth (db.js).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import * as db from "./db.js";
import { DIST_DIR, PORT, getPaths, readSettings } from "./config.js";
import { mountMcp } from "./mcp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE_HTML = fs.readFileSync(path.join(HERE, "capture.html"), "utf-8");
const CAPTURE_BATCH_HTML = fs.readFileSync(path.join(HERE, "capture-batch.html"), "utf-8");

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
// Encodes like Python's quote(safe=""), which also escapes !'()*.
// The sources may hardcode another tracker port; point every local address at this
// server so captures land here.
function toBookmarklet(src) {
  src = src.trim().replace(/\b(?:127\.0\.0\.1|localhost):\d+/g, `127.0.0.1:${PORT}`);
  if (src.startsWith("javascript:")) return src;
  return (
    "javascript:" +
    encodeURIComponent(src).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
  );
}

// Parse the request body as JSON regardless of Content-Type.
//
// The bookmarklet sends Content-Type: text/plain (a CORS "simple request", no
// preflight), so the body arrives as raw text; parse it, falling back to {}.
function bodyJson(req) {
  const raw = typeof req.body === "string" ? req.body : "";
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function sendIndex(res) {
  const index = path.join(DIST_DIR, "index.html");
  if (fs.existsSync(index)) return res.sendFile(index);
  res
    .type("html")
    .send(
      "<h1>Job Tracker API</h1><p>Frontend not built yet. " +
        "Run <code>npm install && npm run build</code>.</p>"
    );
}

export function createServer() {
  const app = express();
  app.disable("x-powered-by");

  // Chrome Private Network Access: a fetch from a public site to this local server is
  // blocked unless the CORS preflight answers with Access-Control-Allow-Private-Network:
  // true. User bookmarklets may POST from any site, so /api/* allows all origins. /mcp
  // is deliberately NOT covered (it exposes stored passwords; see mcp.js).
  app.use((req, res, next) => {
    const isApi = req.path.startsWith("/api/");
    if (isApi || req.get("Access-Control-Request-Private-Network")) {
      res.set("Access-Control-Allow-Private-Network", "true");
    }
    if (!isApi) return next();
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  mountMcp(app);

  app.use("/api", express.text({ type: "*/*", limit: "5mb" }));

  app.post("/api/jobs", (req, res) => {
    const data = bodyJson(req);
    if (!isObject(data) || !(data.url || data.title)) {
      return res.status(400).json({ error: "missing url/title" });
    }
    res.json(db.addJob(data));
  });

  app.get("/api/jobs", (req, res) => {
    res.json(
      db.listJobs({
        status: req.query.status || null,
        track: req.query.track || null,
        q: req.query.q || null,
      })
    );
  });

  app.patch("/api/jobs/:id", (req, res) => {
    // Flask's <int:job_id>: anything but digits doesn't match the route.
    if (!/^\d+$/.test(req.params.id)) return res.status(405).json({ error: "method not allowed" });
    const data = bodyJson(req);
    const updated = db.updateJob(Number(req.params.id), isObject(data) ? data : {});
    if (updated === null) {
      return res.status(400).json({ error: "no valid fields or job not found" });
    }
    res.json(updated);
  });

  app.get("/api/stats", (req, res) => res.json(db.stats()));
  app.get("/api/stats/today", (req, res) => res.json(db.statsToday()));
  app.get("/api/stats/daily", (req, res) => {
    const days = /^-?\d+$/.test(req.query.days || "") ? Number(req.query.days) : null;
    res.json(db.statsDaily(days));
  });
  app.get("/api/export", (req, res) => res.json(db.exportAll()));

  app.get("/api/me", (req, res) => res.json({ links: readSettings().links }));

  // Same-origin capture page. A bookmarklet opens this in a new tab with the job JSON
  // in the URL hash; this page POSTs it to /api/jobs (no CORS / CSP / PNA issues,
  // because it is served from this origin), then auto-closes. Works from sites whose
  // Content-Security-Policy forbids connecting to localhost.
  app.get("/capture", (req, res) => res.type("html").send(CAPTURE_HTML));

  // Same-origin batch capture page: like /capture, but the hash holds an ARRAY of
  // jobs; it POSTs each to /api/jobs and reports the saved / duplicate counts. Stays
  // open so the counts are visible.
  app.get("/capture-batch", (req, res) => res.type("html").send(CAPTURE_BATCH_HTML));

  // The user's bookmarklets (<data folder>/bookmarklets/*.js), as draggable links for
  // the UI: [{file, label, code}] sorted by file name. The app ships none; files on
  // disk are the single source of truth.
  app.get("/api/bookmarklet", (req, res) => {
    const dir = getPaths().BOOKMARKLET_DIR;
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".js")).sort();
    } catch {
      /* no bookmarklets/ folder: none to offer */
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
    res.json(out);
  });

  // --- static frontend (built by `npm run build` into dist/) ---
  app.get("/", (req, res) => sendIndex(res));
  app.use(express.static(DIST_DIR, { index: false }));
  // SPA fallback
  app.get("/{*path}", (req, res) => sendIndex(res));

  return app;
}
