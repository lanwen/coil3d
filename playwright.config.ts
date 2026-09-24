import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const PORT = 5180;

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
  webServer: {
    command: "npm run build && npm run preview -- --port 5180 --strictPort",
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
