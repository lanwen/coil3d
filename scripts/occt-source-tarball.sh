#!/usr/bin/env bash
# Builds the LGPL-2.1 "corresponding source" tarball for the Open CASCADE
# Technology (OCCT) WebAssembly that the STEP export ships
# (replicad-opencascadejs 1.1.0). See docs/occt-source.md.
#
#   scripts/occt-source-tarball.sh [output-dir]
#
# Needs only bash, curl, tar and sha256sum (or shasum). The three commits below
# are the ones the published npm package was built from; change them together
# with public/THIRD_PARTY_NOTICES.txt whenever replicad-opencascadejs is bumped.
set -euo pipefail

VERSION=1.1.0
OCCT_COMMIT=b8f597c677811d1f9f4d8a97f5ae2825c0353a42       # Open-Cascade-SAS/OCCT, tag V8_0_1
OCJS_COMMIT=ebd263f15337b440b391492af073662707e86482       # taucad/opencascade.js (build system, patches)
REPLICAD_COMMIT=e4b05f67dc4e2393a876ce8c5064a9c93db05bf1   # sgenoud/replicad (packages/replicad-opencascadejs)

out="$(cd "${1:-.}" && pwd)"
name="occt-source-replicad-opencascadejs-$VERSION"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/$name"

fetch() { # <owner/repo> <commit> <dir>
  mkdir -p "$work/$name/$3"
  curl -fsSL "https://github.com/$1/archive/$2.tar.gz" | tar -xz --strip-components=1 -C "$work/$name/$3"
}
fetch Open-Cascade-SAS/OCCT "$OCCT_COMMIT" OCCT
fetch taucad/opencascade.js "$OCJS_COMMIT" opencascade.js
fetch sgenoud/replicad "$REPLICAD_COMMIT" replicad

cat > "$work/$name/README.txt" <<TXT
Corresponding source for the Open CASCADE Technology WebAssembly shipped in
replicad-opencascadejs $VERSION (LGPL-2.1 with the Open CASCADE exception).

OCCT/             https://github.com/Open-Cascade-SAS/OCCT @ $OCCT_COMMIT (tag V8_0_1)
opencascade.js/   https://github.com/taucad/opencascade.js @ $OCJS_COMMIT
                  (OCCT to WebAssembly build system and patches; Docker image
                  ghcr.io/taucad/opencascade.js:canary-ebd263f1-single-threaded)
replicad/         https://github.com/sgenoud/replicad @ $REPLICAD_COMMIT
                  (packages/replicad-opencascadejs holds the build configuration)

To rebuild, follow packages/replicad-opencascadejs/README.md in replicad/ and
BUILD_SYSTEM.md in opencascade.js/.
TXT

tar -czf "$out/$name.tar.gz" -C "$work" "$name"
( cd "$out" && { sha256sum "$name.tar.gz" 2>/dev/null || shasum -a 256 "$name.tar.gz"; } | tee "$name.tar.gz.sha256" )
