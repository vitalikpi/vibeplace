import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: Vite serves the UI on 5173 and proxies /api to the Electron app's server on
// $PORT (default 8775). Build: outputs to dist/, which the app serves on that port.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.PORT || 8775}`,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
