import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// E2E_PORT lets parallel checkouts (e.g. agent worktrees) use their own port.
const PORT = Number(process.env.E2E_PORT ?? 5182);

// The sandbox's globally-installed Chromium (kept in sync with the kit's
// pinned revision) is the only build in this environment that can create a
// WebGL context via SwiftShader; the npm-installed browser resolves a newer
// revision that cannot. Outside that sandbox this path won't exist, so fall
// back to Playwright's own browser resolution.
const PINNED_CHROMIUM = "/opt/ms-playwright/chromium-1228/chrome-linux/chrome";
const swiftshaderArgs = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

export default defineConfig({
  testDir: "./e2e",
  // CI (and especially the containerized Playwright-image run used for the
  // e2e job, see .github/workflows/ci.yml) is noticeably slower per-frame
  // than this sandbox's native Chromium, so tests get more overall headroom.
  timeout: process.env.CI ? 60_000 : 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // CI runners have few cores and the e2e job's Playwright-image container
  // shares them across all screenshot tests; capping workers avoids
  // GPU/SwiftShader contention (see docs/research.md and issue #18 review
  // comments). Left unset locally so `npm run e2e` keeps using this
  // machine's own default worker count.
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  // Software-rendered WebGL (SwiftShader, see PINNED_CHROMIUM above) is
  // deterministic per-machine but not bit-identical across environments, so
  // screenshot assertions get a small pixel-ratio allowance rather than an
  // exact match. `expect.timeout` (not the pixel allowance) is what needed
  // raising for CI: verified against the exact baselines in this repo, in
  // the official mcr.microsoft.com/playwright:v1.61.1-noble image (same
  // Chromium 1228 build the baselines were shot with, via PLAYWRIGHT_BROWSERS_PATH
  // -- see PINNED_CHROMIUM below), every screenshot matched pixel-for-pixel;
  // the one flake seen there was the frame-stability wait alone exceeding
  // the default 5s under that container's slower/virtualized CPU, not a
  // rendering difference (font, DPR, GPU) -- so only the timeout moved.
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    launchOptions: {
      ...(existsSync(PINNED_CHROMIUM) ? { executablePath: PINNED_CHROMIUM } : {}),
      args: swiftshaderArgs,
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
