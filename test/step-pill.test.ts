import { describe, expect, it } from "vitest";
import { design, exportDesign } from "../src/core";
import type { CoilSpec } from "../src/core";
import { STEP_TIMEOUT_MS, perPartVolumeErrors, reimportStep, strapProbes } from "./support/step";

// Issue #320: the pill's STEP sketch (two arcs and two lines) must agree with the mesh backend's outline.
describe.sequential("STEP/OCCT export: a pill core (issue #320)", () => {
  const pillSpec: CoilSpec = {
    wire: { length: 3000, diameter: 3.8, type: "usb" },
    shape: { kind: "pill", cornerRadius: 15 },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 100 },
    height: { locked: true, value: 30 }, // low for time: the wall's STEP build grows with its turns, and the joint sits at the top
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

  it(
    "re-imports a two-part pill with strap slots as one solid per part, each volume matching its mesh, the slots through-holes",
    async () => {
      const d = await design({ ...pillSpec, strapSlots: true });
      expect(d.wallSpec.outline.n).toBe(2);
      expect(d.strapSlots.base).toHaveLength(2);
      expect(d.strapSlots.cap).toHaveLength(2);
      const probes = strapProbes(d);
      const stepBytes = await exportDesign(d, "step");
      const { valid, solidVolumes, inside } = await reimportStep(stepBytes, "reimport-pill-strap", probes.points);
      expect(valid).toBe(true);
      expect(solidVolumes.length).toBe(2);
      for (const [i, err] of perPartVolumeErrors(solidVolumes, d.parts).entries()) expect(err, d.parts[i].name).toBeLessThan(0.005);
      expect(inside).toEqual(probes.expected);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "re-imports a single-part pill with face channels (cap off) as one solid matching its mesh",
    async () => {
      const d = await design({ ...pillSpec, topCap: "off", base: "off", height: { locked: true, value: 40 }, layers: { locked: true, value: 1 } });
      expect(d.faceChannels).toBeDefined();
      const stepBytes = await exportDesign(d, "step");
      const { valid, solidVolumes } = await reimportStep(stepBytes, "reimport-pill-bare");
      expect(valid).toBe(true);
      expect(solidVolumes.length).toBe(1);
      for (const [i, err] of perPartVolumeErrors(solidVolumes, d.parts).entries()) expect(err, d.parts[i].name).toBeLessThan(0.005);
    },
    STEP_TIMEOUT_MS,
  );
});
