// The app's only network surface, on 127.0.0.1:PORT:
//   GET  /capture, /capture-batch   pages a bookmarklet opens to save postings
//   POST /api/jobs                   ingestion (from those pages or straight from a site)
//   POST /mcp                        Claude Code (see mcp.js)
// The UI doesn't use HTTP at all; it talks to the main process over IPC (ipc.js).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import * as db from "./db.js";
import { PORT } from "./config.js";
import { mountMcp } from "./mcp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE_HTML = fs.readFileSync(path.join(HERE, "capture.html"), "utf-8");
const CAPTURE_BATCH_HTML = fs.readFileSync(path.join(HERE, "capture-batch.html"), "utf-8");

// Parse the request body as JSON regardless of Content-Type.
//
// A bookmarklet may send Content-Type: text/plain (a CORS "simple request", no
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

export function createServer() {
  const app = express();
  app.disable("x-powered-by");

  // DNS rebinding guard: a site that points its own hostname at 127.0.0.1 would look
  // same-origin to the browser, but its requests still carry that hostname in Host.
  const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  app.use((req, res, next) => {
    if (!allowedHosts.includes(req.get("Host"))) return res.status(403).send("forbidden host");
    next();
  });

  mountMcp(app);

  // Ingestion is the one cross-origin endpoint: user bookmarklets may POST straight
  // from a job site. It only inserts and answers {id, duplicateCompany}. Chrome's
  // Private Network Access additionally needs Access-Control-Allow-Private-Network on
  // the preflight before a public site may reach localhost.
  const ingestCors = (req, res, next) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Private-Network": "true",
    });
    next();
  };
  app.options("/api/jobs", ingestCors, (req, res) => res.status(204).end());
  app.post("/api/jobs", ingestCors, express.text({ type: "*/*", limit: "5mb" }), (req, res) => {
    const data = bodyJson(req);
    if (!isObject(data) || !(data.url || data.title)) {
      return res.status(400).json({ error: "missing url/title" });
    }
    res.json(db.addJob(data));
  });

  // Same-origin capture page. A bookmarklet opens this in a new tab with the job JSON
  // in the URL hash; this page POSTs it to /api/jobs (no CORS / CSP / PNA issues,
  // because it is served from this origin), then auto-closes. Works from sites whose
  // Content-Security-Policy forbids connecting to localhost.
  app.get("/capture", (req, res) => res.type("html").send(CAPTURE_HTML));

  // Same-origin batch capture page: like /capture, but the hash holds an ARRAY of
  // jobs; it POSTs each to /api/jobs and reports the saved / duplicate counts. Stays
  // open so the counts are visible.
  app.get("/capture-batch", (req, res) => res.type("html").send(CAPTURE_BATCH_HTML));

  app.get("/", (req, res) => res.type("text").send("Job Tracker capture endpoint. Open the app to see the board."));
  app.use((req, res) => res.status(404).json({ error: "not found" }));

  return app;
}
