import { describe, expect, it } from "vitest";

import { kbd, terminalKeyAction } from "../../src/lib/platform.js";

const key = (k, mods = {}) => ({ type: "keydown", key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
const action = (e, mac, hasSelection = false) => terminalKeyAction(e, { mac, hasSelection });

describe("kbd", () => {
  it("renders shortcut labels per platform", () => {
    expect(kbd("ctrl+`", true)).toBe("⌃`");
    expect(kbd("ctrl+`", false)).toBe("Ctrl+`");
    expect(kbd("ctrl+shift+c", true)).toBe("⌃⇧C");
    expect(kbd("ctrl+shift+c", false)).toBe("Ctrl+Shift+C");
  });
});

describe("terminal keys on macOS", () => {
  it("⌘C copies a selection; other ⌘ combos go to the app", () => {
    expect(action(key("c", { metaKey: true }), true, true)).toBe("copy");
    expect(action(key("c", { metaKey: true }), true, false)).toBe("app");
    expect(action(key("v", { metaKey: true }), true)).toBe("app");
  });
  it("Ctrl+C goes to the shell; Ctrl+` toggles the pane", () => {
    expect(action(key("c", { ctrlKey: true }), true, true)).toBe("shell");
    expect(action(key("`", { ctrlKey: true }), true)).toBe("app");
  });
});

describe("terminal keys on Windows/Linux", () => {
  it("Ctrl+C copies a selection and interrupts without one", () => {
    expect(action(key("c", { ctrlKey: true }), false, true)).toBe("copy");
    expect(action(key("c", { ctrlKey: true }), false, false)).toBe("shell");
  });
  it("Ctrl+Shift+C copies; Ctrl+V and Ctrl+Shift+V paste", () => {
    expect(action(key("C", { ctrlKey: true, shiftKey: true }), false)).toBe("copy");
    expect(action(key("v", { ctrlKey: true }), false)).toBe("paste");
    expect(action(key("V", { ctrlKey: true, shiftKey: true }), false)).toBe("paste");
  });
  it("leaves the Windows key and the pane toggle to the app, other keys to the shell", () => {
    expect(action(key("c", { metaKey: true }), false, true)).toBe("app");
    expect(action(key("`", { ctrlKey: true }), false)).toBe("app");
    expect(action(key("d", { ctrlKey: true }), false)).toBe("shell");
    expect(action(key("a"), false)).toBe("shell");
    expect(action({ ...key("c", { ctrlKey: true }), type: "keyup" }, false, true)).toBe("shell");
  });
});
