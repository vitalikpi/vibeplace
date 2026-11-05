"""One-off import of the old file-based pipeline (old/<track>/<stage>/*.md) into jobs.db.

Dry run by default; pass --apply to write. Idempotent: rows that already exist (same
linkedin_id or url) keep their status/notes and only get a missing applied_at filled in.
"""
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone

import db

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OLD = os.path.join(ROOT, "old")
TRACKS = ("remote", "boston", "sf")
# Stage folder -> DB status. Other stages (0_raw, 1_incoming, 2_inprogress) are skipped.
STAGES = {
    "3_applied": "applied",
    "2_applied": "applied",
    "4_rejected": "rejected",
    "4_filteredout": "trash",
}
APPLIED_DIRS = ("2_applied", "3_applied")


def git_appearances():
    """basename -> list of (iso date, stage dir) for every commit that added the file
    under any path. --no-renames makes each folder move count as an add, so the list
    records when the file landed in each stage."""
    out = subprocess.run(
        ["git", "log", "--no-renames", "--diff-filter=A", "--format=@%aI",
         "--name-only", "--", "*.md"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout
    seen = {}
    date = None
    for line in out.splitlines():
        if line.startswith("@"):
            date = line[1:]
        elif line.strip():
            parts = line.split("/")
            seen.setdefault(parts[-1], []).append((date, parts[-2] if len(parts) > 1 else ""))
    return seen


def parse_file(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        text = f.read()
    name = os.path.basename(path)[:-3]
    url = None
    m = re.search(r"https://www\.linkedin\.com/jobs/view/\d+/?", text)
    if m:
        url = m.group(0)
    lid = db.linkedin_id_from_url(url)
    if not lid:
        m = re.search(r"\d{9,11}", name)
        if m:
            lid = m.group(0)
            url = f"https://www.linkedin.com/jobs/view/{lid}/"
    # Company only from a non-numeric filename prefix ("amex_sr-swe-..." -> "amex").
    prefix = re.split(r"_", name)[0]
    company = "" if prefix.isdigit() else prefix
    return {"url": url, "linkedin_id": lid, "company": company, "body": text}


def to_utc(iso):
    return datetime.fromisoformat(iso).astimezone(timezone.utc).isoformat(timespec="seconds")


def main():
    apply = "--apply" in sys.argv
    seen = git_appearances()
    counts, inserted, updated, skipped = {}, 0, 0, 0
    no_date, no_company = [], 0
    done, dupes, conflicts = set(), [], []

    if apply:
        shutil.copy2(db.DB_PATH, db.DB_PATH.replace("jobs.db", "jobs.bak3.db"))
    db.init_db()

    with db.connect() as conn:
        for track in TRACKS:
            for stage, status in STAGES.items():
                d = os.path.join(OLD, track, stage)
                if not os.path.isdir(d):
                    continue
                for fn in sorted(os.listdir(d)):
                    if not fn.endswith(".md"):
                        continue
                    path = os.path.join(d, fn)
                    job = parse_file(path)
                    apps = sorted(seen.get(fn, []))
                    if apps:
                        created = to_utc(apps[0][0])
                    else:
                        created = datetime.fromtimestamp(
                            os.path.getmtime(path), timezone.utc).isoformat(timespec="seconds")
                        no_date.append(f"{track}/{stage}/{fn}")
                    applied_at = None
                    if status in ("applied", "rejected"):
                        hits = [a for a in apps if a[1] in APPLIED_DIRS] or \
                               [a for a in apps if a[1] == stage]
                        applied_at = to_utc(hits[0][0]) if hits else created
                        if not job["company"]:
                            no_company += 1
                    counts[(status, track)] = counts.get((status, track), 0) + 1

                    # Same job can sit in two old folders; first one wins.
                    key = job["linkedin_id"] or job["url"] or path
                    if key in done:
                        dupes.append(f"{track}/{stage}/{fn}")
                        continue
                    done.add(key)

                    existing = None
                    if job["linkedin_id"]:
                        existing = conn.execute(
                            "SELECT id, status, applied_at FROM jobs WHERE linkedin_id = ?",
                            (job["linkedin_id"],)).fetchone()
                    if existing is None and job["url"]:
                        existing = conn.execute(
                            "SELECT id, status, applied_at FROM jobs WHERE url = ?",
                            (job["url"],)).fetchone()
                    if existing is None and not job["url"]:
                        # Mangled URL: the pasted text itself is the only stable key.
                        existing = conn.execute(
                            "SELECT id, status, applied_at FROM jobs WHERE body = ?",
                            (job["body"],)).fetchone()

                    if existing:
                        if applied_at and existing["status"] not in ("applied", "rejected"):
                            # Live row disagrees (e.g. re-captured into review); leave it.
                            conflicts.append(f"{track}/{stage}/{fn} -> db #{existing['id']} "
                                             f"is {existing['status']}")
                            skipped += 1
                        elif applied_at and not existing["applied_at"]:
                            updated += 1
                            if apply:
                                conn.execute("UPDATE jobs SET applied_at=? WHERE id=?",
                                             (applied_at, existing["id"]))
                        else:
                            skipped += 1
                        continue

                    inserted += 1
                    if apply:
                        conn.execute(
                            """INSERT INTO jobs (linkedin_id, url, company, title, location,
                               body, source, track, status, notes, created_at, updated_at,
                               applied_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                            (job["linkedin_id"], job["url"], job["company"], "", "",
                             job["body"], "linkedin", track, status,
                             f"imported from old/{track}/{stage}", created, created,
                             applied_at),
                        )
        if not apply:
            conn.rollback()

    print("dry run" if not apply else "APPLIED")
    for (status, track), n in sorted(counts.items()):
        print(f"  {status:9} {track:7} {n}")
    print(f"insert {inserted}, fill applied_at {updated}, already present {skipped}")
    print(f"applied/rejected without company: {no_company}")
    print(f"old applied but db row has another status (left as is): {len(conflicts)}")
    for c in conflicts:
        print("   ", c)
    print(f"duplicates across old folders (skipped): {len(dupes)}")
    for p in dupes:
        print("   ", p)
    print(f"no git date (used mtime): {len(no_date)}")
    for p in no_date[:20]:
        print("   ", p)


if __name__ == "__main__":
    main()
