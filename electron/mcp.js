// MCP server for the job tracker, over Streamable HTTP at http://127.0.0.1:7085/mcp.
// It shares db.js with the UI, so every change shows up in the app immediately.
// Only reachable while the app is running.
//
// Tools follow the workflow (workflow.js); status changes go through db.transition,
// so a move the caller may not make comes back as a tool error naming the allowed
// moves. Agents never Start, Unblock or mark a job applied: those are the human's.
//
//   triage:    list_jobs(status="new", include_body=True) → triage_job(go | no_go)
//   apply:     queue_next → update_progress … → mark_blocked(message?) | mark_ready | hold_job
//              (release_job on an error stop)
//   outcomes:  record_outcome (Gmail evidence); add_event for anything else
import fs from "node:fs";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import * as db from "./db.js";
import { defaultTrack, getPaths, isValidTrack, readSettings } from "./config.js";
import { STATUSES } from "./workflow.js";

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

// Every result: one JSON text block (none for null) plus structuredContent {result}.
function ok(v) {
  return {
    content: v == null ? [] : [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
    structuredContent: { result: v ?? null },
  };
}
const fail = (message) => ({ content: [{ type: "text", text: message }], isError: true });

// Run fn; TransitionErrors (refused moves, unknown jobs, someone else's lease) become
// tool errors instead of protocol errors.
async function guarded(fn) {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof db.TransitionError) return fail(e.message);
    throw e;
  }
}

const RESULT = { result: z.any() };
const agentName = z.string().min(1).describe("Your agent name, e.g. 'apply-3'. Recorded as actor 'agent:<name>'.");
const actorOf = (name) => `agent:${name}`;
const jobId = z.number().int();
const optStr = z.string().optional();

function mustExist(id) {
  if (!db.getJob(id)) throw new db.TransitionError(`job ${id} not found`, { code: "not_found" });
}

function buildServer() {
  const mcp = new McpServer({ name: "jobtracker", version: "2.0.0" });
  const tool = (name, description, inputSchema, handler) =>
    mcp.registerTool(name, { description, inputSchema, outputSchema: RESULT }, (args) => guarded(() => handler(args)));

  // --- reading -----------------------------------------------------------------

  tool(
    "list_jobs",
    `List jobs, newest activity first. Filter by status (${STATUSES.join("/")}), track, or a
free-text query over company/title/description. Bodies are omitted unless include_body
(then truncated to ${BODY_PREVIEW} chars). duplicateCompany=true means another job at the
same company is already triaged or further along.`,
    {
      status: z.enum(STATUSES).optional(),
      track: optStr,
      q: optStr,
      include_body: z.boolean().default(false),
      limit: z.number().int().default(200),
    },
    ({ status, track, q, include_body, limit }) =>
      db
        .listJobs({ status: status || null, track: track || null, q: q || null })
        .slice(0, Math.max(1, limit))
        .map((j) => preview(j, include_body))
  );

  tool(
    "get_job",
    "One job's full record (complete description, apply_url, step, tab_id, owner) plus its event timeline, or null.",
    { job_id: jobId },
    ({ job_id }) => db.getJobDetail(job_id)
  );

  tool(
    "attention",
    "Jobs waiting for the human (blocked or ready), longest-waiting first, with tab_id, apply_url and the latest timeline message.",
    {},
    () => db.attention()
  );

  tool("stats", "Job counts per status, plus today's captured / applied / trashed counts.", {}, () => ({
    counts: db.stats(),
    today: db.statsToday(),
  }));

  tool("get_resume", "The resume text (resume.txt in the data folder) for fit checks and form-filling.", {}, () => {
    const p = getPaths().RESUME_PATH;
    return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "resume.txt not found";
  });

  // --- capture + triage --------------------------------------------------------

  tool(
    "add_job",
    "Add a job (or refresh the one with the same posting URL; board tracking params are ignored). New jobs land in 'new'. Returns {id, duplicateCompany, created}.",
    {
      url: z.string(),
      title: z.string().default(""),
      company: z.string().default(""),
      description: z.string().default(""),
      location: z.string().default(""),
      source: z.string().default("manual"),
      agent: agentName.default("mcp"),
    },
    ({ agent, ...data }) => db.addJob(data, { actor: actorOf(agent), track: defaultTrack() })
  );

  tool(
    "triage_job",
    "Triage a 'new' job: go → 'triaged' (optionally setting its track), no_go → 'trash'. The reason goes on the timeline.",
    {
      job_id: jobId,
      decision: z.enum(["go", "no_go"]),
      reason: z.string(),
      track: optStr.describe("One of the tracks in settings.json"),
      agent: agentName.default("triage"),
    },
    ({ job_id, decision, reason, track, agent }) => {
      mustExist(job_id);
      if (track !== undefined && !isValidTrack(track)) {
        const known = readSettings().tracks.map((t) => t.key);
        throw new db.TransitionError(`unknown track ${track}; known: ${known.join(", ") || "none configured"}`, {
          code: "bad_status",
        });
      }
      const actor = actorOf(agent);
      const to = decision === "go" ? "triaged" : "trash";
      const job = db.transition(job_id, to, { actor, message: `${decision === "go" ? "GO" : "NO-GO"}: ${reason}` });
      return track !== undefined ? db.setJobFields(job_id, { track }, { actor }) : job;
    }
  );

  // --- the apply loop ----------------------------------------------------------

  tool(
    "queue_next",
    `Take the next piece of work: {message: {kind: 'start' | 'unblock'}, job} or null. 'unblock'
means the human has dealt with what you asked for when you marked it blocked (see the timeline).
The job is leased to you (lease_minutes); no other agent gets it until you finish, release
it, or the lease runs out. Jobs with a pending referral are skipped.`,
    { agent: agentName, lease_minutes: z.number().int().min(1).max(240).default(30) },
    ({ agent, lease_minutes }) => db.queueNext(actorOf(agent), { leaseMinutes: lease_minutes })
  );

  tool(
    "update_progress",
    "Record progress on a job you hold: the furthest step, the Chrome tab id, the application URL / ATS, and an optional timeline note. Renews your lease.",
    {
      job_id: jobId,
      agent: agentName,
      step: optStr,
      tab_id: z.number().int().optional(),
      apply_url: optStr,
      ats: optStr,
      message: optStr,
    },
    ({ job_id, agent, message, ...fields }) => {
      const actor = actorOf(agent);
      db.assertOwner(job_id, actor);
      const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (Object.keys(set).length) db.setJobFields(job_id, set, { actor });
      if (message) db.addEvent(job_id, { actor, message });
      db.renewLease(job_id, actor);
      return db.getJob(job_id);
    }
  );

  tool(
    "mark_blocked",
    "Hand a job you hold back to the human: in_progress → blocked, with an optional short message saying what you need from them. Releases your lease.",
    { job_id: jobId, agent: agentName, message: optStr },
    ({ job_id, agent, message }) => {
      db.assertOwner(job_id, actorOf(agent));
      return db.transition(job_id, "blocked", { actor: actorOf(agent), message: message || null });
    }
  );

  tool(
    "mark_ready",
    "The form is fully filled: in_progress → ready, waiting for the human to submit. Never submit yourself. Releases your lease.",
    { job_id: jobId, agent: agentName, message: optStr },
    ({ job_id, agent, message }) => {
      db.assertOwner(job_id, actorOf(agent));
      return db.transition(job_id, "ready", { actor: actorOf(agent), message: message || null });
    }
  );

  tool(
    "hold_job",
    "Park a job (verification wall, possible scam, retry later): → on_hold with the reason. scam=true also flags the job.",
    { job_id: jobId, agent: agentName, reason: z.string(), scam: z.boolean().default(false) },
    ({ job_id, agent, reason, scam }) => {
      const actor = actorOf(agent);
      db.assertOwner(job_id, actor);
      const job = db.transition(job_id, "on_hold", { actor, message: reason });
      return scam ? db.setJobFields(job_id, { scam_flag: 1 }, { actor }) : job;
    }
  );

  tool(
    "release_job",
    "Stop working on a job without finishing (error stop): the status stays, your lease is dropped, and the reason goes on the timeline.",
    { job_id: jobId, agent: agentName, message: z.string() },
    ({ job_id, agent, message }) => {
      const actor = actorOf(agent);
      db.assertOwner(job_id, actor);
      db.releaseJob(job_id, { actor, message });
      return db.getJob(job_id);
    }
  );

  tool(
    "add_event",
    "Add a note to a job's timeline (agents write here, not in notes).",
    { job_id: jobId, message: z.string(), agent: agentName },
    ({ job_id, message, agent }) => {
      mustExist(job_id);
      return db.addEvent(job_id, { actor: actorOf(agent), message });
    }
  );

  tool(
    "record_outcome",
    "Record an outcome found in email (actor 'gmail'): applied (confirmation), interviewing (invite / scheduling) or rejected. If you're not sure which job an email belongs to, use add_event instead.",
    { job_id: jobId, outcome: z.enum(["applied", "interviewing", "rejected"]), evidence: z.string() },
    ({ job_id, outcome, evidence }) => db.transition(job_id, outcome, { actor: "gmail", message: evidence })
  );

  // --- ATS accounts --------------------------------------------------------------

  tool(
    "get_account",
    "The stored ATS login for a tenant (the sign-in page's host, e.g. 'nvidia.wd5.myworkdayjobs.com'), including the plaintext password, or null. Check this before registering so an existing login is reused.",
    { tenant: z.string() },
    ({ tenant }) => db.getAccount(tenant)
  );

  tool(
    "create_account",
    `Get-or-create the ATS login for a tenant: the sign-in page's host, e.g.
'nvidia.wd5.myworkdayjobs.com' or 'acme.icims.com'; where one host serves many employers,
add the path part that names the employer (e.g. 'jobs.dayforcehcm.com/acme'). An existing
one comes back with created=false; otherwise a strong password is generated and stored, and
the record comes back with created=true and the plaintext password to type into the
Create-Account / Sign-In form (the one password-entry exception). Pass job_id to link the
account to that job (plus a timeline note, no password), so the human sees it on the job.
email defaults to "email" in settings.json; pass ats (e.g. 'workday'), else it is stored as 'other'.`,
    {
      tenant: z.string(),
      employer: z.string().default(""),
      email: optStr,
      ats: optStr,
      job_id: jobId.optional(),
      agent: agentName.default("mcp"),
    },
    ({ tenant, employer, email, ats, job_id, agent }) => {
      if (job_id != null) mustExist(job_id);
      const existing = db.getAccount(tenant);
      const rec = existing
        ? { ...existing, created: false }
        : {
            ...db.saveAccount({
              tenant,
              employer,
              email: email ?? readSettings().email,
              password: db.genPassword(),
              ats,
            }),
            created: true,
          };
      if (job_id != null && db.accountForJob(db.getJob(job_id))?.id !== rec.id) {
        const actor = actorOf(agent);
        db.setJobFields(job_id, { account_tenant: rec.tenant }, { actor });
        db.addEvent(job_id, {
          actor,
          message: `${rec.created ? "Created" : "Using"} the ${rec.ats} account for ${rec.tenant} (${rec.email})`,
        });
      }
      return rec;
    }
  );

  return mcp;
}

// /api/jobs accepts every origin (bookmarklets need that), but /mcp exposes stored
// passwords. Browsers always send Origin on these requests and Claude Code never does,
// so any Origin is refused: no website can drive the MCP over localhost. (The Host
// check against DNS rebinding runs for every route in server.js.)
function refuseBrowsers(req, res, next) {
  if (req.get("Origin")) return res.status(403).json({ error: "forbidden" });
  next();
}

export function mountMcp(app) {
  // Stateless: a fresh server + transport per request.
  app.post("/mcp", refuseBrowsers, express.json({ limit: "5mb" }), async (req, res) => {
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
  app.get("/mcp", refuseBrowsers, notAllowed);
  app.delete("/mcp", refuseBrowsers, notAllowed);
}
