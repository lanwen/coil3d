# AGENTS.md — coil3d

A static, client-side app that designs 3D-printable cable coils. The spec is
issue #1; background, decisions and research are in `docs/research.md`.

## Architecture

- The headless coil core (`src/core`) has exactly this public interface:
  `parseHash`/`toHash`, `design(spec)` and `exportDesign(design, fmt)`. The UI
  and the viewer only use that interface. The core never imports React or three.js.
- Geometry: manifold-3d for the meshes. STEP export uses replicad
  (OpenCascade WASM), lazy-loaded in a worker. The mesh and STEP backends
  must build from the same shared layouts and agree with each other.
- The URL hash is `#s=<base64url JSON>` (`src/core/hash.ts`). New spec fields
  go into the zod doc schema, are left out at their default, and get a
  round-trip test. The legacy `#v=1&…` form still parses.
- Keep it simple, match the surrounding code, and add no speculative abstractions.

## Commands

```sh
npm install
npm run dev                  # :5182
npm run build                # tsc -b + vite build
npx tsc -b                   # typecheck
npm test                     # vitest: the core's public interface
E2E_PORT=<port> npx playwright test --workers=2   # e2e; builds and previews on E2E_PORT (default 5182)
```

Use a free `E2E_PORT` when another dev server or test run is already using
the default. If Playwright's own Chromium isn't available, point
`PLAYWRIGHT_CHROMIUM_PATH` at another Chromium executable.

## Tests

- There are two seams only: vitest on the core's public interface (Node),
  and Playwright end to end (URL hash → UI, screenshots, downloads). Don't
  unit-test internals.
- A regression test must fail on the pre-fix code for the intended reason.
  Check this before claiming the fix.
- Screenshot and e2e tests wait for the FINAL mesh (`download-stl` becomes
  enabled). Fixed sleeps race the draft→final swap.
- Use Playwright `reducedMotion: 'reduce'`, except in tests of animations.
- Update screenshot baselines only after looking at the actual/expected diff.

## Geometry and rendering rules

- Every part is one connected solid (`decompose().length === 1`) and prints
  flat on the bed without supports: overhangs at most 45°, no large bridges.
- The cable never bends tighter than its minimum bend radius
  (`test/cableBend.test.ts`).
- The solver never reports "ok" when capacity < the target length.
- The viewer is IKEA-style line art (screen-space normal+depth edges,
  `src/viewer`). New visible geometry must render cleanly: check screenshots
  for missing silhouettes, blobs and dashed lines.

## CI, merging and deploy

- GitHub CI is manual-only: it doesn't run on pushes to `main`, and runs on
  a PR only when it is labelled `run-ci` (or on manual dispatch).
- Every push to `main` deploys to Cloudflare Pages
  (https://coil3d.lanwen.dev), which runs `npm run build` and serves `dist/`.
  A merge ships to production, so the merge gate matters.
- The merge gate is the full local suite on the final head, rebased onto
  `origin/main`: `npx tsc -b`, `npm test`, `E2E_PORT=<port> npx playwright test --workers=2`.
  Put the counts in the PR body.
- Before opening or updating a PR, rebase onto the latest `origin/main` and
  verify with `git merge-base --is-ancestor origin/main HEAD`.
- Squash-merge. Delete a PR's branch only after GitHub reports the PR as
  `MERGED`, because deleting the head branch of an open PR closes it.

## Pull requests

- One issue per branch: `issue-<N>-<slug>`, created from the latest `origin/main`.
- Body sections: Summary; `Closes #<N>`; acceptance criteria (ticked, or
  explained); test evidence (counts); screenshots; manual checks still
  needed; known issues.
- Anything visible needs before/after screenshots, and you must look at them
  yourself before publishing. Attach them to the PR (drag them into the body,
  or use `gh pr create --attach` with `![desc](./shots/x.png)` references).
  Keep screenshot files out of the commit.

## Process hygiene

- Never kill processes you didn't start, and use no `pkill` patterns. Kill
  by PID only.
- Don't commit `node_modules`, build output or test artifacts.
