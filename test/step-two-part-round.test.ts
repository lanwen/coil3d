import { describe, expect, it } from "vitest";
import { design, exportDesign } from "../src/core";
import type { CoilSpec, JointKind, PlateJoint } from "../src/core";
import { BAYONET_LUG_COUNT } from "../src/core/constants";
import { jointGeometry } from "../src/core/joints";
import { STEP_TIMEOUT_MS, meshVolume, perPartVolumeErrors, reimportStep, snapProbes, stepContains } from "./support/step";

// Split from test/step.test.ts (test-audit report, S1): the round-core
// two-part designs (core + top-cap, or core + mount-plate), kept in their
// own file/OCCT worker -- see test/support/step.ts's top comment and
// test/step-single-part.test.ts's for why splitting by file is safe.
describe.sequential("STEP/OCCT export: round two-part designs (issue #32)", () => {
  describe("exportDesign for a two-part design (issue #9)", () => {
    const JOINTS: JointKind[] = ["press", "bayonet", "snap"];
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

    it.each(JOINTS)(
      "STEP export produces one file with one solid per part, each volume within 0.5% of its own mesh (joint=%s)",
      async (joint) => {
        const d = await design({ ...twoPartSpec, joint });
        const stepBytes = await exportDesign(d, "step");
        expect(stepBytes.byteLength).toBeGreaterThan(0);

        const probes = joint === "snap" ? snapProbes(d) : { points: [], expected: [] };
        const { valid, solidVolumes, inside } = await reimportStep(stepBytes, `reimport-cap-${joint}`, probes.points);
        expect(valid).toBe(true);
        expect(solidVolumes.length).toBe(2); // core + top-cap, per the ticket "one solid per part"

        // Issue #167: per part, within 0.5% -- not the whole design's total.
        for (const [i, err] of perPartVolumeErrors(solidVolumes, d.parts).entries()) expect(err, d.parts[i].name).toBeLessThan(0.005);
        if (joint === "snap") expect(probes.points.length).toBeGreaterThanOrEqual(8);
        expect(inside).toEqual(probes.expected);
      },
      STEP_TIMEOUT_MS,
    );

    // Issue #167: volumes alone can't tell a lug from a lump, so probe the
    // STEP solids where the mesh has its lugs and L-slots.
    it(
      "the STEP bayonet has its lugs and L-slots where the mesh has them (issue #167)",
      async () => {
        const d = await design({ ...twoPartSpec, joint: "bayonet" });
        const h = d.solution.height;
        const rIn = d.wallSpec.boreOutline.apothem;
        const rc = jointGeometry(d.wallSpec.boreOutline, "bayonet", d.spec.tolerance).collarRadius;
        const at = (r: number, deg: number, z: number): [number, number, number] => [r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180), z];
        const twist = 180 / BAYONET_LUG_COUNT;
        const probes: Array<{ p: [number, number, number]; inside: boolean; what: string }> = [];
        for (let k = 0; k < BAYONET_LUG_COUNT; k++) {
          const lug = (360 * k) / BAYONET_LUG_COUNT;
          probes.push(
            { p: at(rIn - 1, lug, h - 2), inside: true, what: `lug ${k}` },
            { p: at(rIn - 1, lug + twist, h - 2), inside: false, what: `bore between lugs ${k}` },
            { p: at(rc - 0.5, lug - twist, h - 6), inside: false, what: `entry slot ${k}` },
            { p: at(rc - 0.5, lug, h - 6), inside: true, what: `collar under the lug ${k}` },
            { p: at(rc - 0.5, lug - twist / 2, h - 1.5), inside: false, what: `groove ${k}` },
            { p: at(rc - 0.5, lug + 30, h - 1.5), inside: true, what: `collar past the stop ${k}` },
          );
        }
        const inside = await stepContains(await exportDesign(d, "step"), "bayonet-probes", probes.map((q) => q.p));
        expect(Object.fromEntries(probes.map((q, i) => [q.what, inside[i]]))).toEqual(Object.fromEntries(probes.map((q) => [q.what, q.inside])));
      },
      STEP_TIMEOUT_MS,
    );
  });

  describe("top cap label (issue #12)", () => {
    // Mirrors test/label.test.ts's own ROOMY_CAP: 6 layers of wound wire on
    // a small 30mm core pushes the flange -- and so the top cap's own
    // annulus between bore and rim -- well past the core's own outline,
    // leaving plenty of room for a short label at a legible height.
    const roomySpec: CoilSpec = {
      wire: { length: 6000, diameter: 3.8, type: "usb" },
      shape: { kind: "round" },
      windingQuality: 0.7,
      coreSize: { locked: true, dimension: "outer", value: 30 },
      height: { locked: true, value: 60 },
      layers: { locked: true, value: 6 },
      objective: "minVolume",
      topCap: "on",
      joint: "press",
      tolerance: 0.2,
      print: { bedX: 256, bedY: 256, bedZ: 256 },
      label: "USB-C 2m",
      mount: "none",
      plateJoint: "glue",
    };

    it(
      "STEP export includes the same engraved label: one solid per part, volume matching the mesh",
      async () => {
        const d = await design(roomySpec);
        const stepBytes = await exportDesign(d, "step");
        expect(stepBytes.byteLength).toBeGreaterThan(0);

        const { valid, solidVolumes } = await reimportStep(stepBytes, "reimport-label");
        expect(valid).toBe(true);
        expect(solidVolumes.length).toBe(2); // core + top-cap, same as issue #9's own STEP test

        // The engraved label is a real, non-trivial volume difference
        // (test/label.test.ts already proves the mesh backend removes
        // material) -- checking it here too would just re-run that same
        // fit; the interesting NEW claim for STEP is that its own
        // independently-built label cutter (step/build.ts's
        // `buildLabelCutterSolid`) agrees with the mesh backend's volume
        // within the same tolerance every other part/joint combination here
        // is held to.
        const totalVolume = solidVolumes.reduce((sum, v) => sum + v, 0);
        const expectedVolume = d.parts.reduce((sum, p) => sum + meshVolume(p.mesh), 0);
        expect(Math.abs(totalVolume - expectedVolume) / expectedVolume).toBeLessThan(0.02);
      },
      STEP_TIMEOUT_MS,
    );
  });

  describe("clip mount plate (issue #14)", () => {
    const plateSpec: CoilSpec = {
      wire: { length: 2000, diameter: 3.8, type: "usb" },
      shape: { kind: "round" },
      windingQuality: 0.7,
      coreSize: { locked: true, dimension: "outer", value: 100 },
      height: { locked: true, value: 60 },
      layers: { locked: true, value: 1 },
      objective: "minVolume",
      topCap: "auto",
      joint: "press",
      tolerance: 0.2,
      print: { bedX: 256, bedY: 256, bedZ: 256 },
      mount: "skadis",
      plateJoint: "glue",
    };

    // Test-audit report S2 (optional): folded "also validates for the snap
    // plate joint" into this it.each over plateJoint. The pre-fold version
    // of the snap case only asserted `byteLength > 0`; it now gets the same
    // independent re-import + volume check as glue.
    const PLATE_JOINTS: PlateJoint[] = ["glue", "snap"];
    it.each(PLATE_JOINTS)(
      "STEP export produces one file with one solid per part (core + mount-plate + pegs), each volume matching its own mesh (plateJoint=%s)",
      async (plateJoint) => {
        const d = await design({ ...plateSpec, plateJoint });
        expect(d.parts.map((p) => p.role)).toContain("mountPlate");

        const stepBytes = await exportDesign(d, "step");
        expect(stepBytes.byteLength).toBeGreaterThan(0);

        const { valid, solidVolumes } = await reimportStep(stepBytes, `reimport-mount-plate-${plateJoint}`);
        expect(valid).toBe(true);
        expect(solidVolumes.length).toBe(4); // core + mount-plate + 2 pegs (issue #132)

        const totalVolume = solidVolumes.reduce((sum, v) => sum + v, 0);
        const expectedVolume = d.parts.reduce((sum, p) => sum + meshVolume(p.mesh), 0);
        expect(Math.abs(totalVolume - expectedVolume) / expectedVolume).toBeLessThan(0.02);
      },
      STEP_TIMEOUT_MS,
    );
  });
});
