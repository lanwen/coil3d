import { describe, expect, it } from "vitest";
import { design, exportDesign } from "../src/core";
import type { CoilSpec, JointKind } from "../src/core";
import { STEP_TIMEOUT_MS, perPartVolumeErrors, reimportStep, strapProbes } from "./support/step";

// Split from test/step.test.ts (test-audit report, S1): the tri-shape,
// two-part (issue #55) STEP re-import cases are the file's own slowest
// tests (each builds a full OCCT collar for a non-round two-part design),
// so they're spread one-or-two-per-file rather than kept together, to keep
// each split file's wall time balanced. This file takes the "press" and
// "bayonet" joints; test/step-two-part-tri-2.test.ts takes "snap" alone.
describe.sequential("STEP/OCCT export: tri two-part designs, press/bayonet (issue #32, #55)", () => {
  const twoPartSpec: CoilSpec = {
    wire: { length: 6000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 60 },
    height: { locked: true, value: 30 }, // not 60: the wall's STEP build time grows with its turns, and the joint sits at the top, so a short core proves the same (issue #181)
    layers: { locked: true, value: 2 },
    objective: "minVolume",
    topCap: "on",
    base: "on",
    joint: "press",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    mount: "none",
    plateJoint: "glue",
  };

  // Issue #55: the mesh backend's repro (`shape=tri&tri.rc=12&size=113&cap=on`)
  // was a disconnected joint collar that `status()`/volume checks never
  // caught; this file's own `validateSolid` (build.ts) already asserts
  // `solid.solids.length === 1` per part, but no existing STEP test ever
  // combined a non-round shape with a two-part (topCap-enabled) design, so
  // it never actually ran against the bug. Covers the repro's own shape
  // (tri) across all three joints, re-importing to confirm the STEP file
  // itself -- not just `exportDesign`'s own internal validation -- sees
  // one solid per part. sq is deliberately NOT repeated here: the STEP
  // collar (`collarBaseSolid`/`outlineLoftSolid`, step/build.ts) is
  // shape-agnostic beyond `n`/`cornerRadius`, and sq's own STEP re-import
  // + the full sq/tri x press/bayonet/snap sweep already run in
  // test/topCap.test.ts's mesh backend (manifold-3d, no OCCT).
  const shape: CoilSpec["shape"] = { kind: "tri", cornerRadius: 12 }; // the repro's own shape/corner radius
  const size = 113;
  const JOINTS: JointKind[] = ["press", "bayonet"];

  it.each(JOINTS)(
    "STEP export re-imports a non-round two-part design as one solid per part (issue #55, joint=%s, shape=tri)",
    async (joint) => {
      const d = await design({ ...twoPartSpec, shape, joint, coreSize: { locked: true, dimension: "outer", value: size } });
      const stepBytes = await exportDesign(d, "step");
      expect(stepBytes.byteLength).toBeGreaterThan(0);

      const { valid, solidVolumes } = await reimportStep(stepBytes, `reimport-cap-${joint}-tri`);
      expect(valid).toBe(true);
      expect(solidVolumes.length).toBe(2); // core + top-cap; a disconnected collar would re-import as a 3rd solid

      // Issue #167: per part, within 0.5% -- not the whole design's total.
      for (const [i, err] of perPartVolumeErrors(solidVolumes, d.parts).entries()) expect(err, d.parts[i].name).toBeLessThan(0.005);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "STEP export re-imports a triangle base and cap with strap slots (issues #240, #314): one solid per part, each volume matching its mesh, the slots through-holes",
    async () => {
      const d = await design({ ...twoPartSpec, shape, strapSlots: true, coreSize: { locked: false } });
      expect(d.strapSlots.base).toHaveLength(2);
      expect(d.strapSlots.cap).toHaveLength(2);
      const probes = strapProbes(d);
      const stepBytes = await exportDesign(d, "step");
      const { valid, solidVolumes, inside } = await reimportStep(stepBytes, "reimport-strap-tri", probes.points);
      expect(valid).toBe(true);
      expect(solidVolumes.length).toBe(2);
      for (const [i, err] of perPartVolumeErrors(solidVolumes, d.parts).entries()) expect(err, d.parts[i].name).toBeLessThan(0.005);
      expect(inside).toEqual(probes.expected);
    },
    STEP_TIMEOUT_MS,
  );
});
