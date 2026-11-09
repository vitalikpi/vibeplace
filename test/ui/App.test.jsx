// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../../src/App.jsx";
import { fakeTracker, job } from "./fixtures.js";

// jsdom has no canvas, so stand in for xterm.js; the pane's wiring is what's tested.
const terms = [];
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor() {
      this.cols = 90;
      this.rows = 20;
      this.written = [];
      terms.push(this);
    }
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData(cb) {
      this.input = cb;
      return { dispose() {} };
    }
    write(d) {
      this.written.push(d);
    }
    reset() {}
    focus() {}
    dispose() {}
    hasSelection() {
      return false;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
};

let tracker;
beforeEach(() => {
  tracker = fakeTracker([
    job({ id: 1, company: "Acme", status: "blocked", last_event: "Accept the privacy consent" }),
    job({ id: 2, company: "Beta", status: "ready" }),
    job({ id: 3, company: "Gamma", status: "new" }),
  ]);
  window.tracker = tracker;
});
afterEach(() => {
  cleanup();
  delete window.tracker;
  localStorage.clear();
  terms.length = 0;
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
    expect(within(pane).getByRole("button", { name: "Unblock" })).toBeTruthy();
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

  it("toggles the terminal pane with ⌃` and the sidebar, keeping the session while hidden", async () => {
    const termBridge = {
      start: vi.fn(async () => ({ pid: 1, cwd: "/data" })),
      write: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      onData: vi.fn((cb) => ((termBridge.emit = cb), () => {})),
      onExit: vi.fn(() => () => {}),
    };
    tracker.terminal = termBridge;
    render(<App />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByRole("region", { name: "Terminal" })).toBeNull();

    await userEvent.keyboard("{Control>}`{/Control}");
    const pane = await screen.findByRole("region", { name: "Terminal" });
    await waitFor(() => expect(termBridge.start).toHaveBeenCalledWith(90, 20));
    expect(await within(pane).findByText("running in the data folder")).toBeTruthy();

    terms[0].input("ls\r"); // typing goes to the shell
    expect(termBridge.write).toHaveBeenCalledWith("ls\r");
    act(() => termBridge.emit("hi"));
    expect(terms[0].written).toContain("hi");

    const nav = screen.getByRole("navigation", { name: "Folders" });
    await userEvent.click(within(nav).getByRole("button", { name: /Terminal/ }));
    expect(pane.className).toMatch(/\bhidden\b/);
    expect(termBridge.stop).not.toHaveBeenCalled(); // hidden, not killed
    expect(JSON.parse(localStorage.getItem("termOpen"))).toBe(false);
  });

  it("labels the pane shortcut per platform and shows the shell the terminal runs", async () => {
    const nav = async () => {
      await waitFor(() => expect(rows()).toHaveLength(2));
      return within(screen.getByRole("navigation", { name: "Folders" })).getByRole("button", { name: /Terminal/ });
    };
    tracker.platform = "darwin";
    render(<App />);
    expect((await nav()).textContent).toMatch(/⌃`$/);
    cleanup();

    tracker.platform = "win32";
    tracker.terminal = {
      start: vi.fn(async () => ({ pid: 1, cwd: "C:\\data", shell: "PowerShell" })),
      write: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      onData: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
    };
    render(<App />);
    const button = await nav();
    expect(button.textContent).toMatch(/Ctrl\+`$/);
    await userEvent.click(button);
    const pane = await screen.findByRole("region", { name: "Terminal" });
    expect(await within(pane).findByText("running in the data folder (PowerShell)")).toBeTruthy();
    expect(within(pane).getByRole("button", { name: "Hide terminal" }).title).toBe("Hide (Ctrl+`)");
  });
});
