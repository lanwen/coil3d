# AGENTS.md — coil3d

A static, client-side app that designs 3D-printable cable coils.

`docs/design.md` is the source of truth: the decisions and their reasons for
every part, shape, backend, export and the renderer. It is long, so read the
sections for your area (`grep -n '^## ' docs/design.md` lists them) before you
change it. Then, as needed:

- `docs/mounts.md`: before you change a wall mount or a SKÅDIS clip.
- `docs/step-notes.md`: before you change `src/core/step/` (OCCT failure modes already tried).
- `CONTRIBUTING.md`: setup and the long mesh fuzz run.

## Architecture

- The headless core (`src/core`) is reached through `src/core/index.ts`:
  `parseHash`/`toHash`, `design(spec)`, `exportDesign(design, fmt)`, and the
  constants and shape tables it re-exports. Outside `src/core`, import from
  the index (`src/geometry/worker.ts` is the one exception). The core imports
  neither React nor three.js.
- manifold-3d builds the meshes. STEP export uses replicad (OpenCascade WASM),
  lazy-loaded in a worker. Both backends build from the same shared layouts and
  agree with each other (`docs/design.md`, "Backends must agree").
- The URL hash is `#s=<base64url JSON>` (`src/core/hash.ts`). A new spec field
  goes into the zod doc schema, is left out at its default, and gets a
  round-trip test in `test/hash.test.ts`. coil3d is in beta: a spec change
  needs no migration for old share links.
- Build only what the issue needs, in the style of the code around it.

## Code style

- `src/` is comment-free. When code seems to need a comment, make the code say
  it: better names, small functions, named constants, types. Rationale code
  can't carry (print physics, PLA limits, why a constant has its value) goes,
  briefly, into `docs/design.md`. `pnpm lint:comments` checks this and lists
  the allowed tool directives.
- `test/` and `e2e/` may keep short comments on why a fixture or threshold exists.

## Merge gate

Scripts are in `package.json`. A change is done when these pass on the final
head, rebased onto `origin/main` (`git merge-base --is-ancestor origin/main HEAD`):

```sh
pnpm exec tsc -b
pnpm lint:comments
pnpm test
E2E_PORT=<port> pnpm exec playwright test
```

Playwright builds and previews the app, but reuses any server already on
`E2E_PORT` (default 5182, the `pnpm dev` port) and then tests that server
instead. Pick a port nothing listens on.

After a change under `src/core` outside `src/core/step`, also run the mesh fuzz:
`COIL3D_FUZZ=3000 pnpm exec vitest run test/meshFuzz.test.ts`.

pnpm's `node_modules` is strict: declare every package you import. Dependency
build scripts stay off; add one to `pnpm.onlyBuiltDependencies` only when
something fails without it.

## Tests

- The two seams are vitest on the core's public interface (Node; `test/`,
  shared checks in `test/support/`) and Playwright end to end (URL hash → UI,
  screenshots, downloads; helpers in `e2e/*.ts`, e.g. `withHashDoc`,
  `openAdvanced`). Write new tests on them. `test/seams.test.ts` fails when a
  test imports a `src/` module other than the core index (its table lists each
  exception with its reason) or an e2e file imports `src/`.
- A regression test fails on the pre-fix code for the intended reason. Run it
  there before you claim the fix.
- A failing test gets a code fix. A threshold, fixture or timeout changes only
  with a one-line reason next to it.
- Before an e2e check or screenshot, wait for the FINAL mesh (`download-stl`
  enabled), then `expectSettled(page)` (`e2e/settled.ts`); repeat after every
  action that redraws the viewer. Fixed sleeps race the draft→final swap.
- The config reduces motion for every test. A test of an animation opts back in
  with `test.use({ contextOptions: { reducedMotion: "no-preference" } })`.

## Geometry and rendering invariants

Each has an automated check; a new kind of defect you find gets one too.

- Every part is one connected solid (`decompose().length === 1`) and prints flat
  on the bed without supports: overhangs at most 45°, small bridges only
  (`test/printability.test.ts`).
- The cable bends no tighter than its minimum bend radius (`test/cableBend.test.ts`).
- The solver reports "ok" only when capacity ≥ the target length.
- The viewer is IKEA-style line art: screen-space normal+depth edges (`src/viewer`).

## Screenshots

- Look at every screenshot yourself before you use it as evidence.
- New visible geometry renders cleanly: check each view it appears in for
  missing silhouettes, blobs and dashed lines.
- Baselines are in `e2e/*.spec.ts-snapshots/`. Update one
  (`--update-snapshots`) only after you look at its actual/expected diff in
  `test-results/`.

## Commits and pull requests

- Commits, PR text and comments carry no AI-tool attribution.
- Opening or updating a PR: follow `docs/pull-requests.md`.
- Stop only the processes you started, by PID.
