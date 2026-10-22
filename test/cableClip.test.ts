import Module from "manifold-3d";
import type { ManifoldToplevel } from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import { CABLE_BASE_CLIP_LAND, CABLE_CLIP_WALL, design, EDGE_CHAMFER, outlineOffsetAt, parseHash, RIM_SLOT_KEEP_OUT } from "../src/core";
import type { CoilSpec, Design, ShapeSpec, WireTypeId } from "../src/core";
import { rimSlotNeckWidth } from "./support/rimSlot";
import type { RimSlot } from "./support/types";

// Issue #117: the cable's fix points. The bottom flange's channel must be
// round (a bore of about d + tolerance around the cable), its depth must
// follow the cable's own drop smoothly (no fixed-depth box, no square
// corners), and near the rim the cable snaps into a clip whose opening is
// narrower than the cable. Issue #241: the base and the cap each have a rim
// slot the cable is pressed into from the edge. Checked on the actual meshes,
// sliced across the cable and through the plates.

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
    base: "on",
    joint: "press",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    mount: "none",
    plateJoint: "glue",
    ...overrides,
  };
}

function toManifold(mesh: { positions: Float32Array; indices: Uint32Array }): Manifold {
  return new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
}

/** The part's cross-section in the vertical plane through `p` across the plan direction `dir`, as polygons in (u, z): u across the cable (to its left), z unchanged. */
function sectionAcross(part: Manifold, p: { x: number; y: number }, dir: { x: number; y: number }): Section {
  const l = Math.hypot(dir.x, dir.y);
  const [dx, dy] = [dir.x / l, dir.y / l];
  const moved = part.transform([-dy, 0, dx, 0, dx, 0, dy, 0, 0, 1, 0, 0, dy * p.x - dx * p.y, 0, -dx * p.x - dy * p.y, 1]);
  const cs = moved.slice(0);
  const polygons = cs.toPolygons().map((poly) => poly.map((v): [number, number] => [v[0], v[1]]));
  cs.delete();
  moved.delete();
  return polygons;
}

/** Every u where the section's outline crosses the horizontal line at `z`. */
function crossingsAtZ(section: Section, z: number): number[] {
  const out: number[] = [];
  for (const poly of section) {
    for (let i = 0; i < poly.length; i++) {
      const [a, b] = [poly[i], poly[(i + 1) % poly.length]];
      if (a[1] > z !== b[1] > z) out.push(a[0] + ((z - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
  }
  return out;
}

/** Every z where the section's outline crosses the vertical line at u = 0. */
function crossingsAtCentre(section: Section): number[] {
  const out: number[] = [];
  for (const poly of section) {
    for (let i = 0; i < poly.length; i++) {
      const [a, b] = [poly[i], poly[(i + 1) % poly.length]];
      if (a[0] > 0 !== b[0] > 0) out.push(a[1] + ((0 - a[0]) * (b[1] - a[1])) / (b[0] - a[0]));
    }
  }
  return out;
}

/** The empty gap around u = 0 at height z: its left and right edges. */
function gapAt(section: Section, z: number): { left: number; right: number } {
  const xs = crossingsAtZ(section, z);
  return { left: Math.max(...xs.filter((u) => u < 0)), right: Math.min(...xs.filter((u) => u > 0)) };
}

/** Within 0.1 mm: well under print resolution, and above the mesh's own faceting (16 segments per bore arc, cross-sections a few mm apart). */
function expectNear(actual: number, expected: number, message: string) {
  expect(Math.abs(actual - expected), `${message}: ${actual.toFixed(3)} vs ${expected.toFixed(3)}`).toBeLessThanOrEqual(0.1);
}

function sample(points: Float32Array, i: number) {
  return { x: points[i * 3], y: points[i * 3 + 1], z: points[i * 3 + 2] };
}

/** Plan direction and slope (dz per plan mm) of the drawn cable at sample i. */
function tangentAt(points: Float32Array, i: number) {
  const n = points.length / 3;
  const a = sample(points, Math.max(0, i - 1));
  const b = sample(points, Math.min(n - 1, i + 1));
  const plan = Math.hypot(b.x - a.x, b.y - a.y);
  return { dir: { x: b.x - a.x, y: b.y - a.y }, slope: (b.z - a.z) / plan };
}

/** The core cropped to the box around the inner-end lead-in, so the many slices below stay cheap. */
function croppedCore(d: Design): Manifold {
  const lead = d.innerEndLeadIn;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < lead.length; i += 3) {
    xs.push(lead[i]);
    ys.push(lead[i + 1]);
  }
  const lo = [Math.min(...xs) - 10, Math.min(...ys) - 10, -d.flangeSpec.thickness - 1];
  const hi = [Math.max(...xs) + 10, Math.max(...ys) + 10, 8];
  const core = toManifold(d.mesh);
  const box = wasm.Manifold.cube([hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]).translate([lo[0], lo[1], lo[2]]);
  const cropped = core.intersect(box);
  core.delete();
  box.delete();
  return cropped;
}

/**
 * Walk the drawn lead-in from the groove start toward the fix point and
 * check the cut channel under it: its depth only grows, smoothly, and tracks
 * the cable's own bottom (the bore around it); where the cable lies level,
 * the cross-section is round at d + tolerance; in the clip the opening is
 * narrower than the cable.
 */
function checkInnerEnd(d: Design, label: string) {
  const clip = d.innerEndClip!;
  const channelDepth = clip.channelDepth;
  const R = (d.spec.wire.diameter + d.spec.tolerance) / 2;
  const zChannel = -channelDepth + d.spec.wire.diameter / 2;
  const { outline, margin } = d.flangeSpec;
  const lead = d.innerEndLeadIn;
  const n = lead.length / 3;
  const core = croppedCore(d);
  try {
    let previous = 0;
    let reached = 0;
    let levelChecked = 0;
    for (let i = n - 1; i >= 0; i--) {
      const c = sample(lead, i);
      const offset = outlineOffsetAt(outline, c.x, c.y).offset;
      // Clear of the wall (the cut is clipped 0.2 mm outside it) and inside
      // the rim. The first turn starts on the face, so the channel starts
      // right beside the wall.
      if (offset < 0.3 || offset > margin - R - 0.5) continue;
      const { dir, slope } = tangentAt(lead, i);
      const section = sectionAcross(core, c, dir);
      const top = Math.max(...crossingsAtCentre(section).filter((z) => z < 0.5));
      const depth = Math.max(0, -top);
      expect(depth, `${label}: depth never shrinks toward the fix point (sample ${i})`).toBeGreaterThanOrEqual(previous - 0.02);
      expect(depth - previous, `${label}: depth grows smoothly, no step (sample ${i})`).toBeLessThan(0.5);
      previous = depth;
      reached = Math.max(reached, depth);
      // Wherever it cuts, the floor is the bore's bottom right under the cable.
      const boreBottom = c.z - R * Math.hypot(1, slope);
      if (depth > 0.05) expectNear(top, boreBottom, `${label}: the floor follows the cable (sample ${i})`);

      if (Math.abs(c.z - zChannel) < 1e-4) {
        // Lying level in the channel: a round bore, d + tolerance across.
        levelChecked++;
        for (const k of [0.1, 0.4, 0.7, 0.85]) {
          const gap = gapAt(section, c.z - R * k);
          const half = R * Math.sqrt(1 - k * k);
          expectNear(gap.right, half, `${label}: round bottom at ${k} R below the centre (sample ${i})`);
          expectNear(-gap.left, half, `${label}: round bottom at ${k} R below the centre (sample ${i})`);
        }
      }
    }
    expectNear(reached, channelDepth + d.spec.tolerance / 2, `${label}: full depth, to the bore's bottom`);
    expect(levelChecked, `${label}: some level samples checked`).toBeGreaterThanOrEqual(2);

    // The clip: the opening at the face is narrower than the cable; just
    // outside it the channel is open to its full width.
    const mid = { x: (clip.from.x + clip.to.x) / 2, y: (clip.from.y + clip.to.y) / 2 };
    let best = 0;
    for (let i = 0; i < n; i++) if (Math.hypot(lead[i * 3] - mid.x, lead[i * 3 + 1] - mid.y) < Math.hypot(lead[best * 3] - mid.x, lead[best * 3 + 1] - mid.y)) best = i;
    const inClip = sectionAcross(core, sample(lead, best), tangentAt(lead, best).dir);
    // Issue: the base clip's own opening, a few percent under the cable, with
    // a short vertical land above the bore and a 45 degree funnel above that.
    const fraction = clip.opening / (2 * R);
    // From the cable's own height there: the lips may start while it settles the last CABLE_CLIP_DEPTH_SLACK into
    // the channel, which a slim flange (issue #239) puts under the clip's middle.
    const edge = sample(lead, best).z + Math.sqrt(R * R - (fraction * R) ** 2);
    const opening = gapAt(inClip, edge + CABLE_BASE_CLIP_LAND / 2);
    expectNear(opening.right - opening.left, 2 * fraction * R, `${label}: clip opening`);
    expect(opening.right - opening.left, `${label}: the cable has to snap in`).toBeLessThan(d.spec.wire.diameter);
    expect(opening.right - opening.left, `${label}: a stiff cable needs only a little interference`).toBeGreaterThan(0.85 * d.spec.wire.diameter);
    const mouth = gapAt(inClip, edge + CABLE_BASE_CLIP_LAND + 0.1);
    expectNear(mouth.right - mouth.left, 2 * fraction * R + 0.2, `${label}: the funnel flares at 45 degrees above the land`);
    const face = gapAt(inClip, -0.01);
    expect(face.right - face.left, `${label}: the funnel widens the opening toward the face`).toBeGreaterThan(opening.right - opening.left + 0.1);
    // Below the lips the bore is the full d + tolerance again.
    const belly = gapAt(inClip, zChannel);
    expectNear(belly.right - belly.left, 2 * R, `${label}: bore under the lips`);
    // Both lips stay inside the rim, with a wall of flange behind them.
    expect(outlineOffsetAt(outline, clip.to.x, clip.to.y).offset + R + CABLE_CLIP_WALL).toBeLessThanOrEqual(margin + 1e-6);
  } finally {
    core.delete();
  }
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
    const neck = rimSlotNeckWidth(slot);
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

describe("cable fix points: round, gradually deepening channel, clip along the cable (issue #117) and rim slots (issue #241)", () => {
  it("the user's repro (stiff 3.6 mm, 132 mm round core, 3 layers, cap off, keyhole mount)", async () => {
    const parsed = parseHash("#s=eyJ2IjoyLCJMIjozNzEwLCJkIjozLjYsInd0Ijoic3RpZmYiLCJzaXplIjoxMzIsImx5IjozLCJjYXAiOiJvZmYiLCJtb3VudCI6ImtleWhvbGUifQ");
    const d = await design(parsed!.spec);
    checkInnerEnd(d, "repro");
    checkRimSlots(d, "repro");
    const withCap = await design({ ...parsed!.spec, topCap: "on" });
    checkRimSlots(withCap, "repro, cap on");
  });

  for (const shape of SHAPES) {
    for (const { type, diameter } of TYPES) {
      for (const topCap of ["on", "off"] as const) {
        it(`shape=${shape.kind} type=${type} cap=${topCap}`, async () => {
          const d = await design(baseSpec({ shape, wire: { length: 3000, diameter, type }, topCap }));
          checkInnerEnd(d, `${shape.kind}/${type}/cap-${topCap}`);
          checkRimSlots(d, `${shape.kind}/${type}/cap-${topCap}`);
        });
      }
    }
  }

  it("a thick 8 mm cord gets the same round channel and clip", async () => {
    const d = await design(baseSpec({ wire: { length: 2000, diameter: 8, type: "stiff" }, coreSize: { locked: true, dimension: "outer", value: 60 }, layers: { locked: true, value: 1 }, topCap: "on" }));
    checkInnerEnd(d, "8 mm cord");
    checkRimSlots(d, "8 mm cord");
  });
});
