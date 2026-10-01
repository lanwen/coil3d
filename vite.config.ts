import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// No COOP/COEP headers on purpose: the app runs on single-threaded WASM only
// (see docs/research.md §4), so it works on any static host, `vite preview`
// included.
export default defineConfig({
  plugins: [react()],
  // The dev server pre-bundles deps into node_modules/.vite/deps, but
  // manifold-3d loads manifold.wasm relative to its own script, and the
  // wasm isn't copied there: the request fell through to index.html
  // ("unsupported MIME type 'text/html'"). Serving it from its own package
  // keeps the wasm next to the script. The production build is unaffected.
  optimizeDeps: { exclude: ["manifold-3d"] },
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
