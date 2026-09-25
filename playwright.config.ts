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
  // Real GitHub-hosted runners (2 shared vCPUs, no GPU) turned out to be far
  // slower at software-rendered WebGL than this sandbox or even a local run
  // of the same official Playwright Docker image (see .github/workflows/
  // ci.yml and issue #18's PR): tests that touch the canvas took 5-10x
  // longer than locally, and the heaviest (several sequential screenshots
  // in one test) needed close to `expect.timeout` below just for their
  // LAST assertion, so this needs enough headroom above that, not just
  // above a typical test's total local runtime.
  timeout: process.env.CI ? 180_000 : 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // One worker in CI: two parallel software-rendered WebGL/WASM-heavy pages
  // fighting over a 2-vCPU runner was slower overall (contention) than
  // running them one at a time, and caused widespread screenshot-stability
  // timeouts. Left unset locally so `npm run e2e` keeps using this
  // machine's own default worker count.
  workers: process.env.CI ? 1 : undefined,
  // CI shards the suite across parallel runner jobs (.github/workflows/
  // ci.yml), each with its own worker=1 process, so no single report from
  // any one shard covers the whole run. "blob" is Playwright's own format
  // for that: each shard uploads its blob-report/ as an artifact, and a
  // separate merge-reports job combines them into one browsable HTML
  // report. "github" adds inline PR annotations on failures at no extra
  // cost. Locally (no sharding) plain "list" is all that's needed.
  reporter: process.env.CI ? [["blob"], ["github"]] : "list",
  // Software-rendered WebGL (SwiftShader, see PINNED_CHROMIUM above) is
  // deterministic per-machine but not bit-identical across environments, so
  // screenshot assertions get a small pixel-ratio allowance rather than an
  // exact match. Verified in the official mcr.microsoft.com/playwright:
  // v1.61.1-noble image (same Chromium 1228 build the baselines were shot
  // with, via PLAYWRIGHT_BROWSERS_PATH -- see PINNED_CHROMIUM below): every
  // screenshot matched pixel-for-pixel there, so `expect.timeout` (not the
  // pixel allowance) is what needed raising for CI -- the real bottleneck is
  // render speed on that shared, GPU-less hardware, not a rendering
  // difference (font, DPR, GPU flags). 30s wasn't enough either: real runs
  // showed tests that take several sequential screenshots (zooms, toggles,
  // camera-preset switches) in one test regularly needing closer to a
  // minute for the LAST screenshot's own "wait for a stable frame" check,
  // apparently because the main thread is still working through earlier
  // renders' backlog by the time that check starts sampling frames.
  expect: {
    timeout: process.env.CI ? 60_000 : 5_000,
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
