import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle() {} } }));
vi.mock("node-pty", () => ({ default: { spawn: vi.fn() } }));

const { menuTemplate } = await import("../electron/menu.js");

const SHELLS = [
  { id: "gitbash", label: "Git Bash", file: null, kind: "posix", found: false },
  { id: "powershell", label: "PowerShell", file: "powershell.exe", kind: "powershell", found: true },
  { id: "cmd", label: "Command Prompt", file: "cmd.exe", kind: "cmd", found: true },
];
const handlers = () => ({ changeDataFolder: vi.fn(), showDataFolder: vi.fn(), setShell: vi.fn() });
const menu = (platform, shellChoice, h = handlers()) => menuTemplate({ platform, shells: SHELLS, shellChoice, handlers: h });
const top = (t) => t.map((m) => m.role || m.label);
const shellItems = (t) => t.find((m) => m.label === "Terminal").submenu[0].submenu.filter((i) => i.type === "radio");

describe("application menu", () => {
  it("keeps the macOS menu as it was, with no Terminal menu", () => {
    const t = menu("darwin");
    expect(top(t)).toEqual(["appMenu", "File", "editMenu", "viewMenu", "windowMenu"]);
    expect(t[1].submenu.at(-1)).toEqual({ role: "close" });
  });

  it("on Windows: no app menu, File ▸ Exit, a Terminal menu", () => {
    const t = menu("win32");
    expect(top(t)).toEqual(["File", "Edit", "Terminal", "viewMenu", "windowMenu"]);
    expect(t[0].submenu.at(-1)).toEqual({ role: "quit", label: "Exit" });
  });

  it("on Windows/Linux, Edit doesn't register Ctrl+C / Ctrl+V (they must reach the terminal)", () => {
    for (const platform of ["win32", "linux"]) {
      const items = menu(platform).find((m) => m.label === "Edit").submenu.filter((i) => i.role);
      expect(items.map((i) => i.role)).toEqual(["undo", "redo", "cut", "copy", "paste", "selectAll"]);
      expect(items.every((i) => i.registerAccelerator === false)).toBe(true);
    }
    expect(top(menu("linux"))).not.toContain("Terminal");
  });

  it("lists the shells as radios: the resolved one checked, missing ones disabled", () => {
    expect(shellItems(menu("win32", "cmd")).map((i) => [i.label, i.enabled, i.checked])).toEqual([
      ["Git Bash (not found)", false, false],
      ["PowerShell", true, false],
      ["Command Prompt", true, true],
    ]);
    // A saved choice that isn't installed falls back like the terminal does.
    expect(shellItems(menu("win32", "gitbash")).find((i) => i.checked).label).toBe("PowerShell");
  });

  it("picking a shell calls setShell with its id; File items call their handlers", () => {
    const h = handlers();
    const t = menu("win32", undefined, h);
    shellItems(t)[2].click();
    expect(h.setShell).toHaveBeenCalledWith("cmd");
    t[0].submenu[0].click();
    t[0].submenu[1].click();
    expect(h.changeDataFolder).toHaveBeenCalled();
    expect(h.showDataFolder).toHaveBeenCalled();
  });
});
