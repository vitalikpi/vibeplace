"""Flask backend for the job tracker.

Serves the built React app (dist/) and a small JSON API. SQLite is the source of
truth (see db.py). Run: `.venv/bin/python app.py` (listens on 127.0.0.1:8765).
"""
import json
import os
import urllib.parse

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

import db

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "dist")
PORT = int(os.environ.get("PORT", "8765"))

app = Flask(__name__, static_folder=None)


# Chrome Private Network Access: a fetch from a public site (LinkedIn) to this local
# server is blocked unless the CORS preflight answers with this header set to "true".
# flask-cors emits "false" by default, so we must overwrite it. This hook is registered
# BEFORE CORS(app) so it runs AFTER flask-cors in the after_request chain (Flask runs
# them in reverse registration order); the assignment replaces flask-cors's value.
@app.after_request
def allow_private_network(resp):
    if request.path.startswith("/api/") or (
        "Access-Control-Request-Private-Network" in request.headers
    ):
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
    return resp


# The bookmarklet POSTs from https://www.linkedin.com -> allow all origins on /api/*.
CORS(app, resources={r"/api/*": {"origins": "*"}})

db.init_db()


def _body_json():
    """Parse the request body as JSON regardless of Content-Type.

    The bookmarklet sends Content-Type: text/plain (a CORS "simple request", no
    preflight), so request.get_json() won't trigger; parse the raw body instead.
    """
    data = request.get_json(silent=True)
    if data is not None:
        return data
    raw = request.get_data(as_text=True) or ""
    try:
        return json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return {}


@app.post("/api/jobs")
def create_job():
    data = _body_json()
    if not isinstance(data, dict) or not (data.get("url") or data.get("title")):
        return jsonify({"error": "missing url/title"}), 400
    job_id, dup = db.add_job(data)
    return jsonify({"id": job_id, "duplicateCompany": dup})


@app.get("/api/jobs")
def get_jobs():
    return jsonify(db.list_jobs(
        status=request.args.get("status") or None,
        track=request.args.get("track") or None,
        q=request.args.get("q") or None,
    ))


@app.patch("/api/jobs/<int:job_id>")
def patch_job(job_id):
    updated = db.update_job(job_id, _body_json() or {})
    if updated is None:
        return jsonify({"error": "no valid fields or job not found"}), 400
    return jsonify(updated)


@app.get("/api/stats")
def get_stats():
    return jsonify(db.stats())


@app.get("/api/stats/today")
def get_stats_today():
    return jsonify(db.stats_today())


@app.get("/api/stats/daily")
def get_stats_daily():
    days = request.args.get("days", type=int)
    return jsonify(db.stats_daily(days))


@app.get("/api/export")
def export():
    return jsonify(db.export_all())


CAPTURE_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><title>Saving…</title></head>
<body style="font:600 18px -apple-system,system-ui,sans-serif;padding:32px;color:#0a66c2">
<div id="m">Saving…</div>
<script>
(async () => {
  const m = document.getElementById('m');
  let payload;
  try { payload = JSON.parse(decodeURIComponent(location.hash.slice(1))); }
  catch (e) { m.style.color = '#b42318'; m.textContent = 'No job data in URL.'; return; }
  try {
    const r = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const d = await r.json();
    m.textContent = (d.duplicateCompany ? '\\u26A0 Already applied \\u2014 ' : '\\u2713 Saved \\u2014 ')
      + (payload.company || 'job') + ' \\u2192 Incoming';
    if (!d.duplicateCompany) setTimeout(() => window.close(), 800);
  } catch (e) {
    m.style.color = '#b42318';
    m.textContent = 'Error saving: ' + e;
  }
})();
</script>
</body></html>
"""


@app.get("/capture")
def capture():
    """Same-origin capture page. The bookmarklet opens this in a new tab with the job
    JSON in the URL hash; this page POSTs it to /api/jobs (no CORS / CSP / PNA issues,
    because it is served from this origin), then auto-closes. This sidesteps LinkedIn's
    Content-Security-Policy, which forbids connecting from its pages to localhost."""
    return CAPTURE_HTML


CAPTURE_BATCH_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><title>Saving…</title></head>
<body style="font:600 18px -apple-system,system-ui,sans-serif;padding:32px;color:#0a66c2">
<div id="m">Saving…</div>
<script>
(async () => {
  const m = document.getElementById('m');
  let jobs;
  try { jobs = JSON.parse(decodeURIComponent(location.hash.slice(1))); }
  catch (e) { m.style.color = '#b42318'; m.textContent = 'No job data in URL.'; return; }
  if (!Array.isArray(jobs) || !jobs.length) { m.textContent = 'No jobs in URL.'; return; }
  let saved = 0, dup = 0, failed = 0;
  for (const p of jobs) {
    try {
      const r = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p)
      });
      const d = await r.json();
      if (d.duplicateCompany) dup++; else saved++;
    } catch (e) { failed++; }
    m.textContent = 'Saving ' + (saved + dup + failed) + '/' + jobs.length + '\\u2026';
  }
  m.textContent = '\\u2713 Saved ' + saved
    + (dup ? ' \\u00b7 ' + dup + ' already applied' : '')
    + (failed ? ' \\u00b7 ' + failed + ' failed' : '')
    + ' \\u2192 Incoming';
  if (!failed) setTimeout(() => window.close(), 1500);
})();
</script>
</body></html>
"""


@app.get("/capture-batch")
def capture_batch():
    """Same-origin batch capture page. The scrape bookmarklet opens this with an ARRAY
    of jobs in the URL hash; it POSTs each to /api/jobs (same origin, so no CORS / CSP /
    PNA issues) and reports the saved / duplicate counts. Stays open so the counts are
    visible."""
    return CAPTURE_BATCH_HTML


BOOKMARKLET_FILES = {
    "add": "add-job.js",
    "dismiss": "dismiss-jobs.js",
    "scrape": "scrape-dismiss.js",
}


def _to_bookmarklet(src):
    """Turn a .js source into a draggable `javascript:` bookmarklet.

    A file that is already a built bookmarklet (starts with `javascript:`) is served
    as-is. Otherwise the source is treated as readable, normally-formatted JS and
    URL-encoded (newlines preserved, so `//` comments stay valid after decoding)."""
    src = src.strip()
    if src.startswith("javascript:"):
        return src
    return "javascript:" + urllib.parse.quote(src, safe="")


@app.get("/api/bookmarklet")
def bookmarklet():
    """Return the bookmarklet sources (the *.js files one dir up) so the UI can offer
    them as draggable links. Single source of truth = the files on disk."""
    out = {}
    for key, fn in BOOKMARKLET_FILES.items():
        try:
            with open(os.path.join(HERE, "..", fn), "r", encoding="utf-8") as f:
                out[key] = _to_bookmarklet(f.read())
        except OSError:
            out[key] = ""
    return jsonify(out)


# --- static frontend (built by `npm run build` into dist/) ---
@app.get("/")
def index():
    if os.path.exists(os.path.join(DIST, "index.html")):
        return send_from_directory(DIST, "index.html")
    return (
        "<h1>Job Tracker API</h1><p>Frontend not built yet. "
        "Run <code>npm install && npm run build</code> in tracker/.</p>",
        200,
    )


@app.get("/<path:path>")
def static_files(path):
    full = os.path.join(DIST, path)
    if os.path.isfile(full):
        return send_from_directory(DIST, path)
    # SPA fallback
    return index()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=PORT, debug=True)
