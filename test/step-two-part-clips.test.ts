import { describe, expect, it } from "vitest";
import { design, exportDesign } from "../src/core";
import type { CoilSpec } from "../src/core";
import { STEP_TIMEOUT_MS, meshVolume, perPartVolumeErrors, reimportStep } from "./support/step";

// Split from test/step-two-part-round.test.ts: the centre-held inner end (issue #254) makes every STEP export slower
// and heavier, and the OCCT instance is shared by a file's tests, so these two-part designs have a file of their own.
describe.sequential("STEP/OCCT export: round mounts (issues #14, #207, #213, #221)", () => {
  describe("clip mount plate (issue #14) and SKÅDIS rim clips (issue #207)", () => {
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

    it(
      "STEP export of the SKÅDIS T-clips (issues #213, #221): the core with its bore floor and every clip as its own solid, each volume matching its own mesh",
      async () => {
        const d = await design({ ...plateSpec, mount: "skadis-tclip" });
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
        const d = await design({ ...plateSpec, mount: "skadis-tclip", coreSize: { locked: true, dimension: "outer", value: 64 }, topCap: "on" });
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
});
