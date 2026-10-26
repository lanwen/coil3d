import { describe, expect, it } from "vitest";
import { BAYONET_LUG_COUNT, design, exportDesign } from "../src/core";
import type { CoilSpec, JointKind } from "../src/core";
import { meshVolume } from "./support/mesh";
import { STEP_TIMEOUT_MS, perPartVolumeErrors, reimportStep, snapProbes, stepContains, strapProbes } from "./support/step";

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
      coreSize: { locked: false },
      height: { locked: true, value: 30 }, // not 60: the wall's STEP build time grows with its turns, and the joint sits at the top (issue #181)
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

    // The OCCT build is the slow part (issue #181), and the bayonet probe test
    // below needs the same bayonet export as this one: build each joint once.
    const built = new Map<JointKind, ReturnType<typeof buildJoint>>();
    async function buildJoint(joint: JointKind) {
      const d = await design({ ...twoPartSpec, joint });
      return { d, stepBytes: await exportDesign(d, "step") };
    }
    const buildOnce = (joint: JointKind) => built.get(joint) ?? built.set(joint, buildJoint(joint)).get(joint)!;

    it.each(JOINTS)(
      "STEP export produces one file with one solid per part, each volume within 0.5% of its own mesh (joint=%s)",
      async (joint) => {
        const { d, stepBytes } = await buildOnce(joint);
        expect(stepBytes.byteLength).toBeGreaterThan(0);

        const probes = joint === "snap" ? snapProbes(d) : { points: [], expected: [] };
        const { valid, solidVolumes, inside } = await reimportStep(stepBytes, `reimport-cap-${joint}`, probes.points);
        expect(valid).toBe(true);
        expect(solidVolumes.length).toBe(2); // core + top-cap, per the ticket "one solid per part"

        // Issue #167: per part, within 0.5% -- not the whole design's total.
        for (const [i, err] of perPartVolumeErrors(solidVolumes, d.parts).entries()) expect(err, d.parts[i].name).toBeLessThan(0.005);
        if (joint === "snap") expect(probes.points.length).toBeGreaterThanOrEqual(14);
        expect(inside).toEqual(probes.expected);
      },
      STEP_TIMEOUT_MS,
    );

    // Issue #167: volumes alone can't tell a lug from a lump, so probe the
    // STEP solids where the mesh has its lugs and L-slots.
    it(
      "the STEP bayonet has its lugs and L-slots where the mesh has them (issue #167)",
      async () => {
        const { d, stepBytes } = await buildOnce("bayonet");
        const h = d.solution.height;
        const rIn = d.wallSpec.boreOutline.apothem;
        expect(d.capJoint?.kind).toBe("bayonet");
        const rc = d.capJoint!.collarRadius;
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
        const inside = await stepContains(stepBytes, "bayonet-probes", probes.map((q) => q.p));
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
        // `applyFaceOpsStep`) agrees with the mesh backend's volume
        // within the same tolerance every other part/joint combination here
        // is held to.
        const totalVolume = solidVolumes.reduce((sum, v) => sum + v, 0);
        const expectedVolume = d.parts.reduce((sum, p) => sum + meshVolume(p.mesh), 0);
        expect(Math.abs(totalVolume - expectedVolume) / expectedVolume).toBeLessThan(0.02);
      },
      STEP_TIMEOUT_MS,
    );
  });

  describe("clip mount plate (issue #14) and SKÅDIS rim clips (issue #207)", () => {
    const plateSpec: CoilSpec = {
      wire: { length: 2000, diameter: 3.8, type: "usb" },
      shape: { kind: "round" },
      windingQuality: 0.7,
      coreSize: { locked: true, dimension: "outer", value: 100 },
      height: { locked: true, value: 60 },
      layers: { locked: true, value: 1 },
      objective: "minVolume",
      topCap: "off",
      base: "on",
      joint: "press",
      tolerance: 0.2,
      print: { bedX: 256, bedY: 256, bedZ: 256 },
      mount: "opengrid",
      plateJoint: "glue",
    };

    it(
      "STEP export produces one file with one solid per part (core + openGrid mount-plate + pegs), each volume matching its own mesh",
      async () => {
        const d = await design(plateSpec);
        expect(d.parts.map((p) => p.role)).toContain("mountPlate");

        const stepBytes = await exportDesign(d, "step");
        expect(stepBytes.byteLength).toBeGreaterThan(0);

        const { valid, solidVolumes } = await reimportStep(stepBytes, "reimport-mount-plate");
        expect(valid).toBe(true);
        expect(solidVolumes.length).toBe(4); // core + mount-plate + 2 pegs (issue #132)

        const totalVolume = solidVolumes.reduce((sum, v) => sum + v, 0);
        const expectedVolume = d.parts.reduce((sum, p) => sum + meshVolume(p.mesh), 0);
        expect(Math.abs(totalVolume - expectedVolume) / expectedVolume).toBeLessThan(0.02);
      },
      STEP_TIMEOUT_MS,
    );

    // Not 60: the OCCT fuse of the wall with the flange dominates these cases and grows with the wall's turns (issue #393); the clips and their layout are the same at 30.
    const tclipSpec: CoilSpec = { ...plateSpec, height: { locked: true, value: 30 } };

    it(
      "STEP export of the SKÅDIS T-clips (issues #213, #221): the core with its bore floor and every clip as its own solid, each volume matching its own mesh",
      async () => {
        const d = await design({ ...tclipSpec, mount: "skadis-tclip" });
        expect(d.parts.filter((p) => p.role === "mountClip").length).toBe(3);
        const stepBytes = await exportDesign(d, "step");
        const { valid, solidVolumes } = await reimportStep(stepBytes, "reimport-skadis-tclips");
        expect(valid).toBe(true);
        expect(solidVolumes.length).toBe(4); // core + 3 T-clips
        for (const [i, err] of perPartVolumeErrors(solidVolumes, d.parts).entries()) expect(err, d.parts[i].name).toBeLessThan(0.005);
      },
      STEP_TIMEOUT_MS,
    );

    it(
      "STEP export of a single SKÅDIS T-clip in a small bore under a cap (issue #221): its fin stops under the collar, each volume matching its own mesh",
      async () => {
        const d = await design({ ...tclipSpec, mount: "skadis-tclip", coreSize: { locked: true, dimension: "outer", value: 40 }, topCap: "on" });
        expect(d.parts.filter((p) => p.role === "mountClip").length).toBe(1);
        const stepBytes = await exportDesign(d, "step");
        const { valid, solidVolumes } = await reimportStep(stepBytes, "reimport-skadis-tclip-one");
        expect(valid).toBe(true);
        expect(solidVolumes.length).toBe(3); // core + cap + 1 T-clip
        for (const [i, err] of perPartVolumeErrors(solidVolumes, d.parts).entries()) expect(err, d.parts[i].name).toBeLessThan(0.005);
      },
      STEP_TIMEOUT_MS,
    );

    it(
      "STEP export of the SKÅDIS rim clips: the notched core and every clip as its own solid, each volume matching its own mesh",
      async () => {
        const d = await design({ ...plateSpec, mount: "skadis" });
        expect(d.parts.filter((p) => p.role === "mountClip").length).toBe(3);

        const stepBytes = await exportDesign(d, "step");
        const { valid, solidVolumes } = await reimportStep(stepBytes, "reimport-skadis-clips");
        expect(valid).toBe(true);
        expect(solidVolumes.length).toBe(4); // core + 3 clips

        // Per part, in order: each solid's volume matches its own mesh.
        for (const [i, err] of perPartVolumeErrors(solidVolumes, d.parts).entries()) expect(err, d.parts[i].name).toBeLessThan(0.005);
      },
      STEP_TIMEOUT_MS,
    );
  });
  describe("strap slots (issues #240, #314)", () => {
    const strapSpec: CoilSpec = {
      wire: { length: 6000, diameter: 3.8, type: "usb" },
      shape: { kind: "round" },
      windingQuality: 0.7,
      coreSize: { locked: false },
      height: { locked: true, value: 30 },
      layers: { locked: true, value: 2 },
      objective: "minVolume",
      topCap: "on",
      base: "on",
      joint: "press",
      tolerance: 0.2,
      print: { bedX: 256, bedY: 256, bedZ: 256 },
      mount: "none",
      plateJoint: "glue",
      strapSlots: true,
    };

    it(
      "a base and cap with strap slots re-import as one valid solid each, matching their meshes, with the slots through-holes in the same place",
      async () => {
        const d = await design(strapSpec);
        expect(d.strapSlots.base).toHaveLength(2);
        expect(d.strapSlots.cap).toHaveLength(2);
        const probes = strapProbes(d);
        const stepBytes = await exportDesign(d, "step");
        const { valid, solidVolumes, inside } = await reimportStep(stepBytes, "reimport-strap-round", probes.points);
        expect(valid).toBe(true);
        expect(solidVolumes.length).toBe(2);
        for (const [i, err] of perPartVolumeErrors(solidVolumes, d.parts).entries()) expect(err, d.parts[i].name).toBeLessThan(0.005);
        expect(inside).toEqual(probes.expected);
      },
      STEP_TIMEOUT_MS,
    );

    it(
      "a mount plate that reaches into the strap slots is cut with them in STEP too, one solid per part, each volume matching its mesh",
      async () => {
        const d = await design({ ...strapSpec, topCap: "off", height: { locked: true, value: 40 }, layers: { locked: true, value: 1 }, wire: { length: 1500, diameter: 3.8, type: "usb" }, mount: "opengrid" });
        expect(d.strapSlots.mountPlate).toHaveLength(2);
        const stepBytes = await exportDesign(d, "step");
        const { valid, solidVolumes } = await reimportStep(stepBytes, "reimport-strap-plate");
        expect(valid).toBe(true);
        expect(solidVolumes.length).toBe(d.parts.length);
        for (const [i, err] of perPartVolumeErrors(solidVolumes, d.parts).entries()) expect(err, d.parts[i].name).toBeLessThan(0.005);
      },
      STEP_TIMEOUT_MS,
    );
  });
});
