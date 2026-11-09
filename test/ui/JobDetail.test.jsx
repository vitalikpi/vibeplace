// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import JobDetail from "../../src/components/JobDetail.jsx";
import { job } from "./fixtures.js";

afterEach(cleanup);

function renderDetail(overrides = {}) {
  const h = {
    onTransition: vi.fn(),
    onSetFields: vi.fn(),
    onAddNote: vi.fn(async () => {}),
    onReveal: vi.fn(async () => "s3cret"),
    onClose: vi.fn(),
  };
  render(<JobDetail job={job(overrides)} tracks={[{ key: "remote", label: "Remote" }]} {...h} />);
  return h;
}

const actionLabels = () =>
  within(screen.getByRole("toolbar", { name: "Actions" }))
    .getAllByRole("button")
    .map((b) => b.textContent);

describe("JobDetail", () => {
  it("offers only the moves the human may make from the status", () => {
    renderDetail({ status: "new" });
    expect(actionLabels()).toEqual(["Triage ✓", "Hold", "Submitted ✓", "Rejected", "Trash"]);
    cleanup();
    renderDetail({ status: "triaged" });
    expect(actionLabels()).toEqual(["Start", "Hold", "Submitted ✓", "Rejected", "Trash"]);
    cleanup();
    renderDetail({ status: "ready" });
    expect(actionLabels()).toEqual(["Send back to agent", "Hold", "Submitted ✓", "Rejected", "Trash"]);
    cleanup();
    renderDetail({ status: "trash" });
    expect(actionLabels()).toEqual(["Restore"]);
  });

  it("runs an action", async () => {
    const h = renderDetail({ status: "triaged" });
    await userEvent.click(screen.getByText("Start"));
    expect(h.onTransition).toHaveBeenCalledWith("in_progress");
  });

  it("moves anywhere through Move to… as an override", async () => {
    const h = renderDetail({ status: "rejected" });
    await userEvent.selectOptions(screen.getByLabelText("Move to"), "applied");
    await userEvent.click(screen.getByText("Move"));
    expect(h.onTransition).toHaveBeenCalledWith("applied", { override: true });
  });

  it("for a blocked job, shows the agent's message in the timeline and Unblock in the toolbar", async () => {
    const h = renderDetail({
      status: "blocked",
      events: [{ id: 1, actor: "agent:a", from_status: "in_progress", to_status: "blocked", message: "Accept the privacy consent", at: "2026-11-05T12:00:00+00:00" }],
    });
    expect(screen.getByText("Accept the privacy consent")).toBeTruthy();
    expect(actionLabels()).toContain("Unblock");
    await userEvent.click(screen.getByRole("button", { name: "Unblock" }));
    expect(h.onTransition).toHaveBeenCalledWith("in_progress");
  });

  it("links only to http(s) URLs", () => {
    renderDetail({ url: "javascript:alert(1)", apply_url: "https://jobs.ashbyhq.com/acme/1" });
    expect(screen.queryByText("Posting ↗")).toBeNull();
    expect(screen.getByText("Application ↗").getAttribute("href")).toBe("https://jobs.ashbyhq.com/acme/1");
  });

  it("saves fields and notes on blur, and adds timeline notes", async () => {
    const h = renderDetail({ notes: "" });
    await userEvent.type(screen.getByPlaceholderText("https://…"), "https://boards.greenhouse.io/x");
    await userEvent.tab();
    expect(h.onSetFields).toHaveBeenCalledWith({ apply_url: "https://boards.greenhouse.io/x" });
    await userEvent.selectOptions(screen.getByLabelText("Track"), "remote");
    expect(h.onSetFields).toHaveBeenCalledWith({ track: "remote" });
    await userEvent.type(screen.getByLabelText("Your notes"), "call Jane");
    await userEvent.tab();
    expect(h.onSetFields).toHaveBeenCalledWith({ notes: "call Jane" });
    await userEvent.type(screen.getByPlaceholderText("Add to the timeline…"), "phone screen booked{Enter}");
    expect(h.onAddNote).toHaveBeenCalledWith("phone screen booked");
  });

  it("hides the account password until asked", async () => {
    const h = renderDetail({ account: { tenant: "acme.wd1.myworkdayjobs.com", email: "me@x" } });
    const account = screen.getByRole("region", { name: "Account" });
    expect(within(account).queryByText("s3cret")).toBeNull();
    await userEvent.click(within(account).getByText("Show"));
    expect(h.onReveal).toHaveBeenCalled();
    expect(await within(account).findByText("s3cret")).toBeTruthy();
  });

  it("shows the timeline newest first with actors and moves", () => {
    renderDetail({
      events: [
        { id: 1, at: "2026-11-05T10:00:00+00:00", actor: "bookmarklet", from_status: null, to_status: "new", message: "captured" },
        { id: 2, at: "2026-11-05T11:00:00+00:00", actor: "agent:triage", from_status: "new", to_status: "triaged", message: "GO: fits" },
      ],
    });
    const items = within(screen.getByRole("list", { name: "Timeline" })).getAllByRole("listitem");
    expect(items[0].textContent).toMatch(/agent:triage.*New → Triaged.*GO: fits/);
    expect(items[1].textContent).toMatch(/bookmarklet.*→ New/);
  });
});
