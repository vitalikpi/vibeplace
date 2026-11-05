// Headless entry (no window): `TRACKER_DATA_ROOT=<folder> ELECTRON_RUN_AS_NODE=1 npx electron electron/serve.js`.
// Used for API/MCP parity tests; the desktop app starts through main.js.
import http from "node:http";
import { PORT, envDataRoot, getPaths, setDataRoot } from "./config.js";
import { closeDb, initDb } from "./db.js";
import { createServer } from "./server.js";

const root = envDataRoot();
if (!root) {
  console.error("Set TRACKER_DATA_ROOT to the data folder.");
  process.exit(1);
}
setDataRoot(root);
initDb(getPaths().DB_PATH);
// Plain http.Server: Express 5's app.listen() would pass bind errors to the callback.
const server = http.createServer(createServer());
server.once("error", (e) => {
  console.error(`Cannot listen on 127.0.0.1:${PORT}: ${e.message}`);
  process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Job Tracker API on http://127.0.0.1:${PORT} (data: ${getPaths().DATA_ROOT})`);
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close();
    closeDb();
    process.exit(0);
  });
}
