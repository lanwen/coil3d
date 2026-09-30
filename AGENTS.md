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

If several agents or checkouts run at once, give each its own `E2E_PORT` and
dev port.

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

## CI and merging

- GitHub CI is off by default: it doesn't run on PRs or on pushes to `main`.
  It only runs on manual dispatch or on PRs labelled `run-ci`. Don't add
  that label or dispatch CI unless the maintainer asks.
- The merge gate is the full local suite on the final head, rebased onto
  `origin/main`: `npx tsc -b`, `npm test`, `E2E_PORT=<port> npx playwright test --workers=2`.
  Put the counts in the PR body.
- Before opening or updating a PR, rebase onto the latest `origin/main` and
  verify with `git merge-base --is-ancestor origin/main HEAD`.
- Squash-merge. Delete a PR's branch only after GitHub reports the PR as
  `MERGED`, because deleting the head branch of an open PR closes it.
- GitHub Pages deploy (`.github/workflows/pages.yml`) is manual only and
  gated behind the `PAGES_ENABLED` repository variable.

## Pull requests

- One issue per branch: `issue-<N>-<slug>`, created from the latest `origin/main`.
- Body sections: Summary; `Closes #<N>`; acceptance criteria (ticked, or
  explained); test evidence (counts); screenshots; manual checks still
  needed; known issues.
- Anything visible needs before/after screenshots, and you must look at them
  yourself before publishing. Attach them with gh's `--attach` flag (needs
  gh ≥ 2.99): reference `![desc](./shots/x.png)` in the body file and pass
  `--attach ./shots/x.png` for each file. Old PRs embed images from
  `assets/issue-*` branches; keep those branches, but don't create new ones.

## Process hygiene

- Never kill processes you didn't start, and use no `pkill` patterns. Kill
  by PID only.
- Don't commit `spikes/`, `sbxenv.yaml`, `node_modules`, build output or test
  artifacts.
