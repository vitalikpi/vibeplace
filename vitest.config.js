import { defineConfig } from "vitest/config";

// A fixed zone, so "local day" logic (statsToday, statsDaily) is deterministic and
// exercises a UTC offset. Workers inherit it.
process.env.TZ = "America/New_York";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.js"],
    // PORT feeds the server's Host allow-list; tests send this Host header and never
    // listen on a real port.
    env: { PORT: "17085" },
  },
});
