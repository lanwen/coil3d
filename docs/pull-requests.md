# Pull requests

How to open or update a PR. The merge gate and the code rules are in
[AGENTS.md](../AGENTS.md).

Every merge to `main` ships to production (https://coil3d.lanwen.dev), and
GitHub CI runs only on a PR labelled `run-ci`, so the merge gate on your
final head is the check that counts.

## Before you open it

- One issue per branch: `issue-<N>-<slug>`, from the latest `origin/main`.
- Rebase onto the latest `origin/main` before you open or update the PR, and
  check it: `git merge-base --is-ancestor origin/main HEAD`.
- Commits, PR text and comments carry no AI-tool attribution.
- Keep screenshot files (store them under `shots/`) out of the commit. Look at
  each one yourself before you attach it.

## Body

Short, written for a reviewer:

- A links header: `Closes #<N>`, or `Refs #<N>` for one part of a multi-PR issue.
- **Why the change**: one sentence.
- **Special things to note**: 1-3 bullets (`None.` if empty).
- **Change outline**: compact. Diff blocks, a shallow file tree, or a data or
  call flow, whichever explains the change best.

## Evidence comment

Right after opening the PR, post a comment
(`gh pr comment <N> --body-file <file> --attach shots/x.png`) with:

- test counts per suite of the merge gate;
- before/after screenshots for anything visible;
- each changed screenshot baseline;
- manual and real-print checks still needed;
- known issues.

## Merging (maintainers)

- Squash-merge.
- Delete the PR's branch only after GitHub reports the PR as `MERGED`:
  deleting the head branch of an open PR closes it.
