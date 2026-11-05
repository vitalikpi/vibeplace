// MCP server for the job tracker (port of mcp_server.py) — lets Claude read and triage
// jobs in jobs.db over Streamable HTTP at http://127.0.0.1:8775/mcp. It shares db.js
// with the UI's API, so edits show up in the UI on next refresh. Only reachable while
// the app is running.
//
// Typical triage flow: list_jobs(status="incoming", include_body=True), then per job
//   GO    -> update_job(id, status="review", track=<geo>)
//   NO-GO -> update_job(id, status="trash", notes="NO-GO: <reason>")
// (duplicateCompany == true usually means NO-GO: already applied to that company.)
import fs from "node:fs";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import * as db from "./db.js";
import { PORT, getPaths, readSettings } from "./config.js";

const BODY_PREVIEW = 4000;

function preview(job, includeBody) {
  job = { ...job };
  const body = job.body || "";
  if (includeBody) {
    job.body = body.slice(0, BODY_PREVIEW);
    job.bodyTruncated = body.length > BODY_PREVIEW;
  } else {
    delete job.body;
  }
  return job;
}

// Results are shaped like Python FastMCP's: a JSON text block per value (one per
// item for lists, none for null) and, for tools whose return type FastMCP wraps
// (list / optional / str), structuredContent {result}.
const json = (v) => ({ type: "text", text: JSON.stringify(v, null, 2) });
const textOf = (v) => (typeof v === "string" ? { type: "text", text: v } : json(v));
const plain = (v) => ({ content: [json(v)] });
function wrapped(v) {
  const content = v === null ? [] : Array.isArray(v) ? v.map(json) : [textOf(v)];
  return { content, structuredContent: { result: v } };
}
const RESULT = { result: z.any() };
const optStr = z.string().nullable().optional();

function buildServer() {
  const mcp = new McpServer({ name: "jobtracker", version: "1.0.0" });

  mcp.registerTool(
    "list_jobs",
    {
      description:
        "List jobs, optionally filtered by status (incoming/review/applied/rejected/trash),\n" +
        "    track (remote/nyc/boston/sf), or a free-text query over company/title/body. Bodies are\n" +
        "    omitted unless include_body=True (then truncated). Use for triage: list_jobs(\n" +
        '    status="incoming", include_body=True).',
      inputSchema: {
        status: optStr,
        track: optStr,
        q: optStr,
        include_body: z.boolean().default(false),
        limit: z.number().int().default(200),
      },
      outputSchema: RESULT,
    },
    async ({ status, track, q, include_body, limit }) => {
      const jobs = db.listJobs({ status: status || null, track: track || null, q: q || null });
      return wrapped(jobs.slice(0, Math.max(1, limit)).map((j) => preview(j, include_body)));
    }
  );

  mcp.registerTool(
    "get_job",
    {
      description: "Return one job's full record including the complete body text, or null if missing.",
      inputSchema: { job_id: z.number().int() },
      outputSchema: RESULT,
    },
    async ({ job_id }) => wrapped(db.getJob(job_id))
  );

  mcp.registerTool(
    "update_job",
    {
      description:
        "Update a job's status, track, and/or notes (the single write used for triage).\n" +
        "    status in incoming/review/applied/rejected/trash; track in remote/nyc/boston/sf.\n" +
        "    Returns the updated job, or an error string if nothing valid was provided.",
      inputSchema: { job_id: z.number().int(), status: optStr, track: optStr, notes: optStr },
      outputSchema: RESULT,
    },
    async ({ job_id, status, track, notes }) => {
      const fields = {};
      if (status != null) fields.status = status;
      if (track != null) fields.track = track;
      if (notes != null) fields.notes = notes;
      const updated = db.updateJob(job_id, fields);
      return wrapped(updated ?? "error: no valid fields (bad status/track?) or job not found");
    }
  );

  mcp.registerTool(
    "stats",
    { description: "Return the count of jobs in each status.", inputSchema: {} },
    async () => plain(db.stats())
  );

  mcp.registerTool(
    "get_resume",
    {
      description:
        "Return the resume text (resume.txt in the data folder) for fit checks and form-filling.\n" +
        "    One resume is shared by every track.",
      inputSchema: {},
      outputSchema: RESULT,
    },
    async () => {
      const p = getPaths().RESUME_PATH;
      return wrapped(fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "resume.txt not found");
    }
  );

  mcp.registerTool(
    "add_job",
    {
      description:
        "Manually add a job (or other-source capture). Upserts on the LinkedIn id in the URL.\n" +
        "    Returns {id, duplicateCompany}. New jobs land in status 'incoming', track 'remote'.",
      inputSchema: {
        url: z.string(),
        company: z.string().default(""),
        title: z.string().default(""),
        body: z.string().default(""),
        location: z.string().default(""),
        source: z.string().default("manual"),
      },
    },
    async (args) => plain(db.addJob(args))
  );

  mcp.registerTool(
    "get_account",
    {
      description:
        "Return the stored ATS login account for a Workday tenant host (e.g.\n" +
        "    'nvidia.wd5.myworkdayjobs.com'), including the plaintext password, or null if\n" +
        "    none is stored yet. Use this before registering so an existing login is reused.",
      inputSchema: { tenant: z.string() },
      outputSchema: RESULT,
    },
    async ({ tenant }) => wrapped(db.getAccount(tenant))
  );

  mcp.registerTool(
    "create_account",
    {
      description:
        "Get-or-create the Workday login account for a tenant host. If one already\n" +
        "    exists it is returned unchanged with created=False. Otherwise a strong password\n" +
        "    is generated and stored, and the new record is returned with created=True. The\n" +
        "    returned record includes the plaintext password to type into the Workday\n" +
        "    Create-Account / Sign-In form (the one password-entry exception for this ATS).\n" +
        '    email defaults to "email" in the data folder\'s settings.json.',
      inputSchema: {
        tenant: z.string(),
        employer: z.string().default(""),
        email: z.string().optional(),
      },
    },
    async ({ tenant, employer, email }) => {
      const existing = db.getAccount(tenant);
      if (existing) return plain({ ...existing, created: false });
      const rec = db.saveAccount({
        tenant,
        employer,
        email: email ?? readSettings().email,
        password: db.genPassword(),
        ats: "workday",
      });
      return plain({ ...rec, created: true });
    }
  );

  return mcp;
}

// /api/* allows every origin (the bookmarklet needs that), but /mcp exposes stored
// passwords. Browsers always send Origin on these requests and Claude Code never does,
// so any Origin is refused: no website can drive the MCP over localhost. The Host
// check blocks DNS rebinding.
function guard(req, res, next) {
  const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (req.get("Origin") || !allowedHosts.includes(req.get("Host"))) {
    return res.status(403).json({ error: "forbidden" });
  }
  next();
}

export function mountMcp(app) {
  // Stateless: a fresh server + transport per request.
  app.post("/mcp", guard, express.json({ limit: "5mb" }), async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error: " + e },
          id: null,
        });
      }
    }
  });
  const notAllowed = (req, res) =>
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  app.get("/mcp", guard, notAllowed);
  app.delete("/mcp", guard, notAllowed);
}
