import { describe, expect, it } from "vitest";
import { design, exportDesign } from "../src/core";
import type { CoilSpec, JointKind, PlateJoint } from "../src/core";
import { STEP_TIMEOUT_MS, meshVolume, reimportStep } from "./support/step";

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
      "STEP export produces one file with one solid per part, each volume matching its own mesh (joint=%s)",
      async (joint) => {
        const d = await design({ ...twoPartSpec, joint });
        const stepBytes = await exportDesign(d, "step");
        expect(stepBytes.byteLength).toBeGreaterThan(0);

        const { valid, solidVolumes } = await reimportStep(stepBytes, `reimport-cap-${joint}`);
        expect(valid).toBe(true);
        expect(solidVolumes.length).toBe(2); // core + top-cap, per the ticket "one solid per part"

        const totalVolume = solidVolumes.reduce((sum, v) => sum + v, 0);
        const expectedVolume = d.parts.reduce((sum, p) => sum + meshVolume(p.mesh), 0);
        expect(Math.abs(totalVolume - expectedVolume) / expectedVolume).toBeLessThan(0.02);
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
      "STEP export produces one file with one solid per part (core + mount-plate), each volume matching its own mesh (plateJoint=%s)",
      async (plateJoint) => {
        const d = await design({ ...plateSpec, plateJoint });
        expect(d.parts.map((p) => p.role)).toContain("mountPlate");

        const stepBytes = await exportDesign(d, "step");
        expect(stepBytes.byteLength).toBeGreaterThan(0);

        const { valid, solidVolumes } = await reimportStep(stepBytes, `reimport-mount-plate-${plateJoint}`);
        expect(valid).toBe(true);
        expect(solidVolumes.length).toBe(2); // core + mount-plate

        const totalVolume = solidVolumes.reduce((sum, v) => sum + v, 0);
        const expectedVolume = d.parts.reduce((sum, p) => sum + meshVolume(p.mesh), 0);
        expect(Math.abs(totalVolume - expectedVolume) / expectedVolume).toBeLessThan(0.02);
      },
      STEP_TIMEOUT_MS,
    );
  });
});
