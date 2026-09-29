import { describe, expect, it } from "vitest";
import { design, exportDesign } from "../src/core";
import type { CoilSpec } from "../src/core";
import { STEP_TIMEOUT_MS, meshVolume, reimportStep } from "./support/step";

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

      const { valid, solidVolumes } = await reimportStep(stepBytes, "reimport-cap-snap-tri");
      expect(valid).toBe(true);
      expect(solidVolumes.length).toBe(2); // core + top-cap; a disconnected collar would re-import as a 3rd solid

      const totalVolume = solidVolumes.reduce((sum, v) => sum + v, 0);
      const expectedVolume = d.parts.reduce((sum, p) => sum + meshVolume(p.mesh), 0);
      expect(Math.abs(totalVolume - expectedVolume) / expectedVolume).toBeLessThan(0.02);
    },
    STEP_TIMEOUT_MS,
  );
});
