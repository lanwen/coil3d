import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// No COOP/COEP headers here on purpose: GitHub Pages can't set them, so the
// app must run on single-threaded WASM only (see docs/research.md §4).
export default defineConfig({
  plugins: [react()],
  server: { port: 5182, host: "0.0.0.0" },
  preview: { port: 5182, host: "0.0.0.0" },
  // The STEP export worker (src/core/step/worker.ts) dynamically imports
  // replicad, so its own chunk needs code-splitting support: only the ES
  // module worker format allows that (see src/core/step/index.ts).
  worker: { format: "es" },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
