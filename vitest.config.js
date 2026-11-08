import { defineConfig } from "vitest/config";

// A fixed zone, so "local day" logic (statsToday, statsDaily) is deterministic and
// exercises a UTC offset. Workers inherit it.
process.env.TZ = "America/New_York";

export default defineConfig({
  esbuild: { jsx: "automatic" }, // the components rely on the automatic JSX runtime
  test: {
    environment: "node", // UI tests opt into jsdom with a @vitest-environment comment
    include: ["test/**/*.test.{js,jsx}"],
    // PORT feeds the server's Host allow-list; tests send this Host header and never
    // listen on a real port.
    env: { PORT: "17085" },
  },
});
