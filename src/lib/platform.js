// Platform-dependent keys and labels. The platform comes from the preload bridge
// (process.platform), else the browser's guess (tests, `npm run dev`).
export const platform = () =>
  window.tracker?.platform || (/Mac/i.test(globalThis.navigator?.platform || "") ? "darwin" : "other");
export const isMac = () => platform() === "darwin";

// "ctrl+`" → "⌃`" on macOS, "Ctrl+`" elsewhere.
export function kbd(combo, mac = isMac()) {
  const MAC = { ctrl: "⌃", shift: "⇧", alt: "⌥", cmd: "⌘" };
  const keys = combo.split("+");
  const key = keys.pop();
  if (mac) return keys.map((k) => MAC[k]).join("") + key.toUpperCase();
  return [...keys.map((k) => k[0].toUpperCase() + k.slice(1)), key.toUpperCase()].join("+");
}

// What the terminal does with a keydown: "copy" | "paste" (handled by the pane),
// "app" (left to the app menu / pane toggle), or "shell" (sent to the shell).
// macOS: ⌘C copies a selection, other ⌘ combos go to the app menu (⌘V pastes there).
// Elsewhere: Ctrl+C copies a selection and is an interrupt without one, Ctrl+Shift+C
// copies, Ctrl+V / Ctrl+Shift+V paste; the Windows key is left to the system.
export function terminalKeyAction(e, { mac = isMac(), hasSelection = false } = {}) {
  if (e.type !== "keydown") return "shell";
  const key = e.key.toLowerCase();
  if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "`") return "app";
  if (mac) {
    if (e.metaKey && key === "c" && hasSelection) return "copy";
    return e.metaKey ? "app" : "shell";
  }
  if (e.metaKey) return "app";
  if (e.ctrlKey && !e.altKey) {
    if (key === "c" && (e.shiftKey || hasSelection)) return "copy";
    if (key === "v") return "paste";
  }
  return "shell";
}
