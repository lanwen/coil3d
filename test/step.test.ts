import { describe, expect, it } from "vitest";
import { design, exportDesign } from "../src/core";
import type { CoilSpec, JointKind } from "../src/core";

// Issue #32: every test in this file spins up its own OCCT (opencascade.js)
// instance to build and/or re-import a STEP file -- the slowest operation in
// the suite, and one that gets much slower under CPU contention. They are
// deliberately kept in this single file (and wrapped in describe.sequential,
// which nested describes inherit) so they never run concurrently with each
// other, and each gets a generous explicit timeout instead of vitest's 5 s
// default. Moving them here doesn't change what they assert -- see
// test/geometry.test.ts and test/topCap.test.ts, which they were split out
// of, for the non-STEP tests that cover the same designs.
const STEP_TIMEOUT_MS = 60_000;

/** Volume of a closed, consistently-oriented triangle mesh, by the divergence theorem -- an independent check, not core/meshVolume.ts. */
function meshVolume(mesh: { positions: Float32Array; indices: Uint32Array }): number {
  const { positions: v, indices: t } = mesh;
  let volume = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3;
    const b = t[i + 1] * 3;
    const c = t[i + 2] * 3;
    volume +=
      (v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) -
        v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) +
        v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])) /
      6;
  }
  return Math.abs(volume);
}

describe.sequential("STEP/OCCT export (issue #32: grouped, generous timeout)", () => {
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
        // read the STEP bytes back with a fresh OCCT instance and verify solid
        // count + validity + volume, rather than trusting exportDesign's own
        // internal validation.
        const { default: initOC } = await import("replicad-opencascadejs");
        const oc = await initOC();
        const path = "/reimport.step";
        oc.FS.writeFile(path, stepBytes);
        const reader = new oc.STEPControl_Reader();
        reader.ReadFile(path);
        reader.TransferRoots();
        const shape = reader.OneShape();
        oc.FS.unlink(path);

        const analyzer = new oc.BRepCheck_Analyzer(shape, true, false, false);
        expect(analyzer.IsValid()).toBe(true);

        let solidCount = 0;
        const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
        for (; explorer.More(); explorer.Next()) solidCount++;
        expect(solidCount).toBe(1); // one part (core + fused bottom flange) per the ticket

        const gprops = new oc.GProp_GProps();
        oc.BRepGProp.VolumeProperties(shape, gprops, 1e-5, false, false);
        const reimportedVolume = gprops.Mass();

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

        const { default: initOC } = await import("replicad-opencascadejs");
        const oc = await initOC();
        const path = "/reimport-sq.step";
        oc.FS.writeFile(path, stepBytes);
        const reader = new oc.STEPControl_Reader();
        reader.ReadFile(path);
        reader.TransferRoots();
        const shape = reader.OneShape();
        oc.FS.unlink(path);

        const analyzer = new oc.BRepCheck_Analyzer(shape, true, false, false);
        expect(analyzer.IsValid()).toBe(true);

        let solidCount = 0;
        const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
        for (; explorer.More(); explorer.Next()) solidCount++;
        expect(solidCount).toBe(1);

        const gprops = new oc.GProp_GProps();
        oc.BRepGProp.VolumeProperties(shape, gprops, 1e-5, false, false);
        const reimportedVolume = gprops.Mass();

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

        const { default: initOC } = await import("replicad-opencascadejs");
        const oc = await initOC();
        const path = "/reimport-keyhole.step";
        oc.FS.writeFile(path, stepBytes);
        const reader = new oc.STEPControl_Reader();
        reader.ReadFile(path);
        reader.TransferRoots();
        const shape = reader.OneShape();
        oc.FS.unlink(path);

        const analyzer = new oc.BRepCheck_Analyzer(shape, true, false, false);
        expect(analyzer.IsValid()).toBe(true);

        let solidCount = 0;
        const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
        for (; explorer.More(); explorer.Next()) solidCount++;
        expect(solidCount).toBe(1); // the recess is a blind pocket -- still one solid, not a separate part

        const gprops = new oc.GProp_GProps();
        oc.BRepGProp.VolumeProperties(shape, gprops, 1e-5, false, false);
        const reimportedVolume = gprops.Mass();

        const expectedVolume = meshVolume(d.mesh);
        expect(reimportedVolume).toBeGreaterThan(0);
        expect(Math.abs(reimportedVolume - expectedVolume) / expectedVolume).toBeLessThan(0.02);
      },
      STEP_TIMEOUT_MS,
    );
  });

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

        const { default: initOC } = await import("replicad-opencascadejs");
        const oc = await initOC();
        const path = `/reimport-cap-${joint}.step`;
        oc.FS.writeFile(path, stepBytes);
        const reader = new oc.STEPControl_Reader();
        reader.ReadFile(path);
        reader.TransferRoots();
        const shape = reader.OneShape();
        oc.FS.unlink(path);

        const analyzer = new oc.BRepCheck_Analyzer(shape, true, false, false);
        expect(analyzer.IsValid()).toBe(true);

        let solidCount = 0;
        let totalVolume = 0;
        const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
        for (; explorer.More(); explorer.Next()) {
          solidCount++;
          const gprops = new oc.GProp_GProps();
          oc.BRepGProp.VolumeProperties(explorer.Current(), gprops, 1e-5, false, false);
          totalVolume += gprops.Mass();
        }
        expect(solidCount).toBe(2); // core + top-cap, per the ticket "one solid per part"

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

        const { default: initOC } = await import("replicad-opencascadejs");
        const oc = await initOC();
        const path = "/reimport-label.step";
        oc.FS.writeFile(path, stepBytes);
        const reader = new oc.STEPControl_Reader();
        reader.ReadFile(path);
        reader.TransferRoots();
        const shape = reader.OneShape();
        oc.FS.unlink(path);

        const analyzer = new oc.BRepCheck_Analyzer(shape, true, false, false);
        expect(analyzer.IsValid()).toBe(true);

        let solidCount = 0;
        let totalVolume = 0;
        const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
        for (; explorer.More(); explorer.Next()) {
          solidCount++;
          const gprops = new oc.GProp_GProps();
          oc.BRepGProp.VolumeProperties(explorer.Current(), gprops, 1e-5, false, false);
          totalVolume += gprops.Mass();
        }
        expect(solidCount).toBe(2); // core + top-cap, same as issue #9's own STEP test

        // The engraved label is a real, non-trivial volume difference
        // (test/label.test.ts already proves the mesh backend removes
        // material) -- checking it here too would just re-run that same
        // fit; the interesting NEW claim for STEP is that its own
        // independently-built label cutter (step/build.ts's
        // `buildLabelCutterSolid`) agrees with the mesh backend's volume
        // within the same tolerance every other part/joint combination here
        // is held to.
        const expectedVolume = d.parts.reduce((sum, p) => sum + meshVolume(p.mesh), 0);
        expect(Math.abs(totalVolume - expectedVolume) / expectedVolume).toBeLessThan(0.02);
      },
      STEP_TIMEOUT_MS,
    );
  });
});
