// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import JobList from "../../src/components/JobList.jsx";
import { job } from "./fixtures.js";

afterEach(cleanup);

function renderList(jobs, props = {}) {
  const handlers = {
    onSearch: vi.fn(),
    onToggle: vi.fn(),
    onToggleAll: vi.fn(),
    onOpen: vi.fn(),
    onPage: vi.fn(),
    onBulk: vi.fn(),
  };
  render(
    <JobList
      title="Waiting for me"
      page={{ total: jobs.length, jobs }}
      offset={0}
      pageSize={50}
      selected={new Set()}
      cursor={0}
      openId={null}
      q=""
      searchRef={{ current: null }}
      {...handlers}
      {...props}
    />
  );
  return handlers;
}

describe("JobList", () => {
  it("renders one row per job, bold while it waits for the human, with its needs as the snippet", () => {
    renderList([
      job({ id: 1, company: "Acme", status: "blocked", needs: [{ id: "n1", type: "consent", text: "Privacy dropdown" }] }),
      job({ id: 2, company: "Beta", status: "new", last_event: "captured" }),
    ]);
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Acme").className).toMatch(/font-semibold/);
    expect(within(rows[0]).getByText(/needs: Privacy dropdown/)).toBeTruthy();
    expect(within(rows[0]).getByLabelText("Blocked: needs you")).toBeTruthy();
    expect(within(rows[1]).getByText("Beta").className).not.toMatch(/font-semibold/);
  });

  it("shows badges for ATS, track, duplicate, referral and scam", () => {
    renderList([job({ ats: "workday", track: "remote", duplicateCompany: true, referral: "Jane", scam_flag: true })]);
    const row = screen.getByRole("row");
    for (const text of ["workday", "remote", "dup", "referral", "⚠ scam?"]) expect(within(row).getByText(text)).toBeTruthy();
  });

  it("flags an in-progress job no agent holds as stalled", () => {
    renderList([job({ status: "in_progress", owner: null })]);
    expect(screen.getByLabelText("In progress, no agent holds it")).toBeTruthy();
  });

  it("opens a job on row click and toggles selection on the checkbox without opening", async () => {
    const h = renderList([job({ id: 7 })]);
    await userEvent.click(screen.getByLabelText(/Select Acme/));
    expect(h.onToggle).toHaveBeenCalledWith(7);
    expect(h.onOpen).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("Senior Engineer"));
    expect(h.onOpen).toHaveBeenCalledWith(7);
  });

  it("swaps the search box for bulk actions the selection allows", async () => {
    const h = renderList([job({ id: 1, status: "new" }), job({ id: 2, status: "trash" })], { selected: new Set([1, 2]) });
    const bar = screen.getByRole("toolbar", { name: "Bulk actions" });
    expect(within(bar).getByText("2 selected")).toBeTruthy();
    const labels = within(bar).getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["Triage", "Hold", "Trash", "Restore"]); // Start needs a triaged job
    await userEvent.click(within(bar).getByText("Trash"));
    expect(h.onBulk).toHaveBeenCalledWith("trash");
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("pages with ‹ › and shows the range", async () => {
    const h = renderList([job()], { page: { total: 120, jobs: [job()] }, offset: 50 });
    expect(screen.getByText("51–100 of 120")).toBeTruthy();
    await userEvent.click(screen.getByLabelText("Older"));
    expect(h.onPage).toHaveBeenCalledWith(100);
    await userEvent.click(screen.getByLabelText("Newer"));
    expect(h.onPage).toHaveBeenCalledWith(0);
  });

  it("has a friendly empty state for Waiting for me", () => {
    renderList([]);
    expect(screen.getByText(/Nothing is waiting for you/)).toBeTruthy();
  });
});
