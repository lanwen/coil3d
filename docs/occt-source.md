# Corresponding source for the OCCT WebAssembly

The STEP export loads `replicad_single-*.wasm` (about 23 MB), a WebAssembly
build of Open CASCADE Technology (OCCT). OCCT is licensed under the LGPL-2.1
with the Open CASCADE exception. The LGPL requires us to offer the
corresponding source of that binary. The notices shipped with the site
(`public/THIRD_PARTY_NOTICES.txt`) carry the license texts and these
pointers.

## What the binary is built from

The file comes from the npm package `replicad-opencascadejs` 1.1.0
(`gitHead` e4b05f67dc4e2393a876ce8c5064a9c93db05bf1 in its `package.json`).

| Part | Source |
|---|---|
| OCCT 8.0.1 | https://github.com/Open-Cascade-SAS/OCCT, tag `V8_0_1`, commit `b8f597c677811d1f9f4d8a97f5ae2825c0353a42` |
| OCCT to WebAssembly build system, bindings, patches | https://github.com/taucad/opencascade.js, commit `ebd263f15337b440b391492af073662707e86482` (pins OCCT, Emscripten 5.0.1 in `DEPS.json`) |
| Build configuration (bound classes, link flags) | https://github.com/sgenoud/replicad, `packages/replicad-opencascadejs` at the `gitHead` above |
| Build image | `ghcr.io/taucad/opencascade.js:canary-ebd263f1-single-threaded`, named in that package's `buildSingle` script |

Checks done: the commit hashes and the image tag come from the published
`package.json`, the upstream `DEPS.json` and the GitHub API. The binary says
"Open CASCADE 8.0" in its strings. We did not rebuild the WebAssembly, so we
have not compared our own output with the published file byte for byte.

## Make the tarball

```sh
scripts/occt-source-tarball.sh out/
```

The script downloads the three commits above as GitHub archives and packs them
into `out/occt-source-replicad-opencascadejs-1.1.0.tar.gz` (about 65 MB), with a
`README.txt` and a `.sha256` file. It needs only `bash`, `curl` and `tar`.

## Publish it

The maintainer attaches the tarball to a GitHub release of this repository:

1. Run the script.
2. Create a release tagged `occt-source-replicad-opencascadejs-1.1.0` and
   upload the `.tar.gz` and `.sha256` files as release assets.

`public/THIRD_PARTY_NOTICES.txt` names that tag. Do the same again, with a new
tag, whenever `replicad-opencascadejs` is upgraded. Update the three commits in
the script and in the notices file at the same time.
