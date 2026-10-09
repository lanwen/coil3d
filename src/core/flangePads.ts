import { CABLE_BRIDGE_STEP, DEFAULT_THROUGH_HOLE_DIAMETER, FLANGE_PAD_BLEND_BURY, FLANGE_PAD_BLEND_RADIUS, FLANGE_PAD_BLEND_STEP, FLANGE_PAD_COLLAR, FLANGE_PAD_COLLAR_COLUMNS, FLANGE_PAD_EMBED, FLANGE_PAD_RISE, FLANGE_PAD_STEP, FLANGE_PAD_WALL, SCREW_MOUNT_HEAD_RADIUS } from "./constants";
import { pegHoleRadius } from "./mountPlate";
import type { InnerEndLayout, SweepSolid, XY, XYZ } from "./innerEnd";
import { layoutKeyholeMount, layoutThroughHoleMount } from "./mount";
import type { ThroughMountLayout } from "./mount";
import { circumscribedRadius, offsetPerimeter, outlineColumnParams, outlineOffsetAt, pointAt } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { MountKind } from "./types";

const STADIUM_ARC_SEGMENTS = 12;
const TAIL_ARC_SAMPLE_STEP = 0.05;
const TAIL_TIP_BURY_FACTOR = 2;
const COINCIDENT_EPSILON = 1e-9;
const MIN_PLATE_RELIEF = 1e-6;
const MIN_TAIL_DROP = 1e-3;
const TAIL_STEP_EPSILON = 1e-6;
const FILLET_ROOT_ITERATIONS = 50;
const FILLET_CORNER_PUSH = 1;
const MIN_FILLET_STEPS = 4;

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
}

export function plateTopZ(flange: Pick<PaddedFlange, "thickness" | "plateThickness">): number | undefined {
  const plate = Math.min(flange.plateThickness ?? flange.thickness, flange.thickness);
  return flange.thickness - plate > MIN_PLATE_RELIEF ? -flange.thickness + plate : undefined;
}

export function offsetAtZ(wall: number, z: number): number {
  return wall + Math.max(0, -z);
}

export function padLevels(zPlate: number): number[] {
  return [zPlate - FLANGE_PAD_EMBED, 0, FLANGE_PAD_RISE];
}

export interface FlangePad {
  sweep: SweepSolid;
  footprint: XY[];
  shape: { kind: "collar"; offset: number } | { kind: "stadium"; a: XY; b: XY; radius: number } | { kind: "sweep" };
}

function stadiumPad(a: XY, b: XY, r: number, wall: number, zPlate: number): FlangePad {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const vx = len > COINCIDENT_EPSILON ? (b.x - a.x) / len : 1;
  const vy = len > COINCIDENT_EPSILON ? (b.y - a.y) / len : 0;
  const base = Math.atan2(vy, vx);
  const K = STADIUM_ARC_SEGMENTS;
  const ring = (z: number): XYZ[] => {
    const rr = r + offsetAtZ(wall, z);
    const pts: XYZ[] = [];
    if (len <= COINCIDENT_EPSILON) {
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

function collarPad(flange: PaddedFlange, zPlate: number): FlangePad {
  const r = circumscribedRadius(flange.outline, FLANGE_PAD_COLLAR);
  const columns = Math.max(FLANGE_PAD_COLLAR_COLUMNS, Math.ceil(Math.PI / Math.acos(1 - FLANGE_PAD_BLEND_BURY / 3 / r)));
  const ts = outlineColumnParams(flange.outline, columns, flange.minCornerSegments);
  const levels = padLevels(zPlate);
  const rings = levels.map((z) =>
    ts.map((t) => {
      const p = pointAt(flange.outline, t, offsetAtZ(FLANGE_PAD_COLLAR, z));
      return { x: p.x, y: p.y, z };
    }),
  );
  return { sweep: { rings, start: { x: 0, y: 0, z: levels[0] }, end: { x: 0, y: 0, z: levels[levels.length - 1] } }, footprint: rings[0], shape: { kind: "collar", offset: FLANGE_PAD_COLLAR } };
}

function channelPads(outline: ShapeOutline, innerEnd: InnerEndLayout, zPlate: number): FlangePad[] {
  const leadInFromGrooveStart = [...innerEnd.leadIn].reverse();
  const pathStride = Math.max(1, Math.round(FLANGE_PAD_STEP / CABLE_BRIDGE_STEP));
  const path = leadInFromGrooveStart.filter((_, i) => i % pathStride === 0 || i === leadInFromGrooveStart.length - 1);
  const halfWidthAtFace = innerEnd.channelRadius + FLANGE_PAD_WALL;
  const levels = padLevels(zPlate);
  const [zLo, zFace, zHi] = levels;
  const blendRadius = FLANGE_PAD_BLEND_RADIUS + offsetAtZ(0, zPlate);
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
  const grooveStart = path[0];
  const grooveStartNormal = outlineOffsetAt(outline, grooveStart.x, grooveStart.y);
  const outerSide = normals[0].x * grooveStartNormal.nx + normals[0].y * grooveStartNormal.ny >= 0 ? 1 : -1;
  const edgeAt = (i: number, side: 1 | -1, z: number): XY => {
    const w = side * outerSide * offsetAtZ(halfWidthAtFace, z);
    return { x: path[i].x + mitres[i].x * w, y: path[i].y + mitres[i].y * w };
  };
  const ringOf = (outer: (z: number) => XY, inner: (z: number) => XY): XYZ[] => {
    const left = outerSide > 0 ? outer : inner;
    const right = outerSide > 0 ? inner : outer;
    const at = (f: (z: number) => XY, z: number): XYZ => ({ ...f(z), z });
    return [at(left, zHi), at(left, zFace), at(left, zLo), at(right, zLo), at(right, zFace), at(right, zHi)];
  };
  const mainRings = path.map((_, i) =>
    ringOf(
      (z) => edgeAt(i, 1, z),
      (z) => edgeAt(i, -1, z),
    ),
  );

  const offsetOf = (q: XY) => outlineOffsetAt(outline, q.x, q.y).offset;
  const edgeOffsetAtStart = offsetOf(edgeAt(0, 1, zFace));
  const firstSegmentLength = Math.hypot(path[1].x - grooveStart.x, path[1].y - grooveStart.y);
  const edgeSlopeAtStart = -(offsetOf(edgeAt(1, 1, zFace)) - edgeOffsetAtStart) / firstSegmentLength;
  const tailTipOffset = FLANGE_PAD_COLLAR - TAIL_TIP_BURY_FACTOR * FLANGE_PAD_BLEND_BURY;
  const tailDrop = edgeOffsetAtStart - tailTipOffset;
  const tailRings: XYZ[][] = [];
  if (tailDrop > MIN_TAIL_DROP) {
    const tailLength = Math.sqrt(6 * blendRadius * tailDrop);
    const tailEdgeAt = (arc: number) => {
      const x = arc / tailLength;
      const h00 = 2 * x ** 3 - 3 * x ** 2 + 1;
      const h10 = x ** 3 - 2 * x ** 2 + x;
      return h00 * edgeOffsetAtStart + h10 * tailLength * edgeSlopeAtStart + (1 - h00) * tailTipOffset;
    };
    const paramStep = TAIL_ARC_SAMPLE_STEP / offsetPerimeter(outline, FLANGE_PAD_COLLAR);
    let t = 0;
    let tailArc = 0;
    let prev = pointAt(outline, 0, FLANGE_PAD_COLLAR);
    for (let k = 1; k * FLANGE_PAD_BLEND_STEP < tailLength + FLANGE_PAD_BLEND_STEP - TAIL_STEP_EPSILON; k++) {
      const target = Math.min(tailLength, k * FLANGE_PAD_BLEND_STEP);
      while (tailArc < target - COINCIDENT_EPSILON) {
        t += paramStep;
        const q = pointAt(outline, t, FLANGE_PAD_COLLAR);
        tailArc += Math.hypot(q.x - prev.x, q.y - prev.y);
        prev = q;
      }
      const tailEdgeOffset = tailEdgeAt(Math.min(tailArc, tailLength));
      const at = t;
      tailRings.unshift(
        ringOf(
          (z) => pointAt(outline, at, offsetAtZ(tailEdgeOffset, z)),
          (z) => pointAt(outline, at, offsetAtZ(0, z)),
        ),
      );
    }
  }

  const rings = [...tailRings, ...mainRings];
  const zMid = (zLo + zHi) / 2;
  const centre = (r: XYZ[]): XYZ => ({ x: r.reduce((a, q) => a + q.x, 0) / r.length, y: r.reduce((a, q) => a + q.y, 0) / r.length, z: zMid });
  const footprint = [...rings.map((r) => r[2]), ...rings.map((r) => r[3]).reverse()];
  const pad: FlangePad = { sweep: { rings, start: centre(rings[0]), end: { x: path[path.length - 1].x, y: path[path.length - 1].y, z: zMid } }, footprint, shape: { kind: "sweep" } };
  const fillet = channelFillet(
    outline,
    path.map((_, i) => (z: number) => edgeAt(i, -1, z)),
    mitres.map((m) => ({ x: -outerSide * m.x, y: -outerSide * m.y })),
    levels,
    blendRadius,
  );
  return fillet ? [pad, fillet] : [pad];
}

function channelFillet(outline: ShapeOutline, edge: Array<(z: number) => XY>, away: XY[], levels: number[], blendRadius: number): FlangePad | undefined {
  const zFace = levels[1];
  const bury = FLANGE_PAD_BLEND_BURY;
  const collar = (z: number) => offsetAtZ(FLANGE_PAD_COLLAR, z);
  const offsetOf = (q: XY) => outlineOffsetAt(outline, q.x, q.y).offset;
  const lerp = (a: XY, b: XY, f: number): XY => ({ x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) });
  const firstPositive = (value: (i: number, f: number) => number): { i: number; f: number } | undefined => {
    for (let i = 0; i + 1 < edge.length; i++) {
      if (value(i, 1) <= 0) continue;
      if (value(i, 0) > 0) return i === 0 ? undefined : { i, f: 0 };
      let lo = 0;
      let hi = 1;
      for (let k = 0; k < FILLET_ROOT_ITERATIONS; k++) {
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
  const centreOn = (i: number, f: number): XY => {
    const p = lerp(edge[i](zFace), edge[i + 1](zFace), f);
    const d = awayAt(i, f);
    return { x: p.x + d.x * (blendRadius - bury), y: p.y + d.y * (blendRadius - bury) };
  };
  const hit = firstPositive((i, f) => offsetOf(centreOn(i, f)) - (collar(zFace) + blendRadius - bury));
  if (!hit) return undefined;
  const O = centreOn(hit.i, hit.f);
  const toCollar = outlineOffsetAt(outline, O.x, O.y);
  const toPad = awayAt(hit.i, hit.f);
  const a0 = Math.atan2(-toCollar.ny, -toCollar.nx);
  let a1 = Math.atan2(-toPad.y, -toPad.x);
  while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
  while (a1 - a0 < -Math.PI) a1 += 2 * Math.PI;
  const steps = Math.max(MIN_FILLET_STEPS, Math.ceil((Math.abs(a1 - a0) * blendRadius) / FLANGE_PAD_BLEND_STEP));
  const rings = levels.map((z) => {
    const r = blendRadius - offsetAtZ(0, z);
    const arc: XYZ[] = Array.from({ length: steps + 1 }, (_, k) => {
      const a = a0 + ((a1 - a0) * k) / steps;
      return { x: O.x + r * Math.cos(a), y: O.y + r * Math.sin(a), z };
    });
    const v = firstPositive((i, f) => offsetOf(lerp(edge[i](z), edge[i + 1](z), f)) - collar(z));
    const corner = v ? lerp(edge[v.i](z), edge[v.i + 1](z), v.f) : edge[0](z);
    const dx = corner.x - O.x;
    const dy = corner.y - O.y;
    const l = Math.hypot(dx, dy);
    return [...arc, { x: corner.x + (dx / l) * FILLET_CORNER_PUSH, y: corner.y + (dy / l) * FILLET_CORNER_PUSH, z }];
  });
  const mid = (ring: XYZ[]): XYZ => {
    const c = ring[ring.length - 1];
    const m = ring[steps >> 1];
    return { x: (c.x + m.x) / 2, y: (c.y + m.y) / 2, z: c.z };
  };
  return { sweep: { rings, start: mid(rings[0]), end: mid(rings[rings.length - 1]) }, footprint: rings[0], shape: { kind: "sweep" } };
}

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
  for (const anchor of anchors) pads.push(stadiumPad(anchor, anchor, pegHoleRadius(tolerance), FLANGE_PAD_WALL, zPlate));
  return pads;
}

export function channelPadFootprints(outline: ShapeOutline, innerEnd: InnerEndLayout, thickness: number, plateThickness: number): XY[][] {
  const zPlate = plateTopZ({ thickness, plateThickness });
  return zPlate === undefined ? [] : channelPads(outline, innerEnd, zPlate).map((pad) => pad.footprint);
}

export function layoutFlangeThroughHoles(flange: PaddedFlange, innerEnd: InnerEndLayout | undefined): ThroughMountLayout {
  const pads = layoutFlangePads(flange, innerEnd).map((pad) => pad.footprint);
  return layoutThroughHoleMount(
    flange.outline,
    flange.boreOutline,
    flange.margin,
    flange.throughHoleDiameter ?? DEFAULT_THROUGH_HOLE_DIAMETER,
    { channelRibbon: innerEnd?.channelRibbon ?? [], pads },
    collarFootprintOffset(flange),
  );
}

export function collarFootprintOffset(flange: Pick<PaddedFlange, "thickness" | "plateThickness">): number {
  const zPlate = plateTopZ(flange);
  return zPlate === undefined ? 0 : offsetAtZ(FLANGE_PAD_COLLAR, zPlate - FLANGE_PAD_EMBED);
}
