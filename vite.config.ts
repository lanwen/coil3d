import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// No COOP/COEP headers here on purpose: GitHub Pages can't set them, so the
// app must run on single-threaded WASM only (see docs/research.md §4).
export default defineConfig({
  plugins: [react()],
  server: { port: 5180, host: "0.0.0.0" },
  preview: { port: 5180, host: "0.0.0.0" },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
