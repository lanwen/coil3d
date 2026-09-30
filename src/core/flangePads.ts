// Issue #122: the bottom flange is a thin plate, thick only where a cut needs
// the depth. Pure geometry, shared by the mesh backend (manifold.ts) and the
// STEP backend (step/build.ts) -- the same "one shared layout, several
// consumers" rule as innerEnd.ts and mount.ts -- so the two can't drift.
//
// Which face stays flat: the OUTER (wall-facing, z = -thickness) face. It is
// the face the part prints on, the face every wall mount needs flat against
// the wall (keyhole, through-hole), and the face the SKADIS/openGrid mount
// plate is glued to. So the plate is z = [-thickness, -thickness +
// plateThickness], and the pads rise from its top up to the inner
// (winding-side) face at z = 0 -- growing upwards, so they print with no
// overhang. They all end at z = 0, the face the inner-end channel is flush
// with (the #43 guarantee), so the winding sees the same face as before:
//   - the collar: under the wall and a little beyond it (the wall starts at
//     z = 0 and needs solid flange under it);
//   - the channel pad: along the inner-end channel and clip, to the rim;
//   - a pad around each mount cut that still needs one: the keyhole slot,
//     the mount-plate pin hole. The through-hole mount (issue #129) gets no
//     pad -- a plain hole needs no relief beyond the ordinary plate.
// Every pad has a 45 degree chamfer down to the plate. The wound cable never
// reaches down to the face outside the channel (its first turn starts MARGIN
// above it), so the lower plate top changes nothing for the winding.
//
// The pads are carved out of a "relief" (the slab above the plate top, minus
// the pads), which the backends subtract from the full-thickness flange
// ring before fusing the wall. Each pad is a `SweepSolid` (innerEnd.ts), so
// both backends mesh it from the same rings.

import { CABLE_BRIDGE_STEP, FLANGE_PAD_COLLAR, FLANGE_PAD_COLLAR_COLUMNS, FLANGE_PAD_EMBED, FLANGE_PAD_RISE, FLANGE_PAD_STEP, FLANGE_PAD_WALL, MOUNT_PLATE_PIN_DIAMETER, MOUNT_PLATE_PIN_HOLE_CLEARANCE, SCREW_MOUNT_HEAD_RADIUS } from "./constants";
import type { InnerEndLayout, SweepSolid, XY, XYZ } from "./innerEnd";
import { layoutKeyholeMount } from "./mount";
import { outlineColumnParams, pointAt } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { MountKind } from "./types";

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
  /** "collar": the wall's outline at `offset` (at the face); "stadium": the stadium from `a` to `b` at `radius` (at the face); "channel": only the sweep. Both grow by `offsetAtZ` below the face. */
  shape: { kind: "collar"; offset: number } | { kind: "stadium"; a: XY; b: XY; radius: number } | { kind: "channel" };
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
  return { sweep: { rings: levels.map(ring), start: { ...mid, z: levels[0] }, end: { ...mid, z: levels[levels.length - 1] } }, shape: { kind: "stadium", a, b, radius: r + wall } };
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
  return { sweep: { rings, start: { x: 0, y: 0, z: levels[0] }, end: { x: 0, y: 0, z: levels[levels.length - 1] } }, shape: { kind: "collar", offset: FLANGE_PAD_COLLAR } };
}

/**
 * The channel pad: along the drawn lead-in (through the channel and clip,
 * out past the rim), `FLANGE_PAD_WALL` wider than the channel bore on each
 * side at the face. It follows a coarse polyline of the cable's path
 * (FLANGE_PAD_STEP apart: the path bends gently, far less than the pad wall
 * over that length) with mitred cross-sections, so every face of it is
 * planar -- the STEP backend builds it from those same flat faces (see
 * innerEnd.ts's `sweepMesh` for the ring convention).
 */
function channelPad(innerEnd: InnerEndLayout, zPlate: number): FlangePad {
  // All the way from the groove start, so the face under the cable's whole
  // drop stays at z = 0 and the channel deepens from it with no step.
  const all = [...innerEnd.leadIn].reverse();
  const every = Math.max(1, Math.round(FLANGE_PAD_STEP / CABLE_BRIDGE_STEP));
  const path = all.filter((_, i) => i % every === 0 || i === all.length - 1);
  const half = (z: number) => innerEnd.channelRadius + offsetAtZ(FLANGE_PAD_WALL, z);
  const levels = padLevels(zPlate);
  // Each segment's left normal; each vertex's mitre (where the offset lines
  // of its two segments meet).
  const normals = path.slice(1).map((q, i) => {
    const l = Math.hypot(q.x - path[i].x, q.y - path[i].y);
    return { x: -(q.y - path[i].y) / l, y: (q.x - path[i].x) / l };
  });
  const rings = path.map((p, i) => {
    const n0 = normals[Math.max(0, i - 1)];
    const n1 = normals[Math.min(normals.length - 1, i)];
    const mx = n0.x + n1.x;
    const my = n0.y + n1.y;
    const k = mx * n1.x + my * n1.y;
    const at = (w: number, z: number): XYZ => ({ x: p.x + (mx * w) / k, y: p.y + (my * w) / k, z });
    const [zLo, zFace, zHi] = levels;
    return [at(half(zHi), zHi), at(half(zFace), zFace), at(half(zLo), zLo), at(-half(zLo), zLo), at(-half(zFace), zFace), at(-half(zHi), zHi)];
  });
  const zMid = (levels[0] + levels[2]) / 2;
  return { sweep: { rings, start: { x: path[0].x, y: path[0].y, z: zMid }, end: { x: path[path.length - 1].x, y: path[path.length - 1].y, z: zMid } }, shape: { kind: "channel" } };
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
  if (innerEnd) pads.push(channelPad(innerEnd, zPlate));
  if (flange.mount === "keyhole") {
    for (const slot of layoutKeyholeMount(flange.outline, flange.boreOutline, flange.margin, flange.keyholeRotation).slots) {
      pads.push(stadiumPad(slot.head, slot.shankEnd, SCREW_MOUNT_HEAD_RADIUS, FLANGE_PAD_WALL, zPlate));
    }
  }
  // Issue #129: the through-hole mount gets no pad any more -- it's a
  // plain, constant-radius hole with the flange staying its ordinary plate
  // thickness right up to the hole's own edge, flat on the wall face.
  const pinRadius = MOUNT_PLATE_PIN_DIAMETER / 2 + MOUNT_PLATE_PIN_HOLE_CLEARANCE + tolerance / 2;
  for (const anchor of anchors) pads.push(stadiumPad(anchor, anchor, pinRadius, FLANGE_PAD_WALL, zPlate));
  return pads;
}
