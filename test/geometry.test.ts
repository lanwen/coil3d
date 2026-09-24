import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design, exportDesign } from "../src/core";
import type { CoilSpec } from "../src/core";

// These tests exercise ONLY the core's public interface (design,
// exportDesign). manifold-3d and a hand-rolled STL parser are used here as
// independent verification tools, not as access to core internals.

const baseSpec: CoilSpec = {
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
};

describe("design().mesh is a valid, expected manifold", () => {
  it("is watertight (manifold-3d accepts it) with the expected genus, and its volume is in the right ballpark", async () => {
    const d = await design(baseSpec);

    const wasm = await Module();
    wasm.setup();
    const manifold = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: d.mesh.positions, triVerts: d.mesh.indices }));
    try {
      expect(manifold.status()).toBe("NoError");
      // A tube (wall) with a bottom flange fused on is still topologically a
      // single hole through the whole solid: genus 1.
      expect(manifold.genus()).toBe(1);

      // Independent analytic estimate (docs/research.md §4, S1 spike
      // RESULT.md): tube volume + flange volume - groove volume. Reproduces
      // the core's fixed constants (teardrop groove depth ~= 0.3*d) by
      // contract, not by importing core internals. The flange now sizes to
      // the solved envelope (issue #5), not just outerRadius + margin.
      const wireDiameter = baseSpec.wire.diameter;
      const grooveDepth = 0.3 * wireDiameter;
      const clearance = 0.3;
      const rho = wireDiameter / 2 + clearance / 2;
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
      const turns = d.solution.layerResults[0].turns;
      const perimeter = d.solution.layerResults[0].perimeter;
      const grooveVolume = grooveArea * perimeter * Math.max(0, turns - taperTurns);

      const outerRadius = d.solution.outerSize / 2;
      const boreRadius = d.solution.innerBore / 2;
      const tubeVolume = Math.PI * (outerRadius ** 2 - boreRadius ** 2) * d.solution.height;
      const flangeThickness = 3;
      const flangeOuterRadius = d.solution.flangeSize / 2;
      const flangeVolume = Math.PI * (flangeOuterRadius ** 2 - boreRadius ** 2) * flangeThickness;
      const analyticVolume = tubeVolume - grooveVolume + flangeVolume;

      const actualVolume = manifold.volume();
      expect(actualVolume).toBeGreaterThan(0);
      expect(Math.abs(actualVolume - analyticVolume) / analyticVolume).toBeLessThan(0.1);
    } finally {
      manifold.delete();
    }
  });

  it("sizes the flange to clear a second wound layer (issue #5: layer count affects the flange)", async () => {
    const twoLayerSpec: CoilSpec = { ...baseSpec, layers: { locked: true, value: 2 }, height: { locked: true, value: 60 } };
    const oneLayer = await design(baseSpec);
    const twoLayers = await design(twoLayerSpec);
    expect(twoLayers.solution.envelopeDiameter).toBeGreaterThan(oneLayer.solution.envelopeDiameter);
    expect(twoLayers.solution.flangeSize).toBeGreaterThan(oneLayer.solution.flangeSize);
    expect(twoLayers.solution.capsAuto).toBe(true);
    expect(oneLayer.solution.capsAuto).toBe(false);
  });
});

describe("design(spec, resolution)", () => {
  it("draft is coarser than final, and both are valid, watertight manifolds (issue #7)", async () => {
    const draft = await design(baseSpec, "draft");
    const final = await design(baseSpec, "final");

    expect(draft.resolution).toBe("draft");
    expect(final.resolution).toBe("final");
    // Draft is a fast, coarse preview; final is tuned for FDM (docs/research.md
    // "Two resolution levels: draft (~16k triangles) ... final (~170k)").
    expect(draft.mesh.indices.length).toBeLessThan(final.mesh.indices.length);

    const wasm = await Module();
    wasm.setup();
    for (const d of [draft, final]) {
      const manifold = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: d.mesh.positions, triVerts: d.mesh.indices }));
      try {
        expect(manifold.status()).toBe("NoError");
        expect(manifold.genus()).toBe(1);
      } finally {
        manifold.delete();
      }
    }
  });

  it("defaults to final resolution when the argument is omitted (existing callers, exports)", async () => {
    const implicit = await design(baseSpec);
    const explicit = await design(baseSpec, "final");
    expect(implicit.resolution).toBe("final");
    expect(implicit.mesh.indices.length).toBe(explicit.mesh.indices.length);
  });
});

// Regression note (issue #6 review): generalising point evaluation from a
// plain `theta = 2*pi*t` circle formula to the shared rounded-n-gon outline
// math (shapes.ts's evalOutline/paramAt, which starts a corner's arc-length
// walk at the arc's EDGE, not its bisector) silently rotated round's whole
// groove/helix by -pi/4. It was caught by e2e/line-art.spec.ts's committed
// screenshot baselines (a diff on every groove ring, matching flange/rim --
// see PR #24 review), not by any vitest check, and deliberately can't be: it
// is a pure rotation about the coil's own axis, so it changes neither the
// solver's numbers (capacity.ts never evaluates a point/angle -- it's pure
// Steiner-perimeter arithmetic on apothem/cornerRadius/offset) nor the
// mesh's volume/genus/manifoldness (already covered above, and unaffected
// with or without the bug). A vertex-position check against design()'s
// returned mesh is also unreliable: `mesh` is manifold-3d's POST-BOOLEAN
// (wall + flange) output, whose vertex order/indices are that library's own
// and not preserved from the wall's construction, and -- for the plain
// circular rim specifically -- a rotation by exactly one 96th-of-a-turn
// multiple of 45 degrees reproduces the exact same set of rim angles, so
// even an order-independent "is there a rim vertex near angle 0" check
// can't distinguish the two (it's the groove's helical PHASE at that angle
// that differs, not the rim's angle set). shapes.ts's `pointAt` now
// special-cases an exact circle (cornerRadius === apothem, true for any `n`)
// to the old closed-form circle formula, so round's mesh is built by
// EXACTLY the pre-#6 formula again, not merely close to it -- the right
// regression guard for this bug is the e2e screenshot suite.

describe("exportDesign(design, 'stl')", () => {
  it("produces a binary STL that parses back to the same triangles", async () => {
    const d = await design({ ...baseSpec, wire: { length: 800, diameter: 3.8, type: "usb" } });
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
    const d = await design({ ...baseSpec, wire: { length: 1000, diameter: 3.8, type: "usb" } });
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

// Issue #6: rounded-square and rounded-triangle shape plugins. These tests
// reimplement the Steiner offset-outline math independently (a regular
// n-gon with rounded corners: apothem, corner radius, n), the same way the
// round-only tests above reimplement the groove profile -- not by importing
// src/core/shapes.ts.
function sideLen(n: number, apothem: number, rc: number): number {
  return 2 * (apothem - rc) * Math.tan(Math.PI / n);
}
function straightTotal(n: number, apothem: number, rc: number): number {
  return n * sideLen(n, apothem, rc);
}
function areaAt(n: number, apothem: number, rc: number, offset: number): number {
  const ac = apothem - rc;
  const Ac = n * ac * ac * Math.tan(Math.PI / n);
  const r = rc + offset;
  return Ac + straightTotal(n, apothem, rc) * r + Math.PI * r * r;
}
function circumRadius(n: number, apothem: number, rc: number): number {
  const half = Math.PI / n;
  const Rc = (apothem - rc) / Math.cos(half);
  return Rc + rc;
}

const SHAPE_CASES: Array<{ shape: "sq" | "tri"; n: number; cornerRadius: number }> = [
  { shape: "sq", n: 4, cornerRadius: 15 },
  { shape: "tri", n: 3, cornerRadius: 15 },
];

describe.each(SHAPE_CASES)("design().mesh for a $shape core (issue #6)", ({ shape, n, cornerRadius }) => {
  const shapeSpec: CoilSpec = {
    wire: { length: 2000, diameter: 3.8, type: "usb" },
    shape: { kind: shape, cornerRadius },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 60 },
    height: { locked: true, value: 40 },
    layers: { locked: true, value: 1 },
    objective: "minVolume",
    topCap: "auto",
    joint: "press",
    tolerance: 0.2,
  };

  it("is a valid watertight manifold with the analytically-expected volume", async () => {
    const d = await design(shapeSpec);
    // Not clamped by the bend limit at this size -- the test would be
    // exercising the "became round" clamp instead of the plain shape math.
    expect(d.solution.cornerRadius).toBeCloseTo(cornerRadius, 3);

    const wasm = await Module();
    wasm.setup();
    const manifold = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: d.mesh.positions, triVerts: d.mesh.indices }));
    try {
      expect(manifold.status()).toBe("NoError");
      expect(manifold.genus()).toBe(1);

      const outerApothem = d.solution.outerSize / 2;
      const rc = d.solution.cornerRadius;
      const boreApothem = Math.max(1, outerApothem - 3); // WALL_THICKNESS = 3, MIN_BORE_RADIUS = 1
      const boreRc = Math.min(Math.max(rc - 3, 0.5), boreApothem); // MIN_BORE_CORNER_RADIUS = 0.5
      const tubeVolume = (areaAt(n, outerApothem, rc, 0) - areaAt(n, boreApothem, boreRc, 0)) * d.solution.height;

      const wireDiameter = shapeSpec.wire.diameter;
      const grooveDepth = 0.3 * wireDiameter;
      const clearance = 0.3;
      const rho = wireDiameter / 2 + clearance / 2;
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
      const turns = d.solution.layerResults[0].turns;
      const perimeter = d.solution.layerResults[0].perimeter; // public API value, not recomputed
      const grooveVolume = grooveArea * perimeter * Math.max(0, turns - taperTurns);

      // The flange's own circumscribed radius equals solution.flangeSize/2
      // by construction (design.ts's margin computation); recover the
      // margin from that to get the flange's own outline.
      const flangeMargin = d.solution.flangeSize / 2 - circumRadius(n, outerApothem, rc);
      const flangeApothem = outerApothem + flangeMargin;
      const flangeRc = rc + flangeMargin;
      const flangeThickness = 3;
      const flangeVolume = (areaAt(n, flangeApothem, flangeRc, 0) - areaAt(n, boreApothem, boreRc, 0)) * flangeThickness;

      const analyticVolume = tubeVolume - grooveVolume + flangeVolume;
      const actualVolume = manifold.volume();
      expect(actualVolume).toBeGreaterThan(0);
      expect(Math.abs(actualVolume - analyticVolume) / analyticVolume).toBeLessThan(0.1);
    } finally {
      manifold.delete();
    }
  });

  it("sizes the envelope/flange from the true offset outline, not a bounding circle across the sharp corner", async () => {
    const d = await design(shapeSpec);
    const outerApothem = d.solution.outerSize / 2;
    const rc = d.solution.cornerRadius;
    // The old bounding-circle estimate for a sharp (rc=0) n-gon of the same
    // apothem: across-corners radius = apothem / cos(pi/n). The TRUE
    // rounded-outline envelope must be strictly smaller than that overestimate
    // whenever the shape isn't already fully rounded (docs/research.md §10a).
    const sharpCornerBound = 2 * (outerApothem / Math.cos(Math.PI / n));
    expect(d.solution.envelopeDiameter).toBeLessThan(sharpCornerBound);
    expect(d.solution.flangeSize).toBeLessThan(sharpCornerBound + 20);
  });
});

describe("exportDesign(design, 'step') for a non-round shape (issue #6)", () => {
  it("re-imports a rounded-square core as one valid solid with volume matching the mesh", async () => {
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
  });
});
