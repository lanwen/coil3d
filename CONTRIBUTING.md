# Contributing to coil3d

Thanks for helping. This file covers the practical steps. The project rules
(architecture, code style, tests, geometry and rendering, the merge gate) are in
[AGENTS.md](AGENTS.md).

## Prerequisites

- Node.js 22 and pnpm 10 (`corepack enable` picks the version pinned in `package.json`).
- A Chromium for the end-to-end tests: `pnpm exec playwright install chromium`.
  To use a different Chromium executable, set `PLAYWRIGHT_CHROMIUM_PATH`.

## Setup and dev server

```sh
pnpm install
pnpm dev        # http://localhost:5182
```

## Tests

The merge gate and the rules for tests are in [AGENTS.md](AGENTS.md). If an e2e
or STEP test times out on a busy machine, re-run it alone with `--workers=1`
before you treat it as a regression.

## Mesh fuzz test

`test/meshFuzz.test.ts` builds random designs from a fixed seed (shapes,
joints, mounts, fractional sizes, heights and cables, and other collar facet
counts) and checks every part: it must be one connected solid, with no edge
under the weld's limit and no zero-thickness fold (two triangles on an edge
whose normals are within 8 degrees of opposite, so the surface doubles back
on itself). `pnpm test` runs a small sample. After a change under `src/core`
outside `src/core/step`, run the long mode as well:

```sh
COIL3D_FUZZ=3000 pnpm exec vitest run test/meshFuzz.test.ts
```

`COIL3D_FUZZ` is the number of cases. `COIL3D_FUZZ_FROM` is the first case's
index (default 0), so you can split a long run over several processes or rerun
one failing case: `COIL3D_FUZZ=1 COIL3D_FUZZ_FROM=<index>`. The run takes
about 2 minutes per 1000 cases on one core.

## Pull requests

Follow [docs/pull-requests.md](docs/pull-requests.md).
