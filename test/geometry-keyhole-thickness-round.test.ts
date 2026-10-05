import { describeKeyholeThicknessSweep } from "./support/keyholeThickness";

// Split from test/geometry.test.ts (test-audit report, S1): about 30s of
// that file's 32s summed time was this #41 sweep, so it moved to its own
// file(s)/worker(s), split by shape (round here, sq/tri in
// test/geometry-keyhole-thickness-angular.test.ts) rather than by slot
// count, since round alone already covers both the two-slot and
// single-slot cases the fix must hold for. See test/support/keyholeThickness.ts
// for the shared issue #41 rationale and the sweep itself.
describeKeyholeThicknessSweep([
  // >=90mm flange diameter: mount.ts's layoutKeyholeMount lays out TWO
  // slots (the original issue's own repro shape/size).
  { label: "round, two-slot", shape: { kind: "round" }, coreSize: 100 },
  // A smaller flange lays out only ONE slot -- the fix must hold for both
  // slot counts, not just the two-slot case the issue happened to repro.
  { label: "round, single-slot", shape: { kind: "round" }, coreSize: 40 },
]);
