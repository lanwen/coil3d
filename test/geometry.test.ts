import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design, exportDesign } from "../src/core";
import type { CoilSpec } from "../src/core";

// These tests exercise ONLY the core's public interface (design,
// exportDesign). manifold-3d and a hand-rolled STL parser are used here as
// independent verification tools, not as access to core internals.

/** Volume of a closed, consistently-oriented triangle mesh, by the divergence theorem -- an independent check, not core/meshVolume.ts (or manifold-3d's own .volume(), for a mesh this file never wraps in a wasm.Manifold). */
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
  print: { bedX: 256, bedY: 256, bedZ: 256 },
  mount: "none",
  plateJoint: "glue",
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

      // Independent analytic estimate (docs/design.md, Geometry): tube volume + flange volume - groove volume. Reproduces
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
      // Issue #43: the flange's own thickness is no longer a fixed
      // constant -- it now tracks the cable diameter (see design.ts) -- so
      // this reads the design's own PUBLIC `flangeSpec.thickness`, exactly
      // like the flange's outer radius just below reads the built flange's
      // own extent (issue #115: the margin can grow past the solver's
      // envelope-based `solution.flangeSize`, to fit the inner-end lead-in).
      // Issue #122: the flange is a thin plate (`plateThickness`) with pads
      // up to `thickness` under the wall, the channel and any mount cut, so
      // its volume lies between the plate's and the full thickness's.
      const flangeOuterRadius = d.solution.flangeExtent!.acrossCorners / 2;
      const flangeArea = Math.PI * (flangeOuterRadius ** 2 - boreRadius ** 2);
      const analyticVolume = tubeVolume - grooveVolume + flangeArea * d.flangeSpec.plateThickness!;
      const analyticVolumeFull = tubeVolume - grooveVolume + flangeArea * d.flangeSpec.thickness;

      const actualVolume = manifold.volume();
      expect(actualVolume).toBeGreaterThan(0);
      expect(actualVolume).toBeGreaterThan(analyticVolume * 0.9);
      expect(actualVolume).toBeLessThan(analyticVolumeFull * 1.1);
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
    // Draft is a fast, coarse preview; final is tuned for FDM (roughly
    // 16k triangles for draft and 170k for final).
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
  it("produces a binary STL that parses back to the same triangles, resting exactly on the bed (min Z = 0)", async () => {
    const d = await design({ ...baseSpec, wire: { length: 800, diameter: 3.8, type: "usb" } });
    const stl = await exportDesign(d, "stl");

    const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
    const triCount = dv.getUint32(80, true);
    const expectedTriCount = d.mesh.indices.length / 3;
    expect(triCount).toBe(expectedTriCount);
    expect(stl.byteLength).toBe(84 + triCount * 50);

    // The single "core" part's own printTransform is the identity, but its
    // mesh isn't authored with min Z at 0 (the bottom flange sits a few mm
    // below the wall's own z=0 origin -- see plate.ts's
    // `bedRestingTransform` doc comment) -- so the exported STL is shifted
    // by exactly this much to actually rest on the bed (issue #10 review).
    let meshMinZ = Infinity;
    for (let i = 2; i < d.mesh.positions.length; i += 3) {
      if (d.mesh.positions[i] < meshMinZ) meshMinZ = d.mesh.positions[i];
    }
    const zShift = -meshMinZ;

    // Spot-check a handful of triangles: the STL's per-triangle vertices
    // must match the source mesh's indexed vertices (within float32
    // precision), shifted in Z by `zShift`.
    const samples = [0, Math.floor(triCount / 2), triCount - 1];
    let stlMinZ = Infinity;
    for (const i of samples) {
      const off = 84 + i * 50 + 12; // skip the normal
      const a = d.mesh.indices[3 * i] * 3;
      const b = d.mesh.indices[3 * i + 1] * 3;
      const c = d.mesh.indices[3 * i + 2] * 3;
      const expected = [
        d.mesh.positions[a],
        d.mesh.positions[a + 1],
        d.mesh.positions[a + 2] + zShift,
        d.mesh.positions[b],
        d.mesh.positions[b + 1],
        d.mesh.positions[b + 2] + zShift,
        d.mesh.positions[c],
        d.mesh.positions[c + 1],
        d.mesh.positions[c + 2] + zShift,
      ];
      for (let k = 0; k < 9; k++) {
        expect(dv.getFloat32(off + k * 4, true)).toBeCloseTo(expected[k], 4);
      }
    }

    // Every vertex in the file, not just the sampled triangles: min Z is
    // exactly 0 (issue #10 review -- the same invariant the 3MF exporter's
    // read-back test asserts, see test/threeMf.test.ts).
    for (let i = 0; i < triCount; i++) {
      const off = 84 + i * 50 + 12;
      for (let v = 0; v < 3; v++) {
        const z = dv.getFloat32(off + v * 12 + 8, true);
        if (z < stlMinZ) stlMinZ = z;
      }
    }
    expect(stlMinZ).toBeCloseTo(0, 4);
  });
});

// Issue #32: the STEP re-import round-trip for this design moved to
// test/step.test.ts, grouped with the other STEP/OCCT tests so they don't
// run concurrently with each other and get a generous explicit timeout.

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
    // 100mm (not 60mm): big enough that 15mm sits comfortably inside the
    // useful-max ceiling issue #134 adds (`solve.ts`'s
    // `usefulMaxCornerRadius`, which grows with size), not just the old,
    // size-independent bend-limit floor this comment already guarded
    // against.
    coreSize: { locked: true, dimension: "outer", value: 100 },
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

  it("is a valid watertight manifold with the analytically-expected volume", async () => {
    const d = await design(shapeSpec);
    // Not clamped by the bend limit OR the useful-max ceiling at this size
    // -- the test would be exercising one of those clamps instead of the
    // plain shape math.
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

      // The flange's own outline is the core's offset by the flange margin
      // (issue #115: not always solution.flangeSize/2 any more -- the margin
      // can grow to fit the inner-end lead-in); recover the margin from the
      // built flange's own across-corners extent.
      const flangeMargin = d.solution.flangeExtent!.acrossCorners / 2 - circumRadius(n, outerApothem, rc);
      const flangeApothem = outerApothem + flangeMargin;
      const flangeRc = rc + flangeMargin;
      // Issues #43, #122: between the plate's and the full thickness -- see the round-core test above.
      const flangeArea = areaAt(n, flangeApothem, flangeRc, 0) - areaAt(n, boreApothem, boreRc, 0);
      const analyticVolumeFull = tubeVolume - grooveVolume + flangeArea * d.flangeSpec.thickness;
      const flangeVolume = flangeArea * d.flangeSpec.plateThickness!;

      const analyticVolume = tubeVolume - grooveVolume + flangeVolume;
      const actualVolume = manifold.volume();
      expect(actualVolume).toBeGreaterThan(0);
      expect(actualVolume).toBeGreaterThan(analyticVolume * 0.9);
      expect(actualVolume).toBeLessThan(analyticVolumeFull * 1.1);
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
    // whenever the shape isn't already fully rounded (docs/design.md, Shapes).
    const sharpCornerBound = 2 * (outerApothem / Math.cos(Math.PI / n));
    expect(d.solution.envelopeDiameter).toBeLessThan(sharpCornerBound);
    expect(d.solution.flangeSize).toBeLessThan(sharpCornerBound + 20);
  });
});

// Issue #32: the STEP re-import round-trip for the rounded-square shape,
// and for this file's own screw-keyhole mount below, both moved to
// test/step.test.ts, grouped with the other STEP/OCCT tests so they don't
// run concurrently with each other and get a generous explicit timeout.
describe("design().mesh with the screw-keyhole wall mount (issue #13)", () => {
  const MOUNT_SPECS: Array<{ label: string; shape: CoilSpec["shape"] }> = [
    { label: "round", shape: { kind: "round" } },
    { label: "sq", shape: { kind: "sq", cornerRadius: 15 } },
    { label: "tri", shape: { kind: "tri", cornerRadius: 15 } },
  ];

  describe.each(MOUNT_SPECS)("$label core", ({ shape }) => {
    const specFor = (mount: CoilSpec["mount"]): CoilSpec => ({
      wire: { length: 2000, diameter: 3.8, type: "usb" },
      shape,
      windingQuality: 0.7,
      coreSize: { locked: true, dimension: "outer", value: 100 },
      height: { locked: true, value: 60 },
      layers: { locked: true, value: 1 },
      objective: "minVolume",
      topCap: "auto",
      joint: "press",
      tolerance: 0.2,
      print: { bedX: 256, bedY: 256, bedZ: 256 },
      mount,
      plateJoint: "glue",
    });

    it("stays a valid, watertight, genus-1 manifold with the recess cut, and removes a real, non-trivial volume", async () => {
      const none = await design(specFor("none"));
      const keyhole = await design(specFor("keyhole"));

      const wasm = await Module();
      wasm.setup();
      const manifold = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: keyhole.mesh.positions, triVerts: keyhole.mesh.indices }));
      try {
        // A blind pocket is not a tunnel: it must not change the topology
        // (still one hole through the whole part -- the bore).
        expect(manifold.status()).toBe("NoError");
        expect(manifold.genus()).toBe(1);
      } finally {
        manifold.delete();
      }

      // The mount bumps the flange's margin/thickness to fit the recess
      // (design.ts, issue #13) -- both are part of the public `Design`
      // return value, not internals. Swap the "none" mesh's own (measured)
      // flange for the bigger "keyhole" flange analytically, using the
      // outline math this file already reimplements for the sq/tri tests
      // above, to isolate exactly how much volume the flange bump alone
      // would ADD with no pocket cut at all.
      const outline = keyhole.flangeSpec.outline;
      const bore = keyhole.flangeSpec.boreOutline;
      const boreArea = areaAt(bore.n, bore.apothem, bore.cornerRadius, 0);
      const noneFlangeArea = areaAt(outline.n, outline.apothem, outline.cornerRadius, none.flangeSpec.margin) - boreArea;
      const keyholeFlangeAreaNoPocket = areaAt(outline.n, outline.apothem, outline.cornerRadius, keyhole.flangeSpec.margin) - boreArea;
      const noneFlangeVolume = noneFlangeArea * none.flangeSpec.thickness;
      const keyholeFlangeVolumeNoPocket = keyholeFlangeAreaNoPocket * keyhole.flangeSpec.thickness;
      // Tube + groove are identical between the two designs (same wall
      // spec; mount never touches wall.ts), so this is the volume the
      // "keyhole" mesh would have if its bigger flange had NO recess cut.
      const expectedVolumeWithNoPocketCut = meshVolume(none.mesh) - noneFlangeVolume + keyholeFlangeVolumeNoPocket;

      // Even the shank-end circle alone (the smallest single feature of the
      // slot) is pi*2^2*3 ~= 38 mm^3 at the fixed SCREW_MOUNT_SHANK_RADIUS=2mm/
      // SCREW_MOUNT_RECESS_DEPTH=3mm constants -- 20 mm^3 is a safe, meaningful
      // lower bound on "a real pocket was actually cut", not a coincidence
      // of floating-point noise.
      const MIN_MEANINGFUL_POCKET_VOLUME = 20;
      expect(meshVolume(keyhole.mesh)).toBeLessThan(expectedVolumeWithNoPocketCut - MIN_MEANINGFUL_POCKET_VOLUME);
    });
  });

});

// Issue #41: manifold-3d boolean robustness of the screw-mount recess cut
// across flange thickness. Moved to test/geometry-keyhole-thickness-round.
// test.ts and test/geometry-keyhole-thickness-angular.test.ts (test-audit
// report, S1): these were this file's own slowest tests (about 30s of the
// file's 32s), each independently spinning a 3.5-14mm thickness sweep, so
// they're split into their own files/workers rather than sharing this one.
// See either split file's own top comment for the full issue #41 rationale.

// Issue #43 AC: "All parts stay manifold with every mount type
// (none/keyhole/SKÅDIS), for round, square and triangle (single-piece
// decompose() check)" -- now that the flange's own thickness tracks the
// cable diameter (design.ts) instead of a fixed constant, this sweeps every
// shape/mount combination at both a thin (USB, 3.8mm) and a thick (cord,
// 8mm) cable to pin that the bigger flange thickness a real cord now
// derives never reintroduces a manifold-3d robustness problem (issue #41)
// in ANY of these paths, not just the keyhole recess #41 pinned directly.
async function assertSinglePieceManifold(mesh: { positions: Float32Array; indices: Uint32Array }, label: string) {
  const wasm = await Module();
  wasm.setup();
  const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
  try {
    expect(m.status(), `${label}: status`).toBe("NoError");
    const pieces = m.decompose();
    try {
      expect(pieces.length, `${label}: connected components`).toBe(1);
    } finally {
      for (const p of pieces) p.delete();
    }
  } finally {
    m.delete();
  }
}

describe("every part stays a single-piece manifold across every mount type and shape (issue #43)", () => {
  const SHAPES: Array<{ label: string; shape: CoilSpec["shape"] }> = [
    { label: "round", shape: { kind: "round" } },
    { label: "sq", shape: { kind: "sq", cornerRadius: 15 } },
    { label: "tri", shape: { kind: "tri", cornerRadius: 15 } },
  ];
  const MOUNTS: CoilSpec["mount"][] = ["none", "keyhole", "skadis"];
  const WIRES: Array<{ label: string; diameter: number; type: CoilSpec["wire"]["type"] }> = [
    { label: "USB 3.8mm", diameter: 3.8, type: "usb" },
    { label: "cord 8mm", diameter: 8, type: "stiff" },
  ];

  for (const { label: shapeLabel, shape } of SHAPES) {
    for (const mount of MOUNTS) {
      for (const { label: wireLabel, diameter, type } of WIRES) {
        it(`${shapeLabel} core, mount=${mount}, ${wireLabel}`, async () => {
          const d = await design({
            wire: { length: 3000, diameter, type },
            shape,
            windingQuality: 0.7,
            coreSize: { locked: true, dimension: "outer", value: 100 },
            height: { locked: true, value: 60 },
            layers: { locked: true, value: 1 },
            objective: "minVolume",
            topCap: "auto",
            joint: "press",
            tolerance: 0.2,
            print: { bedX: 256, bedY: 256, bedZ: 256 },
            mount,
            plateJoint: "glue",
          });
          for (const part of d.parts) {
            await assertSinglePieceManifold(part.mesh, `${shapeLabel}/${mount}/${wireLabel}/${part.name}`);
          }
        });
      }
    }
  }
});
