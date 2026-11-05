import { useEffect, useRef } from "react";

const TYPING = new Set(["INPUT", "TEXTAREA", "SELECT"]);

// Gmail-style single-key shortcuts. `bindings` maps e.key → handler; keys are ignored
// while typing in a field or with Cmd/Ctrl/Alt held (those stay with the app menu).
export default function useKeyboard(bindings, enabled = true) {
  const ref = useRef(bindings);
  ref.current = bindings;
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (TYPING.has(t.tagName) || t.isContentEditable) && e.key !== "Escape") return;
      const fn = ref.current[e.key];
      if (!fn) return;
      e.preventDefault();
      fn(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
