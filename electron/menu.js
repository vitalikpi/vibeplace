// The application menu, as a plain template (no Electron import) so each platform's
// shape can be tested. main.js builds it with Menu.buildFromTemplate.
//
// Windows/Linux differences: no app menu, File ▸ Exit, a Terminal ▸ Shell picker
// (Windows), and Edit items that don't register Ctrl+C / Ctrl+V as accelerators: a
// registered accelerator eats the key before the page sees it, so Ctrl+C would never
// reach the terminal as an interrupt. Text fields handle those keys natively.
import { resolveShell } from "./terminal.js";

const EDIT_ROLES = ["undo", "redo", "separator", "cut", "copy", "paste", "selectAll"];

// handlers: {changeDataFolder, showDataFolder, setShell(id)}
export function menuTemplate({ platform, shells = [], shellChoice, handlers }) {
  const mac = platform === "darwin";
  const file = {
    label: "File",
    submenu: [
      { label: "Change Data Folder…", click: handlers.changeDataFolder },
      { label: "Show Data Folder", click: handlers.showDataFolder },
      { type: "separator" },
      mac ? { role: "close" } : { role: "quit", label: "Exit" },
    ],
  };
  const edit = mac
    ? { role: "editMenu" }
    : {
        label: "Edit",
        submenu: EDIT_ROLES.map((role) => (role === "separator" ? { type: "separator" } : { role, registerAccelerator: false })),
      };
  const current = resolveShell(shellChoice, shells);
  const terminal = platform === "win32" && {
    label: "Terminal",
    submenu: [
      {
        label: "Shell",
        submenu: [
          ...shells.map((s) => ({
            label: s.found ? s.label : `${s.label} (not found)`,
            type: "radio",
            enabled: s.found,
            checked: s.id === current?.id,
            click: () => handlers.setShell(s.id),
          })),
          { type: "separator" },
          { label: "Applies on Restart", enabled: false },
        ],
      },
    ],
  };
  return [mac && { role: "appMenu" }, file, edit, terminal, { role: "viewMenu" }, { role: "windowMenu" }].filter(Boolean);
}
