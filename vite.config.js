import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: Vite serves the UI on 5173 for the Electron window (`npm run electron:dev`).
// Build: outputs to dist/, which the app loads from disk; base "./" keeps asset URLs
// relative so they resolve under file://. The UI reaches data over IPC, not HTTP.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
