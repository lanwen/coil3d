# Contributing to coil3d

Thanks for helping. This file covers the practical steps. The project rules
(architecture, tests, geometry and rendering) are in [AGENTS.md](AGENTS.md).

## Prerequisites

- Node.js 22 and npm.
- A Chromium for the end-to-end tests: `npx playwright install chromium`.
  To use a different Chromium executable, set `PLAYWRIGHT_CHROMIUM_PATH`.

## Setup and dev server

```sh
npm install
npm run dev        # http://localhost:5182
```

## The merge gate

Run the full suite locally on your final commit:

```sh
npx tsc -b
npm test
E2E_PORT=5182 npx playwright test --workers=2
```

The e2e run builds the app and previews it on `E2E_PORT` (default 5182), so
pick a free port if the dev server is already running. If an e2e or STEP test
times out on a busy machine, re-run it alone with `--workers=1` before
treating it as a regression.

## Branches and pull requests

- Branch from the latest `origin/main`. Name the branch `issue-<N>-<slug>`.
- Rebase onto the latest `origin/main` before you open or update a PR, and
  check it with `git merge-base --is-ancestor origin/main HEAD`.
- In the PR body, link the issue (`Closes #<N>`), tick the acceptance
  criteria, and put the test counts from the merge gate.
- Visible changes need before/after screenshots. Look at them yourself first.
- Add a test with each fix, and make sure it fails without the fix.
- PRs are squash-merged.

## CI and deploy

GitHub CI is manual-only. It runs on manual dispatch, or on a PR that carries
the `run-ci` label. It does not run on pushes to `main`.

Every push to `main` deploys to Cloudflare Pages, which runs `npm run build`
and serves `dist/`. A merge goes live, so the local merge gate is the check
that counts.
