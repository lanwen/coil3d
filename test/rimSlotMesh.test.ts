import Module from "manifold-3d";
import type { ManifoldToplevel } from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import { design, parseHash } from "../src/core";
import type { CoilSpec, Design, ShapeSpec, WireTypeId } from "../src/core";
import { rimSlotWidths } from "../src/core/innerEnd";
import type { RimSlot } from "../src/core/innerEnd";
import { EDGE_CHAMFER, RIM_SLOT_KEEP_OUT } from "../src/core/constants";
import { outlineOffsetAt } from "../src/core/shapes";

// Issue #241: the base and the cap each have a rim slot the cable is pressed into from the edge. Checked on the
// actual meshes, sliced through the plates.

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

type Manifold = InstanceType<ManifoldToplevel["Manifold"]>;
type Section = Array<Array<[number, number]>>;

function baseSpec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 3000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: false },
    height: { locked: false },
    layers: { locked: true, value: 2 },
    objective: "minVolume",
    topCap: "on",
    joint: "press",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    base: "on",
    mount: "none",
    plateJoint: "glue",
    ...overrides,
  };
}

function toManifold(mesh: { positions: Float32Array; indices: Uint32Array }): Manifold {
  return new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
}

/** Within 0.1 mm: well under print resolution, and above the mesh's own faceting (16 segments per bore arc, cross-sections a few mm apart). */
function expectNear(actual: number, expected: number, message: string) {
  expect(Math.abs(actual - expected), `${message}: ${actual.toFixed(3)} vs ${expected.toFixed(3)}`).toBeLessThanOrEqual(0.1);
}


/** Whether (x, y) lies inside a horizontal slice (even-odd over all its contours). */
function insideSlice(slice: Section, x: number, y: number): boolean {
  let odd = false;
  for (const poly of slice) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [a, b] = [poly[i], poly[j]];
      if (a[1] > y !== b[1] > y && x < a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) odd = !odd;
    }
  }
  return odd;
}

/** The empty gap through (x, y) along the unit direction `u` in a horizontal slice: its edges, as distances along `u`. */
function gapAlong(slice: Section, p: { x: number; y: number }, u: { x: number; y: number }): { left: number; right: number } {
  const hits: number[] = [];
  for (const poly of slice) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [a, b] = [poly[j], poly[i]];
      // Solve p + s u = a + t (b - a).
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const den = u.x * ey - u.y * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((p.x - a[0]) * u.y - (p.y - a[1]) * u.x) / -den;
      const s = ((a[0] - p.x) * ey - (a[1] - p.y) * ex) / den;
      if (t >= 0 && t <= 1) hits.push(s);
    }
  }
  return { left: Math.max(...hits.filter((s) => s < 0)), right: Math.min(...hits.filter((s) => s > 0)) };
}

/** A part's horizontal slice at height z, as polygons in (x, y). */
function sliceAt(part: Manifold, z: number): Section {
  const cs = part.slice(z);
  const polygons = cs.toPolygons().map((poly) => poly.map((v): [number, number] => [v[0], v[1]]));
  cs.delete();
  return polygons;
}

/**
 * Issue #241: a rim slot, checked in the real mesh, sliced through the middle
 * of the plate: a round seat of d + tolerance, a neck out to the rim a little
 * narrower than the cable, a lead-in widening at the mouth, open to the
 * outside, with plate all round the seat's inner side.
 */
function checkRimSlot(mesh: { positions: Float32Array; indices: Uint32Array }, slot: RimSlot, z: number, d: Design, tag: string) {
  const wd = d.spec.wire.diameter;
  const R = (wd + d.spec.tolerance) / 2;
  const { outline, margin } = d.flangeSpec;
  const a = slot.axis;
  const b = { x: -a.y, y: a.x };
  const at = (s: number) => ({ x: slot.seat.x + a.x * s, y: slot.seat.y + a.y * s });
  const part = toManifold(mesh);
  try {
    const slice = sliceAt(part, z);
    const { seat, neck } = rimSlotWidths(wd, d.spec.tolerance);
    expect(seat, `${tag}: the seat is the cable plus a tolerance`).toBeCloseTo(wd + d.spec.tolerance, 6);
    expect(neck, `${tag}: the cable has to snap in`).toBeLessThan(wd);
    expect(neck, `${tag}: a stiff cable needs only a little interference`).toBeGreaterThan(0.9 * wd);
    // The seat: round, d + tolerance across (the 32-facet circle's chords sit a little inside it).
    for (const k of [0, -0.5]) {
      const g = gapAlong(slice, at(k * R), b);
      expectNear(g.right - g.left, 2 * R * Math.sqrt(1 - k * k), `${tag}: seat ${k} R along`);
    }
    // The neck, from where it leaves the seat to the foot of the rim chamfer.
    const neckStart = Math.sqrt(R * R - (neck / 2) ** 2);
    for (const s of [neckStart + 0.2, neckStart + 0.8]) {
      const g = gapAlong(slice, at(s), b);
      expectNear(g.right - g.left, neck, `${tag}: neck ${s.toFixed(2)} mm out`);
      expectNear(outlineOffsetAt(outline, at(s).x, at(s).y).offset, margin - EDGE_CHAMFER - (neckStart + 1 - s), `${tag}: the neck ends at the rim chamfer's foot`);
    }
    // The lead-in: wider at the rim.
    const mouth = gapAlong(slice, at(neckStart + 1 + 0.5), b);
    expectNear(mouth.right - mouth.left, neck + 1, `${tag}: the 45 degree lead-in`);
    // Open from the seat out past the rim, along the slot's middle.
    for (let s = -R + 0.05; outlineOffsetAt(outline, at(s).x, at(s).y).offset < margin + 0.5; s += 0.1) {
      expect(insideSlice(slice, at(s).x, at(s).y), `${tag}: open along the slot, ${s.toFixed(2)} mm out`).toBe(false);
    }
    // Plate behind the seat.
    expect(insideSlice(slice, at(-R - 0.3).x, at(-R - 0.3).y), `${tag}: plate behind the seat`).toBe(true);
  } finally {
    part.delete();
  }
}

/**
 * Issue #241: the rim slots. The cap's is where the cable's outer end leaves
 * the coil (the drawn cable runs out under it), the base's right below it
 * unless something on the base is in the way; the base's keeps clear of the
 * inner-end channel.
 */
function checkRimSlots(d: Design, label: string) {
  const { base, cap } = d.rimSlots;
  expect(base, `${label}: a base slot`).toBeDefined();
  checkRimSlot(d.mesh, base!, -d.flangeSpec.thickness + (d.flangeSpec.plateThickness ?? d.flangeSpec.thickness) / 2, d, `${label}, base`);
  // Clear of the channel (the cable's centre where it lies below the face).
  const lead = d.innerEndLeadIn;
  const R = (d.spec.wire.diameter + d.spec.tolerance) / 2;
  for (let i = 0; i < lead.length; i += 3) {
    if (lead[i + 2] > 0) continue;
    for (const q of base!.outline) {
      if (outlineOffsetAt(d.flangeSpec.outline, q.x, q.y).offset > d.flangeSpec.margin) continue;
      expect(Math.hypot(q.x - lead[i], q.y - lead[i + 1]), `${label}: base slot clear of the channel`).toBeGreaterThanOrEqual(R + RIM_SLOT_KEEP_OUT - 0.05);
    }
  }
  const capPart = d.parts.find((p) => p.role === "topCap");
  if (!capPart) {
    expect(cap, `${label}: no cap slot without a cap`).toBeUndefined();
    return;
  }
  expect(cap, `${label}: a cap slot`).toBeDefined();
  checkRimSlot(capPart.mesh, cap!, d.solution.height + 1.5, d, `${label}, cap`);
  // Where the drawn cable comes out from under the cap: its level run starts
  // right under the slot's seat, along the outline.
  const out = d.outerEndLeadOut;
  const n = out.length / 3;
  const zKey = out[n * 3 - 1];
  let first = n - 1;
  while (first > 0 && Math.abs(out[first * 3 - 1] - zKey) < 1e-6) first--;
  const start = { x: out[first * 3], y: out[first * 3 + 1] };
  const seatOffset = outlineOffsetAt(d.flangeSpec.outline, cap!.seat.x, cap!.seat.y).offset;
  const startOffset = outlineOffsetAt(d.flangeSpec.outline, start.x, start.y).offset;
  expect(Math.hypot(cap!.seat.x - start.x, cap!.seat.y - start.y), `${label}: the cap slot is where the cable comes out`).toBeLessThan(Math.abs(seatOffset - startOffset) + 0.5);
}

const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 10 }, { kind: "tri", cornerRadius: 10 }];
const TYPES: Array<{ type: WireTypeId; diameter: number }> = [
  { type: "usb", diameter: 3.8 },
  { type: "flex", diameter: 2.5 },
  { type: "stiff", diameter: 3.6 },
];

describe("rim cable slots (issue #241)", () => {
  it("the user's repro (stiff 3.6 mm, 132 mm round core, 3 layers, cap off, keyhole mount)", async () => {
    const parsed = parseHash("#s=eyJ2IjoyLCJMIjozNzEwLCJkIjozLjYsInd0Ijoic3RpZmYiLCJzaXplIjoxMzIsImx5IjozLCJjYXAiOiJvZmYiLCJtb3VudCI6ImtleWhvbGUifQ");
    const d = await design(parsed!.spec);
    checkRimSlots(d, "repro");
    const withCap = await design({ ...parsed!.spec, topCap: "on" });
    checkRimSlots(withCap, "repro, cap on");
  });

  for (const shape of SHAPES) {
    for (const { type, diameter } of TYPES) {
      for (const topCap of ["on", "off"] as const) {
        it(`shape=${shape.kind} type=${type} cap=${topCap}`, async () => {
          const d = await design(baseSpec({ shape, wire: { length: 3000, diameter, type }, topCap }));
          checkRimSlots(d, `${shape.kind}/${type}/cap-${topCap}`);
        });
      }
    }
  }

  it("a thick 8 mm cord gets the same rim slots", async () => {
    const d = await design(baseSpec({ wire: { length: 2000, diameter: 8, type: "stiff" }, coreSize: { locked: true, dimension: "outer", value: 60 }, layers: { locked: true, value: 1 }, topCap: "on" }));
    checkRimSlots(d, "8 mm cord");
  });
});
