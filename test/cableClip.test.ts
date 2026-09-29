import Module from "manifold-3d";
import type { ManifoldToplevel } from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import { design, parseHash } from "../src/core";
import type { CoilSpec, Design, ShapeSpec, WireTypeId } from "../src/core";
// The SAME shared layout functions every backend cuts from (see
// test/innerEnd.test.ts's own note), used here only to know WHERE along the
// cable to look; what is checked is the real, cut mesh.
import { capCableZ, clipLength, layoutInnerEnd, resolveChannelDepth } from "../src/core/innerEnd";
import { CABLE_CLIP_OPENING_FRACTION, CABLE_CLIP_WALL, CAP_CLIP_LIP } from "../src/core/constants";
import { outlineOffsetAt } from "../src/core/shapes";
import { bendMultiplierOf } from "../src/core/types";

// Issue #117: the cable's fix points. The bottom flange's channel must be
// round (a bore of about d + tolerance around the cable), its depth must
// follow the cable's own drop smoothly (no fixed-depth box, no square
// corners), and near the rim the cable snaps into a clip whose opening is
// narrower than the cable. The top cap's clip is the same bore, opening
// down. Checked on the actual meshes, sliced across the cable.

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

function layoutOf(d: Design) {
  const bendRadius = bendMultiplierOf(d.spec.wire) * d.spec.wire.diameter;
  const channelDepth = resolveChannelDepth(d.spec.wire.diameter, d.flangeSpec.thickness, d.spec.mount);
  return { layout: layoutInnerEnd(d.flangeSpec.outline, d.flangeSpec.margin, d.spec.wire.diameter, d.spec.tolerance, bendRadius, channelDepth), channelDepth };
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
  const { layout, channelDepth } = layoutOf(d);
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
      // Clear of the wall (where the cut is clipped away) and inside the rim.
      if (offset < 1.5 || offset > margin - R - 0.5) continue;
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
    const mid = { x: (layout.clip.from.x + layout.clip.to.x) / 2, y: (layout.clip.from.y + layout.clip.to.y) / 2 };
    let best = 0;
    for (let i = 0; i < n; i++) if (Math.hypot(lead[i * 3] - mid.x, lead[i * 3 + 1] - mid.y) < Math.hypot(lead[best * 3] - mid.x, lead[best * 3 + 1] - mid.y)) best = i;
    const inClip = sectionAcross(core, sample(lead, best), tangentAt(lead, best).dir);
    const opening = gapAt(inClip, -0.2);
    expectNear(opening.right - opening.left, 2 * CABLE_CLIP_OPENING_FRACTION * R, `${label}: clip opening`);
    expect(opening.right - opening.left, `${label}: the cable has to snap in`).toBeLessThan(d.spec.wire.diameter);
    // Below the lips the bore is the full d + tolerance again.
    const belly = gapAt(inClip, zChannel);
    expectNear(belly.right - belly.left, 2 * R, `${label}: bore under the lips`);
    // Both lips stay inside the rim, with a wall of flange behind them.
    expect(outlineOffsetAt(outline, layout.clip.to.x, layout.clip.to.y).offset + R + CABLE_CLIP_WALL).toBeLessThanOrEqual(margin + 1e-6);
  } finally {
    core.delete();
  }
}

/** The top cap's clip, sliced across the cable at its middle. */
function checkCapEnd(d: Design, label: string) {
  const clip = d.capClip!;
  expect(clip, `${label}: cap clip`).toBeDefined();
  const R = (d.spec.wire.diameter + d.spec.tolerance) / 2;
  const cap = toManifold(d.parts.find((p) => p.role === "topCap")!.mesh);
  try {
    const at = Math.round(clipLength(d.spec.wire.diameter) / 2 / 0.5);
    const c = clip.path[at];
    const dir = { x: clip.path[at + 1].x - clip.path[at - 1].x, y: clip.path[at + 1].y - clip.path[at - 1].y };
    const section = sectionAcross(cap, c, dir);
    const zc = d.solution.height + capCableZ(d.spec.wire.diameter);
    // Round around the cable, d + tolerance across, down to the lips.
    for (const k of [0.1, 0.3, 0.6]) {
      const gap = gapAt(section, zc - R * k);
      expectNear(gap.right - gap.left, 2 * R * Math.sqrt(1 - k * k), `${label}: cap bore at ${k} R below the centre`);
    }
    // The opening between the lips (facing down, away from the plate) is
    // narrower than the cable.
    const opening = gapAt(section, zc - R * Math.sqrt(1 - CABLE_CLIP_OPENING_FRACTION ** 2) - CAP_CLIP_LIP / 2);
    expectNear(opening.right - opening.left, 2 * CABLE_CLIP_OPENING_FRACTION * R, `${label}: cap clip opening`);
    expect(opening.right - opening.left).toBeLessThan(d.spec.wire.diameter);
    // The drawn cable leaves it past the rim.
    const end = clip.path[clip.path.length - 1];
    expect(outlineOffsetAt(d.flangeSpec.outline, end.x, end.y).offset).toBeGreaterThan(d.flangeSpec.margin);
  } finally {
    cap.delete();
  }
}

const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 10 }, { kind: "tri", cornerRadius: 10 }];
const TYPES: Array<{ type: WireTypeId; diameter: number }> = [
  { type: "usb", diameter: 3.8 },
  { type: "flex", diameter: 2.5 },
  { type: "stiff", diameter: 3.6 },
];

describe("cable fix points: round, gradually deepening channel and clips along the cable (issue #117)", () => {
  it("the user's repro (stiff 3.6 mm, 132 mm round core, 3 layers, cap off, keyhole mount)", async () => {
    const parsed = parseHash("#s=eyJ2IjoyLCJMIjozNzEwLCJkIjozLjYsInd0Ijoic3RpZmYiLCJzaXplIjoxMzIsImx5IjozLCJjYXAiOiJvZmYiLCJtb3VudCI6ImtleWhvbGUifQ");
    const d = await design(parsed!.spec);
    checkInnerEnd(d, "repro");
    const withCap = await design({ ...parsed!.spec, topCap: "on" });
    checkCapEnd(withCap, "repro, cap on");
  });

  for (const shape of SHAPES) {
    for (const { type, diameter } of TYPES) {
      for (const topCap of ["on", "off"] as const) {
        it(`shape=${shape.kind} type=${type} cap=${topCap}`, async () => {
          const d = await design(baseSpec({ shape, wire: { length: 3000, diameter, type }, topCap }));
          checkInnerEnd(d, `${shape.kind}/${type}/cap-${topCap}`);
          if (topCap === "on") checkCapEnd(d, `${shape.kind}/${type}`);
          else expect(d.capClip).toBeUndefined();
        });
      }
    }
  }

  it("a thick 8 mm cord gets the same round channel and clip", async () => {
    const d = await design(baseSpec({ wire: { length: 2000, diameter: 8, type: "stiff" }, coreSize: { locked: true, dimension: "outer", value: 60 }, layers: { locked: true, value: 1 }, topCap: "on" }));
    checkInnerEnd(d, "8 mm cord");
    checkCapEnd(d, "8 mm cord");
  });
});
