import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design, exportDesign } from "../src/core";

// These tests exercise ONLY the core's public interface (design,
// exportDesign). manifold-3d and a hand-rolled STL parser are used here as
// independent verification tools, not as access to core internals.

describe("design().mesh is a valid, expected manifold", () => {
  it("is watertight (manifold-3d accepts it) with the expected genus, and its volume is in the right ballpark", async () => {
    const spec = { wireLength: 2000, wireDiameter: 3.8, coreSize: 30 };
    const d = await design(spec);

    const wasm = await Module();
    wasm.setup();
    const manifold = new wasm.Manifold(
      new wasm.Mesh({ numProp: 3, vertProperties: d.mesh.positions, triVerts: d.mesh.indices }),
    );
    try {
      expect(manifold.status()).toBe("NoError");
      // A tube (wall) with a bottom flange fused on is still topologically a
      // single hole through the whole solid: genus 1.
      expect(manifold.genus()).toBe(1);

      // Independent analytic estimate (docs/research.md §4, S1 spike
      // RESULT.md): tube volume + flange volume - groove volume. Reproduces
      // the ticket's fixed constants (teardrop groove depth ~= 0.3*d) by
      // contract, not by importing core internals.
      const grooveDepth = 0.3 * spec.wireDiameter;
      const clearance = 0.3;
      const rho = spec.wireDiameter / 2 + clearance / 2;
      const c = rho - grooveDepth;
      const s45 = Math.SQRT1_2;
      const dz45 = rho * s45;
      const f45 = c - rho * s45;
      const profile = (dz: number) => {
        if (dz > dz45) return f45 + (dz - dz45);
        return Math.abs(dz) >= rho ? 0 : c - Math.sqrt(rho * rho - dz * dz);
      };
      const halfDown = c >= rho ? 0 : Math.sqrt(Math.max(0, rho * rho - c * c));
      const reachUp = dz45 - f45;
      const span = halfDown + reachUp;
      const N = 4000;
      let grooveArea = 0;
      for (let k = 0; k < N; k++) {
        const dz = -halfDown + (k + 0.5) * (span / N);
        const v = profile(dz);
        if (v < 0) grooveArea += -v * (span / N);
      }
      const taperTurns = 0.5;
      const grooveVolume = grooveArea * d.perimeter * Math.max(0, d.turns - taperTurns);
      const tubeVolume = Math.PI * (d.outerRadius ** 2 - d.boreRadius ** 2) * d.height;
      const flangeMargin = 4;
      const flangeThickness = 3;
      const flangeVolume = Math.PI * ((d.outerRadius + flangeMargin) ** 2 - d.boreRadius ** 2) * flangeThickness;
      const analyticVolume = tubeVolume - grooveVolume + flangeVolume;

      const actualVolume = manifold.volume();
      expect(actualVolume).toBeGreaterThan(0);
      expect(Math.abs(actualVolume - analyticVolume) / analyticVolume).toBeLessThan(0.1);
    } finally {
      manifold.delete();
    }
  });
});

describe("exportDesign(design, 'stl')", () => {
  it("produces a binary STL that parses back to the same triangles", async () => {
    const d = await design({ wireLength: 800, wireDiameter: 3.8, coreSize: 30 });
    const stl = await exportDesign(d, "stl");

    const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
    const triCount = dv.getUint32(80, true);
    const expectedTriCount = d.mesh.indices.length / 3;
    expect(triCount).toBe(expectedTriCount);
    expect(stl.byteLength).toBe(84 + triCount * 50);

    // Spot-check a handful of triangles: the STL's per-triangle vertices
    // must match the source mesh's indexed vertices (within float32
    // precision).
    const samples = [0, Math.floor(triCount / 2), triCount - 1];
    for (const i of samples) {
      const off = 84 + i * 50 + 12; // skip the normal
      const a = d.mesh.indices[3 * i] * 3;
      const b = d.mesh.indices[3 * i + 1] * 3;
      const c = d.mesh.indices[3 * i + 2] * 3;
      const expected = [
        d.mesh.positions[a],
        d.mesh.positions[a + 1],
        d.mesh.positions[a + 2],
        d.mesh.positions[b],
        d.mesh.positions[b + 1],
        d.mesh.positions[b + 2],
        d.mesh.positions[c],
        d.mesh.positions[c + 1],
        d.mesh.positions[c + 2],
      ];
      for (let k = 0; k < 9; k++) {
        expect(dv.getFloat32(off + k * 4, true)).toBeCloseTo(expected[k], 4);
      }
    }
  });
});

// Volume of a closed triangle mesh by the divergence theorem, computed
// independently of core/meshVolume.ts (an internal helper) so this test
// exercises only the public interface's outputs (design().mesh).
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

describe("exportDesign(design, 'step')", () => {
  it("re-imports as one valid solid with volume matching the mesh", async () => {
    const spec = { wireLength: 1000, wireDiameter: 3.8, coreSize: 30 };
    const d = await design(spec);
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
  });
});
