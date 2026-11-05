import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: Vite serves the UI on 5173 and proxies /api to Flask on 8765.
// Build: outputs to dist/, which Flask serves in production (single port 8765).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8765",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
