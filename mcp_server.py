"""MCP server for the job tracker — lets Claude read and triage jobs in jobs.db.

It wraps tracker/db.py (the same SQLite the Flask app uses), so it works whether or not
the web server is running; edits show up in the UI on next refresh.

Recommended triage policy (for a /triage skill built on these tools):
  - Reuse the rubric in .claude/agents/triage-job.md:
      hard filters (instant NO-GO): staffing/recruiting agency; US citizenship/clearance.
      fit checks (NO-GO): pure front-end; junior; Director+; <50% skill overlap vs resume.
  - duplicateCompany == true  -> NO-GO ("already applied to <company>").
  - Set track from the posting location: remote / nyc / boston / sf. A job that is neither
    US-remote nor in NYC / Boston / SF Bay -> NO-GO ("out of target geos").
  - GO     -> update_job(id, status="review", track=<geo>)
  - NO-GO  -> update_job(id, status="trash", notes="NO-GO: <reason>")
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # so `import db` works

import db  # noqa: E402
from mcp.server.fastmcp import FastMCP  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BODY_PREVIEW = 4000

mcp = FastMCP("jobtracker")

# Ensure tables exist (idempotent). The Flask app also does this, but the MCP
# server can run without the web server up — and the ats_accounts table must exist
# for the account tools below.
db.init_db()


def _preview(job, include_body):
    job = dict(job)
    body = job.get("body") or ""
    if include_body:
        job["body"] = body[:BODY_PREVIEW]
        job["bodyTruncated"] = len(body) > BODY_PREVIEW
    else:
        job.pop("body", None)
    return job


@mcp.tool()
def list_jobs(
    status: str | None = None,
    track: str | None = None,
    q: str | None = None,
    include_body: bool = False,
    limit: int = 200,
) -> list[dict]:
    """List jobs, optionally filtered by status (incoming/review/applied/rejected/trash),
    track (remote/nyc/boston/sf), or a free-text query over company/title/body. Bodies are
    omitted unless include_body=True (then truncated). Use for triage: list_jobs(
    status="incoming", include_body=True)."""
    jobs = db.list_jobs(status=status or None, track=track or None, q=q or None)
    return [_preview(j, include_body) for j in jobs[: max(1, limit)]]


@mcp.tool()
def get_job(job_id: int) -> dict | None:
    """Return one job's full record including the complete body text, or null if missing."""
    return db.get_job(job_id)


@mcp.tool()
def update_job(
    job_id: int,
    status: str | None = None,
    track: str | None = None,
    notes: str | None = None,
) -> dict | str:
    """Update a job's status, track, and/or notes (the single write used for triage).
    status in incoming/review/applied/rejected/trash; track in remote/nyc/boston/sf.
    Returns the updated job, or an error string if nothing valid was provided."""
    fields = {}
    if status is not None:
        fields["status"] = status
    if track is not None:
        fields["track"] = track
    if notes is not None:
        fields["notes"] = notes
    updated = db.update_job(job_id, fields)
    if updated is None:
        return "error: no valid fields (bad status/track?) or job not found"
    return updated


@mcp.tool()
def stats() -> dict:
    """Return the count of jobs in each status."""
    return db.stats()


@mcp.tool()
def get_resume() -> str:
    """Return the resume text (resume/resume.txt) for fit checks and form-filling.
    One resume is shared by every track."""
    path = os.path.join(REPO_ROOT, "resume", "resume.txt")
    if not os.path.isfile(path):
        return "resume/resume.txt not found"
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


@mcp.tool()
def add_job(
    url: str,
    company: str = "",
    title: str = "",
    body: str = "",
    location: str = "",
    source: str = "manual",
) -> dict:
    """Manually add a job (or other-source capture). Upserts on the LinkedIn id in the URL.
    Returns {id, duplicateCompany}. New jobs land in status 'incoming', track 'remote'."""
    job_id, dup = db.add_job(
        {
            "url": url,
            "company": company,
            "title": title,
            "body": body,
            "location": location,
            "source": source,
        }
    )
    return {"id": job_id, "duplicateCompany": dup}


@mcp.tool()
def get_account(tenant: str) -> dict | None:
    """Return the stored ATS login account for a Workday tenant host (e.g.
    'nvidia.wd5.myworkdayjobs.com'), including the plaintext password, or null if
    none is stored yet. Use this before registering so an existing login is reused."""
    return db.get_account(tenant)


@mcp.tool()
def create_account(
    tenant: str,
    employer: str = "",
    email: str = "vpianykh@gmail.com",
) -> dict:
    """Get-or-create the Workday login account for a tenant host. If one already
    exists it is returned unchanged with created=False. Otherwise a strong password
    is generated and stored, and the new record is returned with created=True. The
    returned record includes the plaintext password to type into the Workday
    Create-Account / Sign-In form (the one password-entry exception for this ATS)."""
    existing = db.get_account(tenant)
    if existing:
        existing["created"] = False
        return existing
    rec = db.save_account(
        tenant=tenant,
        employer=employer,
        email=email,
        password=db.gen_password(),
        ats="workday",
    )
    rec["created"] = True
    return rec


if __name__ == "__main__":
    mcp.run()
