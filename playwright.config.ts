import { defineConfig, devices } from "@playwright/test";

// E2E_PORT lets several checkouts run the suite at once, each on its own port.
const PORT = Number(process.env.E2E_PORT ?? 5182);

// Optional: path to a specific Chromium executable. Unset (the default) uses
// the browser Playwright installed (`npx playwright install chromium`). Set it
// when that browser is unavailable, or to match the build the screenshot
// baselines were taken with (Chromium 1228, as in the CI image below).
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const swiftshaderArgs = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

export default defineConfig({
  testDir: "./e2e",
  // Real GitHub-hosted runners (2 shared vCPUs, no GPU) are far slower at
  // software-rendered WebGL than a typical dev machine (see .github/workflows/ci.yml
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
  timeout: process.env.CI ? 180_000 : 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // One worker in CI: two parallel software-rendered WebGL/WASM-heavy pages
  // fighting over a 2-vCPU runner was slower overall (contention) than
  // running them one at a time, and caused widespread screenshot-stability
  // timeouts. Locally four: a test spends most of its time waiting (the
  // design solving in its worker, settle sleeps), not using CPU, so four
  // workers finish a full run about a quarter faster than two on a
  // 9-CPU share without making it flaky (issue #275).
  workers: process.env.CI ? 1 : 4,
  // CI shards the suite across parallel runner jobs (.github/workflows/
  // ci.yml), each with its own worker=1 process, so no single report from
  // any one shard covers the whole run. "blob" is Playwright's own format
  // for that: each shard uploads its blob-report/ as an artifact, and a
  // separate merge-reports job combines them into one browsable HTML
  // report. "github" adds inline PR annotations on failures at no extra
  // cost. Locally (no sharding) plain "list" is all that's needed.
  reporter: process.env.CI ? [["blob"], ["github"]] : "list",
  // `expect.timeout`: in the mcr.microsoft.com/playwright:v1.61.1-noble
  // image (the same Chromium 1228 build the baselines were shot with) every
  // screenshot matched pixel-for-pixel, so `expect.timeout` (not the
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
    timeout: process.env.CI ? 60_000 : 15_000,
    // Software-rendered WebGL (SwiftShader) is deterministic per machine but
    // not bit-identical across machines and runs, so screenshots get a small
    // pixel-ratio allowance instead of an exact match. The allowance is for
    // that rendering noise only, not for absorbing real changes: a change
    // that moves pixels on purpose re-baselines the screenshots it touches
    // (issue #162). Measured noise is far below it: two full runs on one
    // machine rendered identical pixels, and earlier same-machine repeats
    // differed by about 0.03%. Loosen it for a single test only, with a
    // one-line reason next to the override.
    toHaveScreenshot: { maxDiffPixelRatio: 0.005 },
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
    // A fixed build id, so the version label in the screenshots doesn't change
    // with every commit.
    env: {
      VITE_BUILD_SHA: "0123456789abcdef0123456789abcdef01234567",
      VITE_BUILD_TIME: "2026-01-01T00:00:00.000Z",
    },
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
      ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
      args: swiftshaderArgs,
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
