// npm postinstall: make node-pty's spawn-helper executable (macOS/Linux; Windows has
// no spawn-helper and no chmod), then rebuild native modules for Electron.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

if (process.platform !== "win32") {
  const prebuilds = path.join("node_modules", "node-pty", "prebuilds");
  for (const dir of fs.existsSync(prebuilds) ? fs.readdirSync(prebuilds) : []) {
    const helper = path.join(prebuilds, dir, "spawn-helper");
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
}
execSync("electron-builder install-app-deps", { stdio: "inherit" });
