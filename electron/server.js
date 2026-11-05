// The app's only network surface, on 127.0.0.1:PORT:
//   GET  /capture, /capture-batch   pages a bookmarklet opens to save postings
//   POST /api/jobs                   ingestion (from those pages or straight from a site)
//   GET  /act, POST /api/act         ✅ Unblocked / ✅ Submitted from an application page
//   POST /mcp                        Claude Code (see mcp.js)
// The UI doesn't use HTTP at all; it talks to the main process over IPC (ipc.js).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import * as db from "./db.js";
import { PORT, defaultTrack } from "./config.js";
import { mountMcp } from "./mcp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE_HTML = fs.readFileSync(path.join(HERE, "capture.html"), "utf-8");
const CAPTURE_BATCH_HTML = fs.readFileSync(path.join(HERE, "capture-batch.html"), "utf-8");
const ACT_HTML = fs.readFileSync(path.join(HERE, "act.html"), "utf-8");

// Bookmarklet ops: the target status and the event message.
const ACT_OPS = {
  unblock: { to: "in_progress", message: "unblocked from the browser" },
  submitted: { to: "applied", message: "submitted (bookmarklet)" },
};

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

  // Ingestion is cross-origin: user bookmarklets may POST straight from a job site.
  // It only inserts / moves jobs and answers with ids and statuses. Chrome's
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
  const textBody = express.text({ type: "*/*", limit: "5mb" });
  app.options(["/api/jobs", "/api/act"], ingestCors, (req, res) => res.status(204).end());

  // {url, title?, company?, description? (or body), location?, source?} → a 'new' job.
  app.post("/api/jobs", ingestCors, textBody, (req, res) => {
    const data = bodyJson(req);
    if (!isObject(data) || !(data.url || data.title)) {
      return res.status(400).json({ error: "missing url/title" });
    }
    const { id, duplicateCompany } = db.addJob(data, { actor: "bookmarklet", track: defaultTrack() });
    res.json({ id, duplicateCompany });
  });

  // {op: 'unblock' | 'submitted', job_id?, url?, title?, answers?}. The job is found by
  // id, then "#<id>" in the page title, then the application / posting URL.
  app.post("/api/act", ingestCors, textBody, (req, res) => {
    const data = bodyJson(req);
    const op = isObject(data) ? ACT_OPS[data.op] : null;
    if (!op) return res.status(400).json({ error: "op must be unblock or submitted" });
    const jobId = Number.isInteger(data.job_id) ? data.job_id : /^\d+$/.test(data.job_id ?? "") ? Number(data.job_id) : null;
    const found = db.findJob({ jobId, title: data.title, url: data.url });
    if (found.error === "ambiguous") return res.status(409).json(found);
    if (found.error) return res.status(404).json(found);
    const answers = isObject(data.answers) || typeof data.answers === "string" ? data.answers : undefined;
    try {
      const job = db.transition(found.job.id, op.to, {
        actor: "bookmarklet",
        message: op.message,
        data: answers === undefined ? null : { answers },
      });
      res.json({ ok: true, job_id: job.id, status: job.status });
    } catch (e) {
      if (!(e instanceof db.TransitionError)) throw e;
      res.status(409).json({ error: e.message, job_id: found.job.id, status: found.job.status });
    }
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

  // Same-origin page for bookmarklet ops: the hash holds the /api/act body.
  app.get("/act", (req, res) => res.type("html").send(ACT_HTML));

  app.get("/", (req, res) => res.type("text").send("Job Tracker capture endpoint. Open the app to see the board."));
  app.use((req, res) => res.status(404).json({ error: "not found" }));

  return app;
}
