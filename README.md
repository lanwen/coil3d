# scroll3d

A static, client-side app that designs a 3D-printable cable coil from your
cable's length and diameter. See `docs/research.md` for the full design
notes.

This slice (issue #2, "tracer bullet") covers a round core only, wound in a
single layer: enter a cable length and diameter, get a solved coil height,
turn count and STL download. The configuration lives in the URL hash.

## Stack

Vite + React + TypeScript + react-three-fiber, with a headless, framework-free
coil core (`src/core`) that the UI is the only consumer of. The core's public
interface is exactly `parseHash`/`toHash`, `design(spec)` and
`exportDesign(design, fmt)`.

## Dev commands

```sh
npm install

npm run dev       # dev server on :5180
npm run build     # typecheck + production build
npm run preview   # serve the production build on :5180

npm test          # vitest — the coil core's public interface
npm run e2e       # playwright — URL hash -> UI -> STL download
```

`npm run e2e` builds and previews the app itself (see `playwright.config.ts`),
so a dev server does not need to be running first.

## Notes

- The core never imports React or three.js; the app and viewer only import
  from `src/core`.
- Geometry runs on [manifold-3d](https://github.com/elalish/manifold), a
  single-threaded WASM build, so the app works with no COOP/COEP headers
  (required for GitHub Pages).

## CI

`.github/workflows/ci.yml` runs on every pull request and on push to `main`:

1. **`build-and-test`** — `npm ci`, `tsc -b` (typecheck), `vitest run` (the
   coil core's public interface), then `npm run build`.
2. **`e2e`** — Playwright, in the official
   [`mcr.microsoft.com/playwright:v1.61.1-noble`](https://playwright.dev/docs/docker)
   image (matching this repo's pinned `@playwright/test` version), so the
   container's bundled Chromium is the same build the checked-in screenshot
   baselines were shot with. Workers are capped (see `playwright.config.ts`)
   to avoid GPU/SwiftShader contention. On failure, the Playwright HTML
   report and `test-results/` (screenshot diffs, traces) are uploaded as
   workflow artifacts.

## GitHub Pages deploy

`.github/workflows/pages.yml` builds the app with the base path GitHub Pages
needs for a project site (`https://lanwen.github.io/scroll3d/`) and uploads
it as a Pages artifact on every push to `main`. The actual **deploy** job is
gated behind the `PAGES_ENABLED` repository variable — until that variable
is set to `true`, the workflow's build step still runs (harmless: it doesn't
touch any repo/Pages settings) but nothing is ever published, and the
workflow neither fails nor blocks on Pages being disabled.

To turn deploys on:

1. **Settings → Pages → Source: GitHub Actions** (one-time; this is the only
   step that actually enables Pages, and it's a manual, deliberate choice —
   the workflow itself never does this).
2. **Settings → Secrets and variables → Actions → Variables → New repository
   variable**: name `PAGES_ENABLED`, value `true`.
3. Push to `main`, or run the "Deploy to GitHub Pages" workflow manually
   (Actions tab → Deploy to GitHub Pages → Run workflow).

### Known issue: WASM compression on GitHub Pages

The lazily-loaded replicad WASM (`src/core/step`, only fetched once a user
clicks "Download STEP") is **~23 MB raw / ~7.2 MB gzip** — larger than this
project's early ~5 MB brotli estimate (see `docs/research.md`). GitHub
Pages' CDN does not brotli-compress arbitrary static assets, and it's not
yet confirmed here whether it gzips `.wasm` at all (Pages' compression is
extension/mime-type-based and historically hasn't reliably covered `.wasm`).
Once Pages is enabled, check the actual `Content-Encoding` served for
`assets/*.wasm` (e.g. `curl -sI -H 'Accept-Encoding: gzip, br'
https://lanwen.github.io/scroll3d/assets/replicad_single-*.wasm`) before
relying on STEP export being fast for users on slower connections. If it's
served uncompressed, options include a smaller/custom OCCT build, or
pre-compressing the asset and decompressing it client-side.
