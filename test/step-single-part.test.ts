import { describe, expect, it } from "vitest";
import { design, exportDesign } from "../src/core";
import type { CoilSpec } from "../src/core";
import { STEP_TIMEOUT_MS, meshVolume, reimportStep } from "./support/step";

// Split from test/step.test.ts (test-audit report, S1): the five single-part
// (one-solid) STEP designs, kept in their own file so this file's OCCT
// worker/WASM heap is independent of the two-part files' -- see the split
// files' shared top comment in test/support/step.ts for why that's safe (the
// #32 describe.sequential reason was contention WITHIN one process; separate
// files each get their own). Wrapped in describe.sequential for the same
// reason the original file was: these still share one process's CPU/memory
// budget with each other.
describe.sequential("STEP/OCCT export: single-part designs (issue #32)", () => {
  const roundSpec: CoilSpec = {
    wire: { length: 2000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 30 },
    height: { locked: true, value: 40 },
    layers: { locked: true, value: 1 },
    objective: "minVolume",
    topCap: "auto",
    joint: "press",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    mount: "none",
    plateJoint: "glue",
  };

  describe("exportDesign(design, 'step')", () => {
    it(
      "re-imports as one valid solid with volume matching the mesh",
      async () => {
        const d = await design({ ...roundSpec, wire: { length: 1000, diameter: 3.8, type: "usb" } });
        const stepBytes = await exportDesign(d, "step");
        expect(stepBytes.byteLength).toBeGreaterThan(0);

        // Independent re-import, mirroring the S2 spike's crosscheck.mjs:
        // read the STEP bytes back with OCCT and verify solid count +
        // validity + volume, rather than trusting exportDesign's own
        // internal validation.
        const { valid, solidVolumes } = await reimportStep(stepBytes, "reimport");
        expect(valid).toBe(true);
        expect(solidVolumes.length).toBe(1); // one part (core + fused bottom flange) per the ticket

        const reimportedVolume = solidVolumes[0];
        const expectedVolume = meshVolume(d.mesh);
        expect(reimportedVolume).toBeGreaterThan(0);
        expect(Math.abs(reimportedVolume - expectedVolume) / expectedVolume).toBeLessThan(0.02);
      },
      STEP_TIMEOUT_MS,
    );
  });

  describe("exportDesign(design, 'step') for a non-round shape (issue #6)", () => {
    it(
      "re-imports a rounded-square core as one valid solid with volume matching the mesh",
      async () => {
        const spec: CoilSpec = {
          wire: { length: 1000, diameter: 3.8, type: "usb" },
          shape: { kind: "sq", cornerRadius: 15 },
          windingQuality: 0.7,
          coreSize: { locked: true, dimension: "outer", value: 60 },
          height: { locked: true, value: 40 },
          layers: { locked: true, value: 1 },
          objective: "minVolume",
          topCap: "auto",
          joint: "press",
          tolerance: 0.2,
          print: { bedX: 256, bedY: 256, bedZ: 256 },
          mount: "none",
          plateJoint: "glue",
        };
        const d = await design(spec);
        const stepBytes = await exportDesign(d, "step");
        expect(stepBytes.byteLength).toBeGreaterThan(0);

        const { valid, solidVolumes } = await reimportStep(stepBytes, "reimport-sq");
        expect(valid).toBe(true);
        expect(solidVolumes.length).toBe(1);

        const reimportedVolume = solidVolumes[0];
        const expectedVolume = meshVolume(d.mesh);
        expect(reimportedVolume).toBeGreaterThan(0);
        expect(Math.abs(reimportedVolume - expectedVolume) / expectedVolume).toBeLessThan(0.02);
      },
      STEP_TIMEOUT_MS,
    );
  });

  describe("design().mesh with the screw-keyhole wall mount (issue #13)", () => {
    it(
      "re-imports the STEP export as one valid solid with volume matching the mesh, with the mount cut",
      async () => {
        const spec: CoilSpec = {
          wire: { length: 1500, diameter: 3.8, type: "usb" },
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
          mount: "keyhole",
          plateJoint: "glue",
        };
        const d = await design(spec);
        expect(d.flangeSpec.mount).toBe("keyhole");

        const stepBytes = await exportDesign(d, "step");
        expect(stepBytes.byteLength).toBeGreaterThan(0);

        const { valid, solidVolumes } = await reimportStep(stepBytes, "reimport-keyhole");
        expect(valid).toBe(true);
        expect(solidVolumes.length).toBe(1); // the recess is a blind pocket -- still one solid, not a separate part

        const reimportedVolume = solidVolumes[0];
        const expectedVolume = meshVolume(d.mesh);
        expect(reimportedVolume).toBeGreaterThan(0);
        expect(Math.abs(reimportedVolume - expectedVolume) / expectedVolume).toBeLessThan(0.02);
      },
      STEP_TIMEOUT_MS,
    );
  });

  describe("design().mesh with the through-hole wall mount (issue #70)", () => {
    it(
      "re-imports the STEP export as one valid solid with volume matching the mesh, with the through-holes cut",
      async () => {
        const spec: CoilSpec = {
          wire: { length: 1500, diameter: 3.8, type: "usb" },
          shape: { kind: "sq", cornerRadius: 15 },
          windingQuality: 0.7,
          coreSize: { locked: true, dimension: "outer", value: 100 },
          height: { locked: true, value: 60 },
          layers: { locked: true, value: 1 },
          objective: "minVolume",
          topCap: "auto",
          joint: "press",
          tolerance: 0.2,
          print: { bedX: 256, bedY: 256, bedZ: 256 },
          mount: "through",
          plateJoint: "glue",
        };
        const d = await design(spec);
        expect(d.flangeSpec.mount).toBe("through");

        const stepBytes = await exportDesign(d, "step");
        expect(stepBytes.byteLength).toBeGreaterThan(0);

        const { valid, solidVolumes } = await reimportStep(stepBytes, "reimport-through");
        expect(valid).toBe(true);
        expect(solidVolumes.length).toBe(1); // one solid per part -- the through-holes don't split the core into separate pieces

        const reimportedVolume = solidVolumes[0];
        const expectedVolume = meshVolume(d.mesh);
        expect(reimportedVolume).toBeGreaterThan(0);
        expect(Math.abs(reimportedVolume - expectedVolume) / expectedVolume).toBeLessThan(0.02);
      },
      STEP_TIMEOUT_MS,
    );
  });

  describe("design().mesh with the inner-end fixing (issue #8)", () => {
    it(
      "re-imports the STEP export as one valid solid with volume matching the mesh, with the rim keyhole + channel cut",
      async () => {
        const spec: CoilSpec = {
          wire: { length: 2000, diameter: 3.8, type: "usb" },
          shape: { kind: "round" },
          windingQuality: 0.7,
          coreSize: { locked: true, dimension: "outer", value: 60 },
          height: { locked: true, value: 40 },
          layers: { locked: true, value: 1 },
          objective: "minVolume",
          topCap: "auto",
          joint: "press",
          tolerance: 0.2,
          print: { bedX: 256, bedY: 256, bedZ: 256 },
          mount: "none",
          plateJoint: "glue",
        };
        const d = await design(spec);

        const stepBytes = await exportDesign(d, "step");
        expect(stepBytes.byteLength).toBeGreaterThan(0);

        const { valid, solidVolumes } = await reimportStep(stepBytes, "reimport-inner-end");
        expect(valid).toBe(true);
        expect(solidVolumes.length).toBe(1); // keyhole + channel are cut into the one core solid, not a separate part

        const reimportedVolume = solidVolumes[0];
        const expectedVolume = meshVolume(d.mesh);
        expect(reimportedVolume).toBeGreaterThan(0);
        expect(Math.abs(reimportedVolume - expectedVolume) / expectedVolume).toBeLessThan(0.02);
      },
      STEP_TIMEOUT_MS,
    );
  });
});
