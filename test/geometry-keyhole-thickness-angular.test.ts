import { describeKeyholeThicknessSweep } from "./support/keyholeThickness";

// Split from test/geometry.test.ts (test-audit report, S1): the sq/tri
// (both two-slot) cases of the #41 sweep. See test/support/keyholeThickness.ts
// for the shared issue #41 rationale and the sweep itself, and
// test/geometry-keyhole-thickness-round.test.ts for the round cases.
describeKeyholeThicknessSweep([
  // >=90mm flange diameter: mount.ts's layoutKeyholeMount lays out TWO
  // slots (the original issue's own repro shape/size).
  { label: "sq, two-slot", shape: { kind: "sq", cornerRadius: 15 }, coreSize: 100 },
  { label: "tri, two-slot", shape: { kind: "tri", cornerRadius: 15 }, coreSize: 100 },
]);
