import { describe, expect, it } from "vitest";

import { listBookmarklets } from "../electron/bookmarklets.js";
import { tempDataRoot } from "./helpers.js";

const decode = (code) => decodeURIComponent(code.slice("javascript:".length));
// The user's bookmarklets only (the built-ins are tested separately below).
const own = () => listBookmarklets().filter((b) => !b.builtin);

describe("listBookmarklets", () => {
  it("has none of the user's when there is no bookmarklets/ folder", () => {
    tempDataRoot();
    expect(own()).toEqual([]);
  });

  it("lists every .js file sorted by name, labeled from the file name", () => {
    tempDataRoot({
      "bookmarklets/zeta_tool.js": "alert(1)",
      "bookmarklets/add-job.js": "alert(2)",
      "bookmarklets/readme.txt": "not a bookmarklet",
    });
    expect(own().map(({ file, label }) => ({ file, label }))).toEqual([
      { file: "add-job.js", label: "Add job" },
      { file: "zeta_tool.js", label: "Zeta tool" },
    ]);
  });

  it("skips empty files", () => {
    tempDataRoot({ "bookmarklets/empty.js": "  \n " });
    expect(own()).toEqual([]);
  });

  it("URL-encodes readable source like Python's quote(safe=''), keeping newlines", () => {
    const src = "// grab it!\nconst x = (a) => a * 2; open('/x?y=1&z=~');";
    tempDataRoot({ "bookmarklets/a.js": src });
    const [{ code }] = own();
    expect(code.startsWith("javascript:")).toBe(true);
    expect(code).not.toMatch(/[!'()* \n]/);
    expect(code).toContain("%21"); // !
    expect(code).toContain("%27"); // '
    expect(code).toContain("%28"); // (
    expect(code).toContain("%0A"); // newline survives, encoded
    expect(code).toContain("~"); // unreserved, left as is
    expect(decode(code)).toBe(src);
  });

  it("passes an already-built javascript: bookmarklet through unchanged", () => {
    const built = "javascript:(()=>alert(%27hi%27))()";
    tempDataRoot({ "bookmarklets/built.js": `  ${built}\n` });
    expect(own()[0].code).toBe(built);
  });

  it("points any local tracker address at this app's port", () => {
    tempDataRoot({
      "bookmarklets/a.js": "open('http://127.0.0.1:8765/capture#x'); fetch('http://localhost:5000/api/jobs')",
      "bookmarklets/b.js": "javascript:window.open('http://127.0.0.1:8765/capture-batch#'+d)",
    });
    const [a, b] = own();
    expect(decode(a.code)).toBe(
      `open('http://127.0.0.1:${process.env.PORT}/capture#x'); fetch('http://127.0.0.1:${process.env.PORT}/api/jobs')`
    );
    expect(b.code).toBe(`javascript:window.open('http://127.0.0.1:${process.env.PORT}/capture-batch#'+d)`);
  });

  it("leaves non-local hosts alone", () => {
    tempDataRoot({ "bookmarklets/a.js": "fetch('https://example.com:8443/x')" });
    expect(decode(own()[0].code)).toBe("fetch('https://example.com:8443/x')");
  });
});

describe("built-in ✅ Unblocked", () => {
  const builtin = () => listBookmarklets().find((b) => b.builtin);

  // Run the bookmarklet against a fake page; returns the URL it opened (or null).
  function press({ title, href = "https://acme.wd1.myworkdayjobs.com/job/1/apply", answer = "" }) {
    const opened = [];
    const run = new Function("document", "location", "prompt", "window", decode(builtin().code));
    run({ title }, { href }, () => answer, { open: (url) => opened.push(url) });
    return opened[0] ?? null;
  }
  const request = (url) => JSON.parse(decodeURIComponent(url.split("#")[1]));

  it("always comes first, even with no bookmarklets/ folder, and the user's follow it", () => {
    tempDataRoot({ "bookmarklets/add.js": "alert(1)" });
    expect(listBookmarklets().map((b) => [b.file, b.label, b.builtin])).toEqual([
      ["unblocked.js", "✅ Unblocked", true],
      ["add.js", "Add", false],
    ]);
    tempDataRoot();
    expect(listBookmarklets()).toHaveLength(1);
  });

  it("opens this app's /act page with an unblock for '#<id>' from the tab title", () => {
    tempDataRoot();
    const url = press({ title: "🟡 #42 Application – Acme", answer: "  Java level 3  " });
    expect(url.startsWith(`http://127.0.0.1:${process.env.PORT}/act#`)).toBe(true);
    expect(request(url)).toEqual({
      op: "unblock",
      job_id: 42,
      url: "https://acme.wd1.myworkdayjobs.com/job/1/apply",
      title: "🟡 #42 Application – Acme",
      answers: "Java level 3",
    });
  });

  it("falls back to the page URL without an id, and sends no answers when left empty", () => {
    tempDataRoot();
    const req = request(press({ title: "Apply – Acme" }));
    expect(req).toEqual({ op: "unblock", url: "https://acme.wd1.myworkdayjobs.com/job/1/apply", title: "Apply – Acme" });
  });

  it("does nothing when the prompt is cancelled", () => {
    tempDataRoot();
    expect(press({ title: "#42", answer: null })).toBeNull();
  });
});

