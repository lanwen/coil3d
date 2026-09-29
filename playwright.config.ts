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
  // Real GitHub-hosted runners (2 shared vCPUs, no GPU) are far slower at
  // software-rendered WebGL than this sandbox (see .github/workflows/ci.yml
  // and issue #18's PR): tests that touch the canvas took several times
  // longer than locally. `reducedMotion` below closes most of that gap for
  // the majority of tests, but NOT for: (a) the few files that
  // deliberately keep real motion (view-controls.spec.ts, top-cap.spec.ts's
  // exploded-view describes -- see `use.contextOptions` below), which
  // still exercise the expensive tween/damp code path on purpose, and (b)
  // heavy renders that were never about motion at all (e.g. label.spec.ts's
  // zoomed-in engraved-label screenshots -- a real CPU cost from render
  // complexity, not an animation). A real CI run confirmed both still need
  // this same generous headroom, so it stays global rather than tightened.
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
  // difference (font, DPR, GPU flags). Root-caused with a throttled (2-cpu)
  // reproduction of the official Docker image (issue #18's PR): total
  // Chromium RSS stayed flat across repeats (not a leak), `frameloop` is
  // already "demand" everywhere (not continuously rendering), but the
  // damped camera/explode tweens were a real cost -- each cheap-looking
  // "wait for a stable frame" was genuinely waiting out however many
  // expensive SwiftShader frames a real (non-instant) transition needs.
  // `reducedMotion` below removes that cost for most of the suite (measured
  // ~2x faster per screenshot in the same throttled repro) -- but a real CI
  // run tightened to 30s still failed, on both the few files that
  // deliberately keep real motion AND on a heavy render unrelated to motion
  // (see `timeout`'s comment above), so this stays at the proven-green 60s
  // rather than a number the data doesn't actually support yet.
  expect: {
    timeout: process.env.CI ? 60_000 : 5_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
  webServer: {
    // `npm run build` is `tsc -b && vite build`, but typechecking isn't this
    // job's contract -- `npx tsc -b` already runs as its own, separate proof
    // step (see the repo's test-audit S3 finding: every e2e run paid for a
    // redundant typecheck here on top of that). `vite build` alone still
    // gives the e2e suite the real production bundle, just without paying
    // for tsc a second time.
    command: `npx vite build && npx vite preview --port ${PORT} --host 0.0.0.0 --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    // Almost every screenshot test only cares about the SETTLED state of a
    // camera/explode transition, not that it's animated -- and the app
    // already fully honors `prefers-reduced-motion` (matchMedia) to skip
    // straight there (CoilViewer.tsx, LineArtRenderer.tsx), landing on the
    // exact same target, so the settled pixels this suite's baselines
    // capture are identical either way. Reducing motion everywhere by
    // default (in CI *and* locally) cuts real render cost roughly in half
    // (see `expect.timeout`'s comment) with no coverage loss; the files
    // that are actually ABOUT the transition/explode system (view-controls.
    // spec.ts, and top-cap.spec.ts's own exploded-view describe blocks)
    // opt back into real motion with their own `test.use(...)`.
    contextOptions: { reducedMotion: "reduce" },
    launchOptions: {
      ...(existsSync(PINNED_CHROMIUM) ? { executablePath: PINNED_CHROMIUM } : {}),
      args: swiftshaderArgs,
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
