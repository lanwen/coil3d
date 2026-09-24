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
