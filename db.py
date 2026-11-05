"""SQLite storage for the job tracker. Source of truth for all jobs."""
import os
import re
import secrets
import sqlite3
import string
from datetime import datetime, timedelta, timezone

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jobs.db")

STATUSES = ("incoming", "review", "applied", "rejected", "trash")
TRACKS = ("remote", "nyc", "boston", "sf", "florida")
# Statuses that count as "committed to this company" for the dedup warning.
DEDUP_STATUSES = ("review", "applied", "rejected")

# Aggregators / job-board reposters that list other companies' jobs under their own
# name and never name the end employer. New captures from these are filed straight to
# trash (recoverable) instead of cluttering Incoming or spending triage on them.
# Match is on the normalized (lower-cased, trimmed) company name — exact, not substring,
# so an unrelated real company with a similar name is not caught by accident.
COMPANY_BLACKLIST = {
    "talenthop",
    "remotehunter",
    "haystack",
    "jobot",
    "scoutbetter",
    "fonzi ai"
}


def _norm_company(name):
    return (name or "").strip().lower()

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY,
  linkedin_id TEXT UNIQUE,
  url         TEXT,
  company     TEXT,
  title       TEXT,
  location    TEXT,
  body        TEXT,
  source      TEXT DEFAULT 'linkedin',
  track       TEXT DEFAULT 'remote',
  status      TEXT DEFAULT 'incoming',
  notes       TEXT DEFAULT '',
  created_at  TEXT,
  updated_at  TEXT,
  applied_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company COLLATE NOCASE);

-- Per-employer ATS login accounts (Workday needs a separate account per tenant).
-- Keyed on the tenant host, which is the same login across all of that employer's
-- postings. Plaintext creds in this git-ignored local DB (single-user tool).
CREATE TABLE IF NOT EXISTS ats_accounts (
  id          INTEGER PRIMARY KEY,
  ats         TEXT DEFAULT 'workday',
  tenant      TEXT UNIQUE,          -- e.g. 'nvidia.wd5.myworkdayjobs.com' (normalized host)
  employer    TEXT,
  email       TEXT,
  password    TEXT,
  notes       TEXT DEFAULT '',
  created_at  TEXT,
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_accounts_tenant ON ats_accounts(tenant);
"""


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    with connect() as conn:
        conn.executescript(SCHEMA)


def linkedin_id_from_url(url):
    if not url:
        return None
    m = re.search(r"/jobs/view/(\d+)", url)
    return m.group(1) if m else None


def _row_to_dict(row):
    return {k: row[k] for k in row.keys()}


def _applied_companies(conn):
    """Lower-cased set of company names already committed to (review/applied/rejected)."""
    rows = conn.execute(
        "SELECT DISTINCT company FROM jobs WHERE status IN (%s) AND company <> ''"
        % ",".join("?" * len(DEDUP_STATUSES)),
        DEDUP_STATUSES,
    ).fetchall()
    return {(r["company"] or "").strip().lower() for r in rows}


def add_job(data):
    """Insert a job from the bookmarklet, or update the existing row with the same
    linkedin_id. Returns (id, duplicate_company)."""
    url = (data.get("url") or "").strip()
    company = (data.get("company") or "").strip()
    title = (data.get("title") or "").strip()
    body = (data.get("body") or "").strip()
    location = (data.get("location") or "").strip()
    source = (data.get("source") or "linkedin").strip()
    lid = linkedin_id_from_url(url)
    now = _now()

    with connect() as conn:
        existing = None
        if lid:
            existing = conn.execute(
                "SELECT id FROM jobs WHERE linkedin_id = ?", (lid,)
            ).fetchone()
        if existing is None and url:
            existing = conn.execute(
                "SELECT id FROM jobs WHERE url = ?", (url,)
            ).fetchone()

        if existing:
            # Refresh the captured fields but keep the user's status/track/notes.
            conn.execute(
                """UPDATE jobs SET url=?, company=?, title=?, body=?, location=?,
                   source=?, updated_at=? WHERE id=?""",
                (url, company, title, body, location, source, now, existing["id"]),
            )
            job_id = existing["id"]
        else:
            # Blacklisted aggregators go straight to trash (recoverable) so they never
            # reach Incoming or triage; everything else starts in Incoming.
            blacklisted = _norm_company(company) in COMPANY_BLACKLIST
            status = "trash" if blacklisted else "incoming"
            notes = "blacklisted: " + company if blacklisted else ""
            cur = conn.execute(
                """INSERT INTO jobs (linkedin_id, url, company, title, location, body,
                   source, track, status, notes, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (lid, url, company, title, location, body, source,
                 "remote", status, notes, now, now),
            )
            job_id = cur.lastrowid

        dup = _norm_company(company) in _applied_companies(conn) if company else False
        return job_id, dup


def list_jobs(status=None, track=None, q=None):
    sql = "SELECT * FROM jobs WHERE 1=1"
    args = []
    if status:
        sql += " AND status = ?"
        args.append(status)
    if track:
        sql += " AND track = ?"
        args.append(track)
    if q:
        sql += " AND (company LIKE ? OR title LIKE ? OR body LIKE ?)"
        like = f"%{q}%"
        args += [like, like, like]
    sql += " ORDER BY COALESCE(updated_at, created_at) DESC"

    with connect() as conn:
        rows = [_row_to_dict(r) for r in conn.execute(sql, args).fetchall()]
        applied = _applied_companies(conn)

    for r in rows:
        c = (r.get("company") or "").strip().lower()
        # Flag as duplicate only if a *different* committed row shares the company.
        r["duplicateCompany"] = bool(
            c and c in applied and r["status"] not in DEDUP_STATUSES
        )
    return rows


def update_job(job_id, fields):
    allowed = {}
    if "status" in fields and fields["status"] in STATUSES:
        allowed["status"] = fields["status"]
    if "track" in fields and fields["track"] in TRACKS:
        allowed["track"] = fields["track"]
    if "notes" in fields:
        allowed["notes"] = str(fields["notes"])
    if not allowed:
        return None

    now = _now()
    sets = ", ".join(f"{k}=?" for k in allowed)
    args = list(allowed.values())
    sets += ", updated_at=?"
    args.append(now)
    if allowed.get("status") == "applied":
        sets += ", applied_at=COALESCE(applied_at, ?)"
        args.append(now)
    args.append(job_id)

    with connect() as conn:
        conn.execute(f"UPDATE jobs SET {sets} WHERE id=?", args)
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        return _row_to_dict(row) if row else None


def get_job(job_id):
    """Return one job dict (with full body + duplicateCompany flag), or None."""
    with connect() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            return None
        d = _row_to_dict(row)
        applied = _applied_companies(conn)
    c = (d.get("company") or "").strip().lower()
    d["duplicateCompany"] = bool(c and c in applied and d["status"] not in DEDUP_STATUSES)
    return d


def stats():
    with connect() as conn:
        rows = conn.execute(
            "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status"
        ).fetchall()
    return {r["status"]: r["n"] for r in rows}


def stats_today():
    """Counts of jobs that entered incoming / applied / trash since local midnight."""
    start = (
        datetime.now()
        .astimezone()
        .replace(hour=0, minute=0, second=0, microsecond=0)
        .astimezone(timezone.utc)
        .isoformat(timespec="seconds")
    )
    with connect() as conn:
        inc = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE created_at >= ?", (start,)
        ).fetchone()[0]
        app = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE applied_at >= ?", (start,)
        ).fetchone()[0]
        tr = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE status='trash' AND updated_at >= ?", (start,)
        ).fetchone()[0]
    return {"incoming": inc, "applied": app, "trashed": tr}


def stats_daily(days=None):
    """Per-local-day counts of jobs captured (incoming), applied, and rejected, with
    zero-filled gaps. Rejections have no own timestamp, so updated_at stands in."""
    def local_day(iso):
        return datetime.fromisoformat(iso).astimezone().date()

    with connect() as conn:
        rows = conn.execute(
            "SELECT status, created_at, applied_at, updated_at FROM jobs"
        ).fetchall()
    counts = {}
    for r in rows:
        if r["created_at"]:
            counts.setdefault(local_day(r["created_at"]), [0, 0, 0])[0] += 1
        if r["applied_at"]:
            counts.setdefault(local_day(r["applied_at"]), [0, 0, 0])[1] += 1
        if r["status"] == "rejected" and r["updated_at"]:
            counts.setdefault(local_day(r["updated_at"]), [0, 0, 0])[2] += 1
    if not counts:
        return []
    end = datetime.now().astimezone().date()
    start = min(counts)
    if days:
        start = max(start, end - timedelta(days=days - 1))
    out = []
    d = start
    while d <= end:
        inc, app, rej = counts.get(d, (0, 0, 0))
        out.append({"date": d.isoformat(), "incoming": inc, "applied": app, "rejected": rej})
        d += timedelta(days=1)
    return out


def export_all():
    with connect() as conn:
        return [_row_to_dict(r) for r in conn.execute(
            "SELECT * FROM jobs ORDER BY id"
        ).fetchall()]


# --- ATS login accounts (per-employer Workday sign-ins) -----------------------

def workday_tenant_from_url(url):
    """Return the lower-cased Workday tenant host (the account key) from a
    *.myworkdayjobs.com URL, or None. E.g. 'nvidia.wd5.myworkdayjobs.com'."""
    if not url:
        return None
    m = re.search(r"https?://([^/]*\.myworkdayjobs\.com)", url, re.IGNORECASE)
    return m.group(1).lower() if m else None


def gen_password(length=18):
    """A strong random password meeting common Workday policies: at least one each
    of upper, lower, digit and a safe special char; ambiguous chars excluded."""
    length = max(length, 12)
    lower = "abcdefghijkmnpqrstuvwxyz"       # no l, o
    upper = "ABCDEFGHJKLMNPQRSTUVWXYZ"       # no I, O
    digits = "23456789"                       # no 0, 1
    special = "!@#$%*?-_"
    alphabet = lower + upper + digits + special
    while True:
        pw = "".join(secrets.choice(alphabet) for _ in range(length))
        if (any(c in lower for c in pw) and any(c in upper for c in pw)
                and any(c in digits for c in pw) and any(c in special for c in pw)):
            return pw


def get_account(tenant):
    """Return the stored ats_accounts row for a tenant host, or None."""
    tenant = (tenant or "").strip().lower()
    if not tenant:
        return None
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM ats_accounts WHERE tenant = ?", (tenant,)
        ).fetchone()
        return _row_to_dict(row) if row else None


def save_account(tenant, employer, email, password, ats="workday", notes=""):
    """Upsert an ATS account keyed on the tenant host. Keeps created_at, refreshes
    updated_at. Returns the stored row dict."""
    tenant = (tenant or "").strip().lower()
    now = _now()
    with connect() as conn:
        existing = conn.execute(
            "SELECT id, created_at FROM ats_accounts WHERE tenant = ?", (tenant,)
        ).fetchone()
        if existing:
            conn.execute(
                """UPDATE ats_accounts SET ats=?, employer=?, email=?, password=?,
                   notes=?, updated_at=? WHERE id=?""",
                (ats, employer, email, password, notes, now, existing["id"]),
            )
        else:
            conn.execute(
                """INSERT INTO ats_accounts
                   (ats, tenant, employer, email, password, notes, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (ats, tenant, employer, email, password, notes, now, now),
            )
        row = conn.execute(
            "SELECT * FROM ats_accounts WHERE tenant = ?", (tenant,)
        ).fetchone()
        return _row_to_dict(row)
