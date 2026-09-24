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
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  // Software-rendered WebGL (SwiftShader, see PINNED_CHROMIUM above) is
  // deterministic per-machine but not bit-identical across environments, so
  // screenshot assertions get a small pixel-ratio allowance rather than an
  // exact match.
  expect: {
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
