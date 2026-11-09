// Canonical posting URLs, the dedup key for jobs. Job boards decorate the same posting
// with tracking params, search state and so on; each entry below maps one board's URLs
// to a single form. Anything else is kept as captured (trimmed).

const param = (u, ...names) => names.map((n) => u.searchParams.get(n)).find((v) => v && /^[\w-]+$/.test(v));

const BOARDS = [
  // /jobs/view/<id>/?trk=…, or a search page with ?currentJobId=<id>
  [
    /(^|\.)linkedin\.com$/,
    (u) => {
      const id = /\/jobs\/view\/(\d+)/.exec(u.pathname)?.[1] ?? param(u, "currentJobId");
      return id && /^\d+$/.test(id) ? `https://www.linkedin.com/jobs/view/${id}/` : null;
    },
  ],
  // /viewjob?jk=<id>, /rc/clk?jk=<id>, or a search page with ?vjk=<id>
  [
    /(^|\.)indeed\.[a-z.]+$/,
    (u) => {
      const id = param(u, "jk", "vjk");
      return id ? `https://${u.hostname.toLowerCase()}/viewjob?jk=${id}` : null;
    },
  ],
];

// The canonical URL when `url` is a posting on a known board, else null.
export function boardPostingUrl(url) {
  let u;
  try {
    u = new URL(String(url || "").trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const board = BOARDS.find(([re]) => re.test(host));
  return board ? board[1](u) : null;
}

// The URL to store and dedup a job on: canonical for known boards, else as captured.
export function postingUrl(url) {
  return boardPostingUrl(url) ?? String(url || "").trim();
}
