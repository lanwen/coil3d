import { execSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Which build is this? Injected as `__BUILD__` (see src/vite-env.d.ts) and also
// written to dist/version.json, so a deploy can be checked with curl.
// Commit: VITE_BUILD_SHA (the e2e build pins it so screenshot baselines stay
// stable), else Cloudflare Pages' CF_PAGES_COMMIT_SHA, else git HEAD, else "dev".
function gitHead(): string | undefined {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}
const commit = process.env.VITE_BUILD_SHA || process.env.CF_PAGES_COMMIT_SHA || gitHead() || "dev";
const build = {
  commit,
  short: commit === "dev" ? "dev" : commit.slice(0, 7),
  builtAt: process.env.VITE_BUILD_TIME || new Date().toISOString(),
  // Only Cloudflare Pages knows the branch; "" otherwise.
  branch: process.env.CF_PAGES_BRANCH ?? "",
};

// No COOP/COEP headers on purpose: the app runs on single-threaded WASM only
// (see docs/design.md, Geometry), so it works on any static host, `vite preview`
// included.
export default defineConfig({
  plugins: [
    react(),
    {
      name: "version-json",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "version.json", source: `${JSON.stringify(build, null, 2)}\n` });
      },
    },
  ],
  define: { __BUILD__: JSON.stringify(build) },
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
    setupFiles: ["test/support/yieldBetweenTests.ts"],
  },
});
