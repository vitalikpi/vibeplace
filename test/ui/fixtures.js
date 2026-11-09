import { vi } from "vitest";

// A job summary as jobs:list returns it.
export function job(overrides = {}) {
  return {
    id: 1,
    company: "Acme",
    title: "Senior Engineer",
    location: "Remote",
    url: "https://jobs.example.com/1",
    apply_url: null,
    ats: null,
    track: null,
    status: "new",
    created_at: "2026-11-05T12:00:00+00:00",
    updated_at: "2026-11-05T12:00:00+00:00",
    applied_at: null,
    referral: null,
    scam_flag: false,
    owner: null,
    lease_until: null,
    tab_id: null,
    step: null,
    last_event: "captured",
    duplicateCompany: false,
    notes: "",
    events: [],
    account: null,
    ...overrides,
  };
}

// A fake window.tracker over a list of jobs; every method is a vi.fn.
export function fakeTracker(jobs) {
  let listener = null;
  const byFolder = (folder) =>
    jobs.filter((j) => (folder === "waiting" ? ["blocked", "ready"].includes(j.status) : j.status === folder));
  const t = {
    listJobs: vi.fn(async ({ folder }) => {
      const list = byFolder(folder);
      return { total: list.length, jobs: list };
    }),
    getJob: vi.fn(async (id) => jobs.find((j) => j.id === id) ?? null),
    folderCounts: vi.fn(async () => ({ waiting: byFolder("waiting").length, new: byFolder("new").length })),
    transition: vi.fn(async (id, to) => ({ ...jobs.find((j) => j.id === id), status: to })),
    bulkTransition: vi.fn(async (ids) => ({ moved: ids, refused: [] })),
    setFields: vi.fn(async (id, f) => ({ ...jobs.find((j) => j.id === id), ...f })),
    addNote: vi.fn(async () => ({})),
    revealPassword: vi.fn(async () => "s3cret"),
    stats: vi.fn(async () => ({})),
    statsToday: vi.fn(async () => ({ captured: 0, applied: 0, trashed: 0 })),
    statsDaily: vi.fn(async () => []),
    bookmarklets: vi.fn(async () => []),
    settings: vi.fn(async () => ({ links: [], tracks: [{ key: "remote", label: "Remote" }] })),
    onChange: vi.fn((cb) => {
      listener = cb;
      return () => (listener = null);
    }),
    push: (change) => listener?.(change),
  };
  return t;
}
