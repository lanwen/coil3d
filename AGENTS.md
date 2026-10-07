# AGENTS.md — coil3d

A static, client-side app that designs 3D-printable cable coils. The spec is
issue #1; design notes are in `docs/design.md`, mounts in `docs/mounts.md`,
STEP pitfalls in `docs/step-notes.md`.

## Architecture

- The headless coil core (`src/core`) has exactly this public interface:
  `parseHash`/`toHash`, `design(spec)` and `exportDesign(design, fmt)`. The UI
  and the viewer only use that interface. The core never imports React or three.js.
- Geometry: manifold-3d for the meshes. STEP export uses replicad
  (OpenCascade WASM), lazy-loaded in a worker. The mesh and STEP backends
  must build from the same shared layouts and agree with each other.
- The URL hash is `#s=<base64url JSON>` (`src/core/hash.ts`). New spec fields
  go into the zod doc schema, are left out at their default, and get a
  round-trip test.
- coil3d is in beta: share links aren't guaranteed to survive spec changes, so
  spec changes need no migration code.
- Keep it simple, match the surrounding code, and add no speculative abstractions.

## Code style

- No comments in `src/`. If code seems to need one, change the code so its
  intent is obvious: better names, small functions, named constants, types.
  Design rationale that code can't express (print physics, PLA limits, why a
  constant has its value) goes, briefly, into `docs/design.md`.
- Only tool directives are allowed: `// @ts-expect-error <reason>`,
  `/// <reference ...>`, `/* @vite-ignore */`, `/*#__PURE__*/`. `@ts-ignore` is not.
- `test/` and `e2e/` may keep short comments explaining why a fixture or
  threshold exists.
- `scripts/check-no-comments.mjs` enforces this and runs in `pnpm build`.
  `scripts/comment-allowlist.txt` lists the files that still have comments. It
  is temporary and only shrinks: when you edit a function in a listed file,
  remove its comments, and delete a file from the list once it has none (the
  checker fails on a listed file with no comments). New files are never listed.

## Commands

```sh
pnpm install
pnpm dev                     # :5182
pnpm build                   # tsc -b + comment check + vite build
pnpm exec tsc -b             # typecheck
pnpm lint:comments           # no comments in src/ (see Code style)
pnpm test                    # vitest: the core's public interface
E2E_PORT=<port> pnpm exec playwright test   # e2e (4 workers); builds and previews on E2E_PORT (default 5182)
```

pnpm's `node_modules` is strict: declare every package you import in
`package.json`. Dependency build scripts stay off; add one to
`pnpm.onlyBuiltDependencies` only when something fails without it (esbuild's
is skipped on purpose: vite works without it).

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
  enabled), then for the viewer's `data-settled="true"` (`expectSettled` in
  `e2e/settled.ts`), and again after any action that redraws it. Fixed sleeps
  race the draft→final swap and the frames that follow it.
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
  (https://coil3d.lanwen.dev), which runs `pnpm build` and serves `dist/`.
  A merge ships to production, so the merge gate matters.
- The merge gate is the full local suite on the final head, rebased onto
  `origin/main`: `pnpm exec tsc -b`, `pnpm test`, `E2E_PORT=<port> pnpm exec playwright test`.
  Put the counts in the PR's evidence comment (see "Pull requests").
- Before opening or updating a PR, rebase onto the latest `origin/main` and
  verify with `git merge-base --is-ancestor origin/main HEAD`.
- Squash-merge. Delete a PR's branch only after GitHub reports the PR as
  `MERGED`, because deleting the head branch of an open PR closes it.

## Pull requests

- One issue per branch: `issue-<N>-<slug>`, created from the latest `origin/main`.
- The body is short and written for a reviewer: a links header (`Closes #<N>`,
  or `Refs #<N>` for one part of a multi-PR issue); **Why the change** in one
  sentence; **Special things to note** in 1-3 bullets (`None.` if empty); a
  compact **Change outline** (diff blocks, a shallow file tree, or a data or
  call flow, whichever explains the change best).
- Right after opening the PR, post an evidence comment
  (`gh pr comment <N> --body-file <file> --attach ./shots/x.png`): test counts
  per suite, before/after screenshots for anything visible, changed baselines,
  manual and real-print checks still needed, known issues.
- Look at every screenshot yourself before attaching it. Keep screenshot files
  out of the commit.
- Commits, PR text and comments carry no AI-tool attribution.

## Process hygiene

- Never kill processes you didn't start, and use no `pkill` patterns. Kill
  by PID only.
- Don't commit `node_modules`, build output or test artifacts.
