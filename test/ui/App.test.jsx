// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import App from "../../src/App.jsx";
import { fakeTracker, job } from "./fixtures.js";

let tracker;
beforeEach(() => {
  tracker = fakeTracker([
    job({ id: 1, company: "Acme", status: "blocked", needs: [{ id: "n1", type: "consent", text: "Privacy" }] }),
    job({ id: 2, company: "Beta", status: "ready" }),
    job({ id: 3, company: "Gamma", status: "new" }),
  ]);
  window.tracker = tracker;
});
afterEach(() => {
  cleanup();
  delete window.tracker;
});

const rows = () => screen.getAllByRole("row");

describe("App", () => {
  it("opens on Waiting for me with counts in the sidebar", async () => {
    render(<App />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    const nav = screen.getByRole("navigation", { name: "Folders" });
    expect(within(nav).getByText("Waiting for me").closest("button").textContent).toMatch(/2$/);
    expect(tracker.listJobs).toHaveBeenCalledWith({ folder: "waiting", track: null, q: null, limit: 50, offset: 0 });
  });

  it("switches folders from the sidebar", async () => {
    render(<App />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    const nav = screen.getByRole("navigation", { name: "Folders" });
    await userEvent.click(within(nav).getByRole("button", { name: /^New/ }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.getByText("Gamma")).toBeTruthy();
  });

  it("moves the cursor with j/k and opens the job with Enter", async () => {
    render(<App />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    await userEvent.keyboard("j");
    expect(rows()[1].className).toMatch(/border-l-blue-500/);
    await userEvent.keyboard("k{Enter}");
    const pane = await screen.findByRole("complementary", { name: "Job details" });
    expect(within(pane).getByText("Acme")).toBeTruthy();
    expect(within(pane).getByText("The agent needs you")).toBeTruthy();
  });

  it("trashes the job under the cursor with e, and the selection with e when there is one", async () => {
    render(<App />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    await userEvent.keyboard("e");
    expect(tracker.transition).toHaveBeenCalledWith(1, "trash", undefined);
    await userEvent.keyboard("xjx");
    await userEvent.keyboard("e");
    expect(tracker.bulkTransition).toHaveBeenCalledWith([1, 2], "trash", undefined);
  });

  it("ignores shortcuts while typing in the search box", async () => {
    render(<App />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    await userEvent.keyboard("/");
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
    await userEvent.keyboard("e");
    expect(tracker.transition).not.toHaveBeenCalled();
    expect(screen.getByRole("searchbox").value).toBe("e");
  });

  it("shows a refused move as a toast", async () => {
    tracker.transition.mockRejectedValueOnce(
      new Error("Error invoking remote method 'jobs:transition': TransitionError: cannot move job 1 from blocked to in_progress")
    );
    render(<App />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    await userEvent.keyboard("s");
    expect((await screen.findByRole("status")).textContent).toBe("cannot move job 1 from blocked to in_progress");
  });

  it("reloads on a pushed change and opens the job a notification points at", async () => {
    render(<App />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    const calls = tracker.listJobs.mock.calls.length;
    act(() => tracker.push({ jobIds: [2], kinds: ["transition"] }));
    await waitFor(() => expect(tracker.listJobs.mock.calls.length).toBeGreaterThan(calls));
    act(() => tracker.push({ jobIds: [2], kinds: [], open: 2 }));
    const pane = await screen.findByRole("complementary", { name: "Job details" });
    expect(within(pane).getByText("Beta")).toBeTruthy();
  });

  it("shows track labels from settings and filters by them", async () => {
    render(<App />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    await userEvent.click(await screen.findByRole("button", { name: /Remote/ }));
    await waitFor(() => expect(tracker.listJobs).toHaveBeenLastCalledWith(expect.objectContaining({ track: "remote" })));
    expect(tracker.folderCounts).toHaveBeenLastCalledWith("remote");
  });
});
