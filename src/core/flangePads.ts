// Issue #122: the bottom flange is a thin plate, thick only where a cut needs
// the depth. Pure geometry, shared by the mesh backend (manifold.ts) and the
// STEP backend (step/build.ts) -- the same "one shared layout, several
// consumers" rule as innerEnd.ts and mount.ts -- so the two can't drift.
//
// Which face stays flat: the OUTER (wall-facing, z = -thickness) face. It is
// the face the part prints on, the face every wall mount needs flat against
// the wall (keyhole, through-hole), the face the SKÅDIS clips' outer jaws
// rest on, and the face the openGrid mount plate is glued to. So the plate is z = [-thickness, -thickness +
// plateThickness], and the pads rise from its top up to the inner
// (winding-side) face at z = 0 -- growing upwards, so they print with no
// overhang. They all end at z = 0, the face the inner-end channel is flush
// with (the #43 guarantee), so the winding sees the same face as before:
//   - the collar: under the wall and a little beyond it (the wall starts at
//     z = 0 and needs solid flange under it);
//   - the channel pad: along the inner-end channel and clip, to the rim,
//     blending smoothly into the collar at both sides (issue #133);
//   - a pad around each mount cut that still needs one: the keyhole slot,
//     the mount-plate pin hole, the rim under each SKÅDIS clip's jaws
//     (issue #207). The through-hole mount (issue #129) gets no
//     pad -- a plain hole needs no relief beyond the ordinary plate.
// Every pad has a 45 degree chamfer down to the plate. The wound cable never
// reaches down to the face outside the channel (its first turn starts MARGIN
// above it), so the lower plate top changes nothing for the winding.
//
// The pads are carved out of a "relief" (the slab above the plate top, minus
// the pads), which the backends subtract from the full-thickness flange
// ring before fusing the wall. Each pad is a `SweepSolid` (innerEnd.ts), so
// both backends mesh it from the same rings.

import { CABLE_BRIDGE_STEP, DEFAULT_THROUGH_HOLE_DIAMETER, FLANGE_PAD_BLEND_BURY, FLANGE_PAD_BLEND_RADIUS, FLANGE_PAD_BLEND_STEP, FLANGE_PAD_COLLAR, FLANGE_PAD_COLLAR_COLUMNS, FLANGE_PAD_EMBED, FLANGE_PAD_RISE, FLANGE_PAD_STEP, FLANGE_PAD_WALL, SCREW_MOUNT_HEAD_RADIUS } from "./constants";
import { pegHoleRadius } from "./mountPlate";
import type { InnerEndLayout, SweepSolid, XY, XYZ } from "./innerEnd";
import { layoutKeyholeMount, layoutThroughHoleMount } from "./mount";
import type { ThroughMountLayout } from "./mount";
import { offsetPerimeter, outlineColumnParams, outlineOffsetAt, pointAt } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { MountKind } from "./types";
import type { SkadisClipLayout } from "./skadisClips";
import type { SkadisTclipLayout } from "./skadisTclips";

/** The parts of manifold.ts's `FlangeSpec` the pads read. */
export interface PaddedFlange {
  outline: ShapeOutline;
  boreOutline: ShapeOutline;
  margin: number;
  thickness: number;
  plateThickness?: number;
  columns: number;
  minCornerSegments: number;
  mount: MountKind;
  keyholeRotation?: number;
  throughHoleDiameter?: number;
  envelopeRadius?: number;
  skadis?: SkadisClipLayout;
  skadisTclip?: SkadisTclipLayout;
}

/** The plate's top face (z): the pads rise from here to z = 0. Undefined when the plate is (nearly) full thickness, so there's nothing to relieve. */
export function plateTopZ(flange: Pick<PaddedFlange, "thickness" | "plateThickness">): number | undefined {
  const plate = Math.min(flange.plateThickness ?? flange.thickness, flange.thickness);
  return flange.thickness - plate > 1e-6 ? -flange.thickness + plate : undefined;
}

/** A pad's footprint offset at height z: `wall` at the face (z >= 0), growing 45 degrees down to the plate top, and on below it into the plate. */
export function offsetAtZ(wall: number, z: number): number {
  return wall + Math.max(0, -z);
}

/** The z levels every pad's rings sit at: just inside the plate, the inner face, and a little above it (so the relief never has a face on z = 0). */
export function padLevels(zPlate: number): number[] {
  return [zPlate - FLANGE_PAD_EMBED, 0, FLANGE_PAD_RISE];
}

/**
 * One pad: its `sweep` (the mesh backend's, and the STEP backend's channel
 * pad), and what it is, so the STEP backend can build the collar and the
 * round pads from exact curves instead (far fewer faces for OCCT to test
 * against the wall's B-spline surface when it fuses the two).
 */
export interface FlangePad {
  sweep: SweepSolid;
  /** Its outline at its lowest level, inside the plate (its widest: FLANGE_PAD_EMBED past the chamfer's foot on the plate's top), a closed polygon in plan. */
  footprint: XY[];
  /** "collar": the wall's outline at `offset` (at the face); "stadium": the stadium from `a` to `b` at `radius` (at the face) -- both grow by `offsetAtZ` below the face; "sweep" (the channel pad and its fillet, issue #133): only the sweep. */
  shape: { kind: "collar"; offset: number } | { kind: "stadium"; a: XY; b: XY; radius: number } | { kind: "sweep" };
}

/** A pad around the stadium from `a` to `b` (a circle when they coincide), keeping `wall` of material beyond radius `r`. */
function stadiumPad(a: XY, b: XY, r: number, wall: number, zPlate: number): FlangePad {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const vx = len > 1e-9 ? (b.x - a.x) / len : 1;
  const vy = len > 1e-9 ? (b.y - a.y) / len : 0;
  const base = Math.atan2(vy, vx);
  const K = 12;
  const ring = (z: number): XYZ[] => {
    const rr = r + offsetAtZ(wall, z);
    const pts: XYZ[] = [];
    if (len <= 1e-9) {
      for (let i = 0; i < 2 * K; i++) pts.push({ x: a.x + rr * Math.cos((Math.PI * i) / K), y: a.y + rr * Math.sin((Math.PI * i) / K), z });
      return pts;
    }
    for (let i = 0; i <= K; i++) {
      const phi = base - Math.PI / 2 + (Math.PI * i) / K;
      pts.push({ x: b.x + rr * Math.cos(phi), y: b.y + rr * Math.sin(phi), z });
    }
    for (let i = 0; i <= K; i++) {
      const phi = base + Math.PI / 2 + (Math.PI * i) / K;
      pts.push({ x: a.x + rr * Math.cos(phi), y: a.y + rr * Math.sin(phi), z });
    }
    return pts;
  };
  const levels = padLevels(zPlate);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const rings = levels.map(ring);
  return { sweep: { rings, start: { ...mid, z: levels[0] }, end: { ...mid, z: levels[levels.length - 1] } }, footprint: rings[0], shape: { kind: "stadium", a, b, radius: r + wall } };
}

/** The collar: the wall's own outline, `FLANGE_PAD_COLLAR` beyond it at the face. Covers the bore too (the ring has none there to cut). */
function collarPad(flange: PaddedFlange, zPlate: number): FlangePad {
  const ts = outlineColumnParams(flange.outline, FLANGE_PAD_COLLAR_COLUMNS, flange.minCornerSegments);
  const levels = padLevels(zPlate);
  const rings = levels.map((z) =>
    ts.map((t) => {
      const p = pointAt(flange.outline, t, offsetAtZ(FLANGE_PAD_COLLAR, z));
      return { x: p.x, y: p.y, z };
    }),
  );
  return { sweep: { rings, start: { x: 0, y: 0, z: levels[0] }, end: { x: 0, y: 0, z: levels[levels.length - 1] } }, footprint: rings[0], shape: { kind: "collar", offset: FLANGE_PAD_COLLAR } };
}

/**
 * The channel pad: along the drawn lead-in (through the channel and clip,
 * out past the rim), `FLANGE_PAD_WALL` wider than the channel bore on each
 * side at the face. It follows a coarse polyline of the cable's path
 * (FLANGE_PAD_STEP apart: the path bends gently, far less than the pad wall
 * over that length) with mitred cross-sections (see innerEnd.ts's
 * `sweepMesh` for the ring convention; the STEP backend builds it from the
 * same faces).
 *
 * Issue #133: it blends into the collar instead of meeting it at a corner,
 * on both sides (every level of the chamfer the same curve, offset by
 * `offsetAtZ`, so it is still a 45 degree slope rising from the plate --
 * nothing overhangs):
 *   - the wall side, where the pad's edge leaves the collar's in a V: a
 *     fillet (`channelFillet`) fills the V;
 *   - the other side: the pad used to end at the groove start with a flat,
 *     unchamfered end face standing out past the collar. It now runs on
 *     forward along the wall (the "tail"), its outer edge easing down (a
 *     cubic, C1 at both ends) to just inside the collar's.
 */
function channelPads(outline: ShapeOutline, innerEnd: InnerEndLayout, zPlate: number): FlangePad[] {
  // All the way from the groove start, so the face under the cable's whole
  // drop stays at z = 0 and the channel deepens from it with no step.
  const all = [...innerEnd.leadIn].reverse();
  const every = Math.max(1, Math.round(FLANGE_PAD_STEP / CABLE_BRIDGE_STEP));
  const path = all.filter((_, i) => i % every === 0 || i === all.length - 1);
  const W = innerEnd.channelRadius + FLANGE_PAD_WALL;
  const levels = padLevels(zPlate);
  const [zLo, zFace, zHi] = levels;
  // The blends' radius at the face: FLANGE_PAD_BLEND_RADIUS still left at the chamfer's foot.
  const rho = FLANGE_PAD_BLEND_RADIUS + offsetAtZ(0, zPlate);
  // Each segment's left normal; each vertex's mitre (where the offset lines
  // of its two segments meet).
  const normals = path.slice(1).map((q, i) => {
    const l = Math.hypot(q.x - path[i].x, q.y - path[i].y);
    return { x: -(q.y - path[i].y) / l, y: (q.x - path[i].x) / l };
  });
  const mitres = path.map((_, i) => {
    const n0 = normals[Math.max(0, i - 1)];
    const n1 = normals[Math.min(normals.length - 1, i)];
    const mx = n0.x + n1.x;
    const my = n0.y + n1.y;
    const k = mx * n1.x + my * n1.y;
    return { x: mx / k, y: my / k };
  });
  // Which side of the path faces away from the wall: +1 when the left one does.
  const j = path[0];
  const nJ = outlineOffsetAt(outline, j.x, j.y);
  const sigma = normals[0].x * nJ.nx + normals[0].y * nJ.ny >= 0 ? 1 : -1;
  /** The pad's edge at vertex i, on the outer (+1) or wall (-1) side, at height z. */
  const edgeAt = (i: number, side: 1 | -1, z: number): XY => {
    const w = side * sigma * offsetAtZ(W, z);
    return { x: path[i].x + mitres[i].x * w, y: path[i].y + mitres[i].y * w };
  };
  // Left (+m) side first, as `sweepMesh` expects every ring the same way round.
  const ringOf = (outer: (z: number) => XY, inner: (z: number) => XY): XYZ[] => {
    const left = sigma > 0 ? outer : inner;
    const right = sigma > 0 ? inner : outer;
    const at = (f: (z: number) => XY, z: number): XYZ => ({ ...f(z), z });
    return [at(left, zHi), at(left, zFace), at(left, zLo), at(right, zLo), at(right, zFace), at(right, zHi)];
  };
  const mainRings = path.map((_, i) =>
    ringOf(
      (z) => edgeAt(i, 1, z),
      (z) => edgeAt(i, -1, z),
    ),
  );

  // The tail: forward along the outline from the groove start (outline
  // parameter 0, where the helix starts climbing), each section across the
  // outline's own normal -- at the groove start, the path's too (the lead-in
  // leaves along the helix's own tangent). The outer edge eases from the
  // pad's (value and slope) down to a little inside the collar's, over a
  // length that keeps its concave end's radius near `rho` (a cubic easing a
  // drop D over T bends at about T^2 / (6 D)). It ends 2 FLANGE_PAD_BLEND_BURY
  // inside, so it crosses the collar's edge at a small angle, once -- never
  // grazing along it, where the collar's own sampled polygon would cut it
  // into slivers. Its other edge is the wall's outline, under the collar.
  const offsetOf = (q: XY) => outlineOffsetAt(outline, q.x, q.y).offset;
  const h0 = offsetOf(edgeAt(0, 1, zFace));
  const first = Math.hypot(path[1].x - j.x, path[1].y - j.y);
  const slope0 = -(offsetOf(edgeAt(1, 1, zFace)) - h0) / first; // per mm going forward, continuing the pad's edge
  const tip = FLANGE_PAD_COLLAR - 2 * FLANGE_PAD_BLEND_BURY;
  const D = h0 - tip;
  const tailRings: XYZ[][] = [];
  if (D > 1e-3) {
    const T = Math.sqrt(6 * rho * D);
    // Cubic Hermite from (0, h0, slope0) to (T, tip, 0).
    const edge = (tau: number) => {
      const x = tau / T;
      const h00 = 2 * x ** 3 - 3 * x ** 2 + 1;
      const h10 = x ** 3 - 2 * x ** 2 + x;
      return h00 * h0 + h10 * T * slope0 + (1 - h00) * tip;
    };
    // March along the outline (at the collar's offset) by arc length.
    const dt = 0.05 / offsetPerimeter(outline, FLANGE_PAD_COLLAR);
    let t = 0;
    let tau = 0;
    let prev = pointAt(outline, 0, FLANGE_PAD_COLLAR);
    for (let k = 1; k * FLANGE_PAD_BLEND_STEP < T + FLANGE_PAD_BLEND_STEP - 1e-6; k++) {
      const target = Math.min(T, k * FLANGE_PAD_BLEND_STEP);
      while (tau < target - 1e-9) {
        t += dt;
        const q = pointAt(outline, t, FLANGE_PAD_COLLAR);
        tau += Math.hypot(q.x - prev.x, q.y - prev.y);
        prev = q;
      }
      const g = edge(Math.min(tau, T));
      const at = t;
      tailRings.unshift(
        ringOf(
          (z) => pointAt(outline, at, offsetAtZ(g, z)),
          (z) => pointAt(outline, at, offsetAtZ(0, z)),
        ),
      );
    }
  }

  const rings = [...tailRings, ...mainRings];
  const zMid = (zLo + zHi) / 2;
  const centre = (r: XYZ[]): XYZ => ({ x: r.reduce((a, q) => a + q.x, 0) / r.length, y: r.reduce((a, q) => a + q.y, 0) / r.length, z: zMid });
  // Each ring's two points at zLo (see `ringOf`): down one side and back up the other.
  const footprint = [...rings.map((r) => r[2]), ...rings.map((r) => r[3]).reverse()];
  const pad: FlangePad = { sweep: { rings, start: centre(rings[0]), end: { x: path[path.length - 1].x, y: path[path.length - 1].y, z: zMid } }, footprint, shape: { kind: "sweep" } };
  const fillet = channelFillet(
    outline,
    path.map((_, i) => (z: number) => edgeAt(i, -1, z)),
    mitres.map((m) => ({ x: -sigma * m.x, y: -sigma * m.y })),
    levels,
    rho,
  );
  return fillet ? [pad, fillet] : [pad];
}

/**
 * Issue #133: the fillet in the V between the channel pad's wall-side edge
 * (`edge[i](z)`, a polyline running out from the groove start, `away[i]` its
 * direction away from the pad) and the collar, where the first leaves the
 * second. In plan it is a circle of radius `rho` at the face,
 * touching both -- or rather dipping FLANGE_PAD_BLEND_BURY into each, so it
 * crosses them (at a hair of an angle) instead of only touching them, which
 * no boolean likes. Lower down the chamfer the same circle shrinks by as
 * much as both edges grow (`offsetAtZ`), so it stays concentric and dips in
 * just as far at every level: the fillet's own face is a 45 degree cone.
 * Each level's section is that arc, closed through a point inside both the
 * pad and the collar; the solid lofts them (every face between two levels'
 * arcs is planar, a strip of the cone). Undefined when the pad never leaves
 * the collar.
 */
function channelFillet(outline: ShapeOutline, edge: Array<(z: number) => XY>, away: XY[], levels: number[], rho: number): FlangePad | undefined {
  const zFace = levels[1];
  const bury = FLANGE_PAD_BLEND_BURY;
  const collar = (z: number) => offsetAtZ(FLANGE_PAD_COLLAR, z);
  const offsetOf = (q: XY) => outlineOffsetAt(outline, q.x, q.y).offset;
  const lerp = (a: XY, b: XY, f: number): XY => ({ x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) });
  /** The first point along the polyline (segment index + fraction) where `value` turns positive. */
  const firstPositive = (value: (i: number, f: number) => number): { i: number; f: number } | undefined => {
    for (let i = 0; i + 1 < edge.length; i++) {
      if (value(i, 1) <= 0) continue;
      if (value(i, 0) > 0) return i === 0 ? undefined : { i, f: 0 };
      let lo = 0;
      let hi = 1;
      for (let k = 0; k < 50; k++) {
        const mid = (lo + hi) / 2;
        if (value(i, mid) > 0) hi = mid;
        else lo = mid;
      }
      return { i, f: hi };
    }
    return undefined;
  };
  const awayAt = (i: number, f: number): XY => {
    const d = lerp(away[i], away[i + 1], f);
    const l = Math.hypot(d.x, d.y);
    return { x: d.x / l, y: d.y / l };
  };
  // The centre: `rho - bury` out from the edge and from the collar.
  const centreOn = (i: number, f: number): XY => {
    const p = lerp(edge[i](zFace), edge[i + 1](zFace), f);
    const d = awayAt(i, f);
    return { x: p.x + d.x * (rho - bury), y: p.y + d.y * (rho - bury) };
  };
  const hit = firstPositive((i, f) => offsetOf(centreOn(i, f)) - (collar(zFace) + rho - bury));
  if (!hit) return undefined;
  const O = centreOn(hit.i, hit.f);
  const toCollar = outlineOffsetAt(outline, O.x, O.y);
  const toPad = awayAt(hit.i, hit.f);
  // The arc runs from straight towards the collar to straight towards the
  // pad's edge, the short way round (through the V).
  const a0 = Math.atan2(-toCollar.ny, -toCollar.nx);
  let a1 = Math.atan2(-toPad.y, -toPad.x);
  while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
  while (a1 - a0 < -Math.PI) a1 += 2 * Math.PI;
  const steps = Math.max(4, Math.ceil((Math.abs(a1 - a0) * rho) / FLANGE_PAD_BLEND_STEP));
  const rings = levels.map((z) => {
    const r = rho - offsetAtZ(0, z);
    const arc: XYZ[] = Array.from({ length: steps + 1 }, (_, k) => {
      const a = a0 + ((a1 - a0) * k) / steps;
      return { x: O.x + r * Math.cos(a), y: O.y + r * Math.sin(a), z };
    });
    // The V's corner at this level (where the edge leaves the collar),
    // pushed a millimetre on into both.
    const v = firstPositive((i, f) => offsetOf(lerp(edge[i](z), edge[i + 1](z), f)) - collar(z));
    const corner = v ? lerp(edge[v.i](z), edge[v.i + 1](z), v.f) : edge[0](z);
    const dx = corner.x - O.x;
    const dy = corner.y - O.y;
    const l = Math.hypot(dx, dy);
    return [...arc, { x: corner.x + dx / l, y: corner.y + dy / l, z }];
  });
  // Fan centres: between the corner and the arc's middle.
  const mid = (ring: XYZ[]): XYZ => {
    const c = ring[ring.length - 1];
    const m = ring[steps >> 1];
    return { x: (c.x + m.x) / 2, y: (c.y + m.y) / 2, z: c.z };
  };
  return { sweep: { rings, start: mid(rings[0]), end: mid(rings[rings.length - 1]) }, footprint: rings[0], shape: { kind: "sweep" } };
}

/**
 * Every pad of this flange (empty when the plate is full thickness -- see
 * `plateTopZ`). `innerEnd` is the layout the channel was cut from (no channel
 * pad without one); `anchors`
 * the mount plate's pin holes (none unless the plate was built), with the
 * print tolerance they were cut at.
 */
export function layoutFlangePads(flange: PaddedFlange, innerEnd: InnerEndLayout | undefined, anchors: XY[] = [], tolerance = 0): FlangePad[] {
  const zPlate = plateTopZ(flange);
  if (zPlate === undefined) return [];
  const pads = [collarPad(flange, zPlate)];
  if (innerEnd) pads.push(...channelPads(flange.outline, innerEnd, zPlate));
  if (flange.mount === "keyhole") {
    for (const slot of layoutKeyholeMount(flange.outline, flange.boreOutline, flange.margin, flange.keyholeRotation).slots) {
      pads.push(stadiumPad(slot.head, slot.shankEnd, SCREW_MOUNT_HEAD_RADIUS, FLANGE_PAD_WALL, zPlate));
    }
  }
  // Issue #129: the through-hole mount gets no pad any more -- it's a
  // plain, constant-radius hole with the flange staying its ordinary plate
  // thickness right up to the hole's own edge, flat on the wall face.
  for (const anchor of anchors) pads.push(stadiumPad(anchor, anchor, pegHoleRadius(tolerance), FLANGE_PAD_WALL, zPlate));
  // Issue #207: full thickness under each SKÅDIS clip's jaws, so the rim the
  // clip grips is as thick as the flange, not just its plate.
  for (const pad of flange.skadis?.pads ?? []) pads.push(stadiumPad(pad.a, pad.b, pad.radius, FLANGE_PAD_WALL, zPlate));
  // Issue #213: full thickness where a T-clip's lug overlaps the flange.
  for (const pad of flange.skadisTclip?.pads ?? []) pads.push(stadiumPad(pad.a, pad.b, pad.radius, FLANGE_PAD_WALL, zPlate));
  return pads;
}

/**
 * Issue #139: the through-hole mount's layout (mount.ts's
 * `layoutThroughHoleMount`), kept clear of the inner-end channel and of
 * every pad's footprint -- the collar, and the channel pad with its fillet
 * and tail -- so each screw head sits on the plain plate. design.ts and both
 * backends call this, so they cut the same holes.
 */
export function layoutFlangeThroughHoles(flange: PaddedFlange, innerEnd: InnerEndLayout | undefined): ThroughMountLayout {
  const pads = layoutFlangePads(flange, innerEnd).map((pad) => pad.footprint);
  return layoutThroughHoleMount(
    flange.outline,
    flange.boreOutline,
    flange.margin,
    flange.throughHoleDiameter ?? DEFAULT_THROUGH_HOLE_DIAMETER,
    { channelRibbon: innerEnd?.channelRibbon ?? [], pads },
    flange.envelopeRadius ?? 0,
  );
}
