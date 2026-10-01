import { describe, expect, it } from "vitest";
import { design, exportDesign } from "../src/core";
import type { CoilSpec } from "../src/core";
import { STEP_TIMEOUT_MS, perPartVolumeErrors, reimportStep, snapProbes } from "./support/step";

// Split from test/step.test.ts (test-audit report, S1): the "snap" joint
// case of the tri two-part (issue #55) sweep, on its own so the balanced
// file split doesn't leave one file dominating the others' wall time -- see
// test/step-two-part-tri-1.test.ts (press/bayonet) for the shared rationale.
describe.sequential("STEP/OCCT export: tri two-part design, snap joint (issue #32, #55)", () => {
  const twoPartSpec: CoilSpec = {
    wire: { length: 6000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 60 },
    height: { locked: true, value: 60 },
    layers: { locked: true, value: 2 },
    objective: "minVolume",
    topCap: "auto",
    joint: "press",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    mount: "none",
    plateJoint: "glue",
  };

  const shape: CoilSpec["shape"] = { kind: "tri", cornerRadius: 12 }; // the repro's own shape/corner radius (issue #55)
  const size = 113;

  it(
    "STEP export re-imports a non-round two-part design as one solid per part (issue #55, joint=snap, shape=tri)",
    async () => {
      const d = await design({ ...twoPartSpec, shape, joint: "snap", coreSize: { locked: true, dimension: "outer", value: size } });
      const stepBytes = await exportDesign(d, "step");
      expect(stepBytes.byteLength).toBeGreaterThan(0);

      const probes = snapProbes(d);
      const { valid, solidVolumes, inside } = await reimportStep(stepBytes, "reimport-cap-snap-tri", probes.points);
      expect(valid).toBe(true);
      expect(solidVolumes.length).toBe(2); // core + top-cap; a disconnected collar would re-import as a 3rd solid

      // Issue #167: per part, within 0.5% -- not the whole design's total.
      for (const [i, err] of perPartVolumeErrors(solidVolumes, d.parts).entries()) expect(err, d.parts[i].name).toBeLessThan(0.005);
      expect(probes.points.length).toBeGreaterThanOrEqual(8); // the barb (in, out) and the ridge (in, out), each crossed both ways
      expect(inside).toEqual(probes.expected);
    },
    STEP_TIMEOUT_MS,
  );
});
