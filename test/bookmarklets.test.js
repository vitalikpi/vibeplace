import { describe, expect, it } from "vitest";

import { listBookmarklets } from "../electron/bookmarklets.js";
import { tempDataRoot } from "./helpers.js";

const decode = (code) => decodeURIComponent(code.slice("javascript:".length));

describe("listBookmarklets", () => {
  it("returns [] when there is no bookmarklets/ folder", () => {
    tempDataRoot();
    expect(listBookmarklets()).toEqual([]);
  });

  it("lists every .js file sorted by name, labeled from the file name", () => {
    tempDataRoot({
      "bookmarklets/zeta_tool.js": "alert(1)",
      "bookmarklets/add-job.js": "alert(2)",
      "bookmarklets/readme.txt": "not a bookmarklet",
    });
    expect(listBookmarklets().map(({ file, label }) => ({ file, label }))).toEqual([
      { file: "add-job.js", label: "Add job" },
      { file: "zeta_tool.js", label: "Zeta tool" },
    ]);
  });

  it("skips empty files", () => {
    tempDataRoot({ "bookmarklets/empty.js": "  \n " });
    expect(listBookmarklets()).toEqual([]);
  });

  it("URL-encodes readable source like Python's quote(safe=''), keeping newlines", () => {
    const src = "// grab it!\nconst x = (a) => a * 2; open('/x?y=1&z=~');";
    tempDataRoot({ "bookmarklets/a.js": src });
    const [{ code }] = listBookmarklets();
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
    expect(listBookmarklets()[0].code).toBe(built);
  });

  it("points any local tracker address at this app's port", () => {
    tempDataRoot({
      "bookmarklets/a.js": "open('http://127.0.0.1:8765/capture#x'); fetch('http://localhost:5000/api/jobs')",
      "bookmarklets/b.js": "javascript:window.open('http://127.0.0.1:8765/capture-batch#'+d)",
    });
    const [a, b] = listBookmarklets();
    expect(decode(a.code)).toBe(
      `open('http://127.0.0.1:${process.env.PORT}/capture#x'); fetch('http://127.0.0.1:${process.env.PORT}/api/jobs')`
    );
    expect(b.code).toBe(`javascript:window.open('http://127.0.0.1:${process.env.PORT}/capture-batch#'+d)`);
  });

  it("leaves non-local hosts alone", () => {
    tempDataRoot({ "bookmarklets/a.js": "fetch('https://example.com:8443/x')" });
    expect(decode(listBookmarklets()[0].code)).toBe("fetch('https://example.com:8443/x')");
  });
});
