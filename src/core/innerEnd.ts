import {
  CABLE_BEND_BUDGET,
  CABLE_BRIDGE_STEP,
  CABLE_BASE_CLIP_INTERFERENCE,
  CABLE_BASE_CLIP_LAND,
  CABLE_BASE_CLIP_OPENING_MIN,
  CABLE_CLIP_DEPTH_SLACK,
  CABLE_CLIP_ENTRY,
  CABLE_CLIP_LENGTH_FACTOR,
  CABLE_CLIP_MIN_LENGTH,
  CABLE_CLIP_WALL,
  CABLE_CLIPPED_TAIL_FACTOR,
  CABLE_CLIPPED_TAIL_MIN,
  CABLE_SWEEP_ARC_SEGMENTS,
  CABLE_SWEEP_MAX_SAG,
  CABLE_SWEEP_STEP,
  CAP_CABLE_DROP,
  EDGE_CHAMFER,
  INNER_CHANNEL_DEPTH_FACTOR,
  INNER_CHANNEL_MIN_SHELF,
  INNER_CHANNEL_WALL_SKIN,
  MARGIN_BOTTOM,
  RIM_SLOT_NECK,
  RIM_SLOT_WALL_GAP,
  RIM_SLOT_SEAT_SEGMENTS,
} from "./constants";
import { offsetPerimeter, outlineOffsetAt, pointAt, sideLength } from "./shapes";
import type { ShapeOutline } from "./shapes";
import { grooveShape, grooveStartHeight } from "./wall";

const NEGLIGIBLE = 1e-9;
const COINCIDENT = 1e-6;
const STATION_MERGE_DISTANCE = 1e-3;
const MIN_RAMP_ACCELERATION = 1e-12;
const BISECTION_ITERATIONS = 60;
const PLAN_ITERATIONS = 50;
const BEND_TO_RIM_ITERATIONS = 40;
const BEND_TO_RIM_PASSES = 8;
const SEARCH_RANGE_LIMIT = 1e5;
const PLAN_CURVATURE_LIMIT = 1e3;
const TANGENT_PROBE_PHI = 1e-6;
const FRAME_PROBE_STEP = 0.01;
const EXIT_BEND_BUDGET_SHARE = 0.8;
const CHANNEL_CUT_START_HEIGHT = 0.3;
const BORE_CLEARANCE_PAST_RIM = 0.5;
const CLIP_SEARCH_PADDING = 10;
const CAP_RIM_PROBE_TURNS = 1e-6;
const RIM_SLOT_SEARCH_STEP_MM = 0.5;
const RIM_SLOT_SEARCH_TURNS = 0.5;
const RIM_SLOT_EDGE_SAMPLE_MM = 0.25;
const RIM_SLOT_MOUTH_EXTRA = 1;
const BORE_TOP_EXTRA = 1;

export function idealChannelDepth(wireDiameter: number): number {
  return INNER_CHANNEL_DEPTH_FACTOR * wireDiameter;
}

export function resolveChannelDepth(wireDiameter: number, flangeThickness: number): number {
  return Math.min(idealChannelDepth(wireDiameter), Math.max(0, flangeThickness - INNER_CHANNEL_MIN_SHELF));
}

export interface XY {
  x: number;
  y: number;
}

export interface XYZ {
  x: number;
  y: number;
  z: number;
}

export interface SweepSolid {
  rings: XYZ[][];
  start: XYZ;
  end: XYZ;
}

export interface InnerEndLayout {
  channelRadius: number;
  clipOpening: number;
  channel: SweepSolid;
  clip: { from: XYZ; to: XYZ };
  rimExit: XY;
  channelRibbon: XY[];
  leadIn: XYZ[];
  requiredMargin: number;
  warning?: string;
}

export function clipRadius(wireDiameter: number, tolerance: number): number {
  return (wireDiameter + tolerance) / 2;
}

export function clipLength(wireDiameter: number): number {
  return Math.max(CABLE_CLIP_MIN_LENGTH, CABLE_CLIP_LENGTH_FACTOR * wireDiameter);
}

export function clippedTailLength(wireDiameter: number): number {
  return Math.max(CABLE_CLIPPED_TAIL_MIN, CABLE_CLIPPED_TAIL_FACTOR * wireDiameter);
}

export function baseClipOpeningFraction(wireDiameter: number, tolerance: number): number {
  const opening = wireDiameter * (1 - CABLE_BASE_CLIP_INTERFERENCE);
  return Math.max(CABLE_BASE_CLIP_OPENING_MIN, opening / (wireDiameter + tolerance));
}

function lipHalf(s: number, from: number, to: number, closed: number, open: number): number {
  const entry = Math.min(CABLE_CLIP_ENTRY, (to - from) / 2);
  if (s <= from || s >= to) return open;
  const k = Math.min(1, (s - from) / entry, (to - s) / entry);
  return open + (closed - open) * k;
}

interface BoreSlot {
  half: number;
  to: number;
  range: [number, number];
  funnel?: { z: number; rise: number; reach: number; top: number };
}

function boreRing(c: XYZ, u: XY, R: number, stretch: number, up: BoreSlot, down?: BoreSlot): XYZ[] {
  const at = (p: number, z: number): XYZ => ({ x: c.x + u.x * p, y: c.y + u.y * p, z });
  const foot = (half: number) => Math.asin(Math.min(1, half / R));
  const steps = (a: number, b: number, n = Math.ceil((b - a) / (Math.PI / CABLE_SWEEP_ARC_SEGMENTS) - NEGLIGIBLE)) =>
    b - a > NEGLIGIBLE ? Array.from({ length: n }, (_, i) => a + ((b - a) * (i + 1)) / n) : [];
  const upTop = foot(up.range[0]);
  const upOpen = foot(up.range[1]);
  const downOpen = down ? Math.PI - foot(down.range[1]) : Math.PI;
  const side = [upTop, ...steps(upTop, upOpen), ...steps(upOpen, downOpen, down ? CABLE_SWEEP_ARC_SEGMENTS : CABLE_SWEEP_ARC_SEGMENTS / 2), ...(down ? steps(downOpen, Math.PI - foot(down.range[0])) : [])];
  const point = (phi: number, sign: 1 | -1): XYZ => {
    const slot = Math.cos(phi) >= 0 ? up.half : (down?.half ?? 0);
    return at(sign * Math.max(R * Math.sin(phi), slot), c.z + R * Math.cos(phi) * stretch);
  };
  const funnel = up.funnel;
  const ring: XYZ[] = [at(funnel ? funnel.top : up.half, up.to), ...(funnel ? [at(funnel.reach, funnel.z + funnel.rise), at(up.half, funnel.z)] : []), ...side.map((phi) => point(phi, 1))];
  if (down) ring.push(at(down.half, down.to), at(-down.half, down.to));
  ring.push(...(down ? side : side.slice(0, -1)).reverse().map((phi) => point(phi, -1)));
  if (funnel) ring.push(at(-up.half, funnel.z), at(-funnel.reach, funnel.z + funnel.rise));
  ring.push(at(-(funnel ? funnel.top : up.half), up.to));
  return ring;
}

export function sweepMesh(sweep: SweepSolid): { positions: Float32Array; indices: Uint32Array } {
  const { rings, start, end } = sweep;
  const m = rings[0].length;
  const n = rings.length;
  const positions = new Float32Array((n * m + 2) * 3);
  rings.forEach((ring, i) => ring.forEach((p, j) => positions.set([p.x, p.y, p.z], (i * m + j) * 3)));
  const s = n * m;
  const e = n * m + 1;
  positions.set([start.x, start.y, start.z], s * 3);
  positions.set([end.x, end.y, end.z], e * 3);
  const tris: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    for (let j = 0; j < m; j++) {
      const a = i * m + j;
      const b = i * m + ((j + 1) % m);
      const c = a + m;
      const d = b + m;
      tris.push(a, b, d, a, d, c);
    }
  }
  for (let j = 0; j < m; j++) {
    tris.push(s, (j + 1) % m, j);
    tris.push(e, (n - 1) * m + j, (n - 1) * m + ((j + 1) % m));
  }
  let volume = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t] * 3, tris[t + 1] * 3, tris[t + 2] * 3];
    const p = positions;
    volume += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  if (volume < 0) {
    for (let t = 0; t < tris.length; t += 3) [tris[t + 1], tris[t + 2]] = [tris[t + 2], tris[t + 1]];
  }
  return { positions, indices: new Uint32Array(tris) };
}

export function bump(rise: number, startSlope: number, span: number): { acceleration: number; value(s: number): number } {
  if (rise < 0) {
    const m = bump(-rise, -startSlope, span);
    return { acceleration: m.acceleration, value: (s) => -m.value(s) };
  }
  if (span <= NEGLIGIBLE) return { acceleration: Infinity, value: () => rise };
  const b = 2 * startSlope * span - 4 * rise;
  const acceleration = Math.max(MIN_RAMP_ACCELERATION, (-b + Math.sqrt(b * b + 4 * span * span * startSlope * startSlope)) / (2 * span * span));
  const switchAt = Math.max(0, Math.min(span, (span - startSlope / acceleration) / 2));
  const valueAtSwitch = startSlope * switchAt + (acceleration * switchAt * switchAt) / 2;
  const slopeAtSwitch = startSlope + acceleration * switchAt;
  return {
    acceleration,
    value: (s) => {
      if (s <= 0) return 0;
      if (s >= span) return rise;
      if (s <= switchAt) return startSlope * s + (acceleration * s * s) / 2;
      const w = s - switchAt;
      return valueAtSwitch + slopeAtSwitch * w - (acceleration * w * w) / 2;
    },
  };
}

function invert(value: (s: number) => number, target: number, lo: number, hi: number): number {
  for (let i = 0; i < BISECTION_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    if (value(mid) < target) lo = mid;
    else hi = mid;
  }
  return hi;
}

function reach(value: (s: number) => number, target: number, from: number): number {
  let hi = from + 1;
  while (value(hi) < target && hi < SEARCH_RANGE_LIMIT) hi = from + (hi - from) * 2;
  return invert(value, target, from, hi);
}

interface LeadInRoute {
  at(s: number): XYZ;
  dropStart: number;
  dropEnd: number;
  curve: number;
  settledAt: number;
  chordAt(s: number): XY;
}

function planLeadIn(
  outline: ShapeOutline,
  wireDiameter: number,
  tolerance: number,
  bendRadius: number,
  channelDepth: number,
  { forcedDrop, curve = 0 }: { forcedDrop?: number; curve?: number } = {},
): LeadInRoute {
  const d = wireDiameter;
  const groove = grooveShape(d);
  const layerOneOffset = d / 2 - groove.depth;
  const { pitch } = groove;
  const zStart = grooveStartHeight(groove, MARGIN_BOTTOM);

  const j = pointAt(outline, 0, layerOneOffset);
  const ahead = pointAt(outline, TANGENT_PROBE_PHI, layerOneOffset);
  const txRaw = ahead.x - j.x;
  const tyRaw = ahead.y - j.y;
  const xyPerPhi = Math.hypot(txRaw, tyRaw) / TANGENT_PROBE_PHI;
  const tx = txRaw / (xyPerPhi * TANGENT_PROBE_PHI);
  const ty = tyRaw / (xyPerPhi * TANGENT_PROBE_PHI);
  const nx = j.nx;
  const ny = j.ny;
  const helixSlope = pitch / xyPerPhi;

  const zOnChannelFloor = -channelDepth + d / 2;
  const drop = zStart - zOnChannelFloor;
  const needSide = (d + tolerance) / 2 + INNER_CHANNEL_WALL_SKIN;
  const lineOffset = (s: number) => outlineOffsetAt(outline, j.x - s * tx, j.y - s * ty).offset;
  const plan = (curvature: number) => {
    const ease = zStart - (d + tolerance) / 2;
    const easeA = Math.min(ease > NEGLIGIBLE ? (helixSlope * helixSlope) / (2 * ease) : Infinity, curvature / 2);
    const easeLength = helixSlope / easeA;
    const lateralA = Math.sqrt(Math.max(0, curvature * curvature - easeA * easeA)) - curve;
    const dropA = Math.sqrt(Math.max(0, curvature * curvature - curve * curve));
    if (lateralA <= 0 || dropA <= 0) return undefined;
    const sideAt = (s: number) => Math.max(0, needSide - lineOffset(s) - (curve * s * s) / 2);
    const longEnough = (s: number) => Math.sqrt((4 * sideAt(s)) / lateralA) <= s;
    const shiftEnd = longEnough(0) ? 0 : invert((s) => (longEnough(s) ? 1 : 0), 1, 0, Math.sqrt((4 * needSide) / lateralA));
    const side = sideAt(shiftEnd);
    const lateralLength = shiftEnd;
    const easing = Math.min(shiftEnd, easeLength);
    const eased = helixSlope * easing - (easeA * easing * easing) / 2;
    const slope = helixSlope - easeA * easing;
    const rest = Math.max(0, drop - eased);
    let dropLength = 1;
    while (bump(rest, slope, dropLength).acceleration > dropA && dropLength < SEARCH_RANGE_LIMIT) dropLength *= 2;
    let lo = 0;
    for (let i = 0; i < PLAN_ITERATIONS; i++) {
      const mid = (lo + dropLength) / 2;
      if (bump(rest, slope, mid).acceleration > dropA) lo = mid;
      else dropLength = mid;
    }
    const tail = bump(rest, slope, dropLength);
    const fall = (s: number) => (s <= easing ? helixSlope * s - (easeA * s * s) / 2 : s <= shiftEnd ? eased : eased + tail.value(s - shiftEnd));
    return { fall, side, lateral: bump(side, 0, lateralLength), lateralLength, shiftEnd, length: shiftEnd + dropLength };
  };

  const budget = CABLE_BEND_BUDGET / bendRadius;
  let route = plan(budget);
  if (forcedDrop !== undefined || !route) {
    const target = forcedDrop ?? Infinity;
    let lo = budget;
    let hi = budget * 2;
    const fits = (b: number) => {
      const r = plan(b);
      return r !== undefined && r.length <= target;
    };
    while (!fits(hi) && hi < PLAN_CURVATURE_LIMIT) hi *= 2;
    for (let i = 0; i < PLAN_ITERATIONS; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    route = plan(hi)!;
  }
  const { fall, side, lateral, lateralLength, shiftEnd, length } = route;

  const bend = (s: number) => (curve * s * s) / 2;
  const chordAt = (s: number): XY => ({ x: j.x - s * tx + (side + bend(s)) * nx, y: j.y - s * ty + (side + bend(s)) * ny });
  return {
    dropStart: shiftEnd,
    dropEnd: length,
    curve,
    settledAt: Math.max(drop <= CABLE_CLIP_DEPTH_SLACK ? 0 : invert(fall, drop - CABLE_CLIP_DEPTH_SLACK, 0, length), length - clipLength(d)),
    chordAt,
    at: (s) => {
      const shift = (side > 0 ? lateral.value(Math.min(s, lateralLength)) : 0) + bend(s);
      return { x: j.x - s * tx + shift * nx, y: j.y - s * ty + shift * ny, z: zStart - fall(Math.min(s, length)) };
    },
  };
}

function chordOffset(outline: ShapeOutline, route: LeadInRoute, s: number): number {
  const p = route.chordAt(s);
  return outlineOffsetAt(outline, p.x, p.y).offset;
}

function bendToRim(
  outline: ShapeOutline,
  wireDiameter: number,
  tolerance: number,
  bendRadius: number,
  channelDepth: number,
  limit: number,
  target: number,
  clipLen: number,
): { route: LeadInRoute; clipEnd: number } | undefined {
  const maxCurve = (EXIT_BEND_BUDGET_SHARE * CABLE_BEND_BUDGET) / bendRadius;
  let at = target;
  for (let pass = 0; pass < BEND_TO_RIM_PASSES; pass++) {
    let lo = 0;
    let hi = maxCurve;
    if (chordOffset(outline, planLeadIn(outline, wireDiameter, tolerance, bendRadius, channelDepth, { curve: hi }), at) < limit) lo = hi;
    for (let i = 0; i < BEND_TO_RIM_ITERATIONS && lo < hi; i++) {
      const mid = (lo + hi) / 2;
      if (chordOffset(outline, planLeadIn(outline, wireDiameter, tolerance, bendRadius, channelDepth, { curve: mid }), at) < limit) lo = mid;
      else hi = mid;
    }
    const route = planLeadIn(outline, wireDiameter, tolerance, bendRadius, channelDepth, { curve: lo });
    if (route.settledAt + clipLen <= at + COINCIDENT) return { route, clipEnd: at };
    at = route.settledAt + clipLen;
  }
  return undefined;
}

function clipLimit(margin: number, R: number): number {
  return margin - R - CABLE_CLIP_WALL;
}

export function requiredInnerEndMargin(outline: ShapeOutline, wireDiameter: number, tolerance: number, bendRadius: number, channelDepth = idealChannelDepth(wireDiameter)): number {
  const route = planLeadIn(outline, wireDiameter, tolerance, bendRadius, channelDepth);
  return chordOffset(outline, route, route.settledAt + clipLength(wireDiameter)) + clipRadius(wireDiameter, tolerance) + CABLE_CLIP_WALL;
}

function stationsOver(from: number, to: number, step: number, extra: number[]): number[] {
  const count = Math.max(1, Math.ceil((to - from) / step));
  const all = [...Array.from({ length: count + 1 }, (_, i) => from + ((to - from) * i) / count), ...extra.filter((s) => s > from + STATION_MERGE_DISTANCE && s < to - STATION_MERGE_DISTANCE)];
  all.sort((a, b) => a - b);
  return all.filter((s, i) => i === 0 || s - all[i - 1] > STATION_MERGE_DISTANCE);
}

export function layoutInnerEnd(
  outline: ShapeOutline,
  margin: number,
  wireDiameter: number,
  tolerance: number,
  bendRadius: number,
  channelDepth = idealChannelDepth(wireDiameter),
): InnerEndLayout {
  const R = clipRadius(wireDiameter, tolerance);
  const clipLen = clipLength(wireDiameter);
  const closed = baseClipOpeningFraction(wireDiameter, tolerance) * R;

  let route = planLeadIn(outline, wireDiameter, tolerance, bendRadius, channelDepth);
  const minClipEnd = route.settledAt + clipLen;
  const limit = clipLimit(margin, R);
  const requiredMargin = chordOffset(outline, route, minClipEnd) + R + CABLE_CLIP_WALL;

  const findClipEnd = (lo: number, hi: number) => {
    for (let i = 0; i < BISECTION_ITERATIONS; i++) {
      const mid = (lo + hi) / 2;
      if (chordOffset(outline, route, mid) <= limit) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  let clipEnd: number;
  let clipFrom: number;
  let warning: string | undefined;
  if (chordOffset(outline, route, minClipEnd) <= limit + COINCIDENT) {
    let hi = minClipEnd * 2 + CLIP_SEARCH_PADDING;
    while (chordOffset(outline, route, hi) <= limit && hi < SEARCH_RANGE_LIMIT) hi *= 2;
    clipEnd = findClipEnd(minClipEnd, hi);
    const halfFlat = sideLength(outline) / 2;
    if (halfFlat > COINCIDENT && clipEnd > halfFlat) {
      const bent = bendToRim(outline, wireDiameter, tolerance, bendRadius, channelDepth, limit, halfFlat, clipLen);
      if (bent) ({ route, clipEnd } = bent);
    }
    clipFrom = clipEnd - clipLen;
  } else {
    clipEnd = findClipEnd(0, minClipEnd);
    clipFrom = Math.max(clipEnd - clipLen, clipEnd / 2);
    route = planLeadIn(outline, wireDiameter, tolerance, bendRadius, channelDepth, { forcedDrop: clipFrom });
    warning = `The ${margin.toFixed(1)} mm flange margin is too narrow for the inner cable end to reach the groove within its ${bendRadius.toFixed(1)} mm bend radius; it needs at least ${requiredMargin.toFixed(1)} mm.`;
  }

  const clipEndAt = route.at(clipEnd);
  const outward = outlineOffsetAt(outline, clipEndAt.x, clipEndAt.y);
  const exitCurve = Math.max(0, (EXIT_BEND_BUDGET_SHARE * CABLE_BEND_BUDGET) / bendRadius - route.curve);
  const bent = (s: number): XYZ => {
    const p = route.at(s);
    const k = s <= clipEnd ? 0 : (exitCurve * (s - clipEnd) ** 2) / 2;
    return { x: p.x + outward.nx * k, y: p.y + outward.ny * k, z: p.z };
  };
  const sRim = reach((s) => {
    const p = bent(s);
    return outlineOffsetAt(outline, p.x, p.y).offset;
  }, margin, clipEnd);
  const atRim = bent(sRim);
  const beforeRim = bent(sRim - FRAME_PROBE_STEP);
  const out = { x: (atRim.x - beforeRim.x) / Math.hypot(atRim.x - beforeRim.x, atRim.y - beforeRim.y), y: (atRim.y - beforeRim.y) / Math.hypot(atRim.x - beforeRim.x, atRim.y - beforeRim.y) };
  const path = (s: number): XYZ => (s <= sRim ? bent(s) : { x: atRim.x + out.x * (s - sRim), y: atRim.y + out.y * (s - sRim), z: atRim.z });
  const sEnd = reach((s) => {
    const p = path(s);
    return outlineOffsetAt(outline, p.x, p.y).offset;
  }, margin + R + BORE_CLEARANCE_PAST_RIM, sRim);

  const frame = (s: number) => {
    const a = path(Math.max(0, s - FRAME_PROBE_STEP));
    const b = path(s + FRAME_PROBE_STEP);
    const plan = Math.hypot(b.x - a.x, b.y - a.y);
    return { c: path(s), u: { x: -(b.y - a.y) / plan, y: (b.x - a.x) / plan }, stretch: Math.hypot(1, (b.z - a.z) / plan) };
  };
  const bottom = (s: number) => {
    const f = frame(s);
    return f.c.z - R * f.stretch;
  };
  const from = route.dropStart;
  const sStart = bottom(from) <= CHANNEL_CUT_START_HEIGHT ? from : invert((s) => -bottom(s), -CHANNEL_CUT_START_HEIGHT, from, route.dropEnd);
  const sweepStep = Math.min(CABLE_SWEEP_STEP, Math.sqrt(8 * CABLE_SWEEP_MAX_SAG * bendRadius));
  const stations = stationsOver(sStart, sEnd, sweepStep, [clipFrom, clipFrom + CABLE_CLIP_ENTRY, clipEnd - CABLE_CLIP_ENTRY, clipEnd]);
  const rings = stations.map((s) => {
    const { c, u, stretch } = frame(s);
    const half = lipHalf(s, clipFrom, clipEnd, closed, R);
    const to = Math.max(c.z + R * stretch, 0) + BORE_TOP_EXTRA;
    const z = c.z + Math.sqrt(R * R - closed * closed) * stretch + CABLE_BASE_CLIP_LAND;
    const rise = Math.max(R - half, CABLE_CLIP_ENTRY);
    return boreRing(c, u, R, stretch, { half, to, range: [closed, R], funnel: { z, rise, reach: Math.min(R, half + rise), top: R } });
  });
  const channel: SweepSolid = { rings, start: path(sStart), end: path(sEnd) };

  const cutting = stations.filter((s) => bottom(s) < 0);
  const rail = (sign: 1 | -1) =>
    cutting.map((s) => {
      const { c, u } = frame(s);
      return { x: c.x + sign * u.x * R, y: c.y + sign * u.y * R };
    });
  const channelRibbon: XY[] = cutting.length >= 2 ? [...rail(1), ...rail(-1).reverse()] : [];

  const sTail = sRim + clippedTailLength(wireDiameter);
  const steps = Math.max(2, Math.ceil(sTail / CABLE_BRIDGE_STEP));
  const leadIn: XYZ[] = Array.from({ length: steps + 1 }, (_, i) => path(sTail * (1 - i / steps)));

  return {
    channelRadius: R,
    clipOpening: 2 * closed,
    channel,
    clip: { from: route.at(clipFrom), to: route.at(clipEnd) },
    rimExit: { x: atRim.x, y: atRim.y },
    channelRibbon,
    leadIn,
    requiredMargin,
    warning,
  };
}

export function capCableZ(wireDiameter: number): number {
  return -wireDiameter / 2 - CAP_CABLE_DROP;
}

export function capTailPath(outline: ShapeOutline, margin: number, offset: number, wireDiameter: number, bendRadius: number, u0: number): XY[] {
  const p = pointAt(outline, u0, offset);
  const q = pointAt(outline, u0 + CAP_RIM_PROBE_TURNS, offset);
  const l = Math.hypot(q.x - p.x, q.y - p.y);
  const tan = { x: (q.x - p.x) / l, y: (q.y - p.y) / l };
  const curve = (EXIT_BEND_BUDGET_SHARE * CABLE_BEND_BUDGET) / bendRadius;
  const exit = (s: number): XY => ({
    x: p.x + tan.x * s + p.nx * ((curve * s * s) / 2),
    y: p.y + tan.y * s + p.ny * ((curve * s * s) / 2),
  });
  const sRim = reach((s) => {
    const e = exit(s);
    return outlineOffsetAt(outline, e.x, e.y).offset;
  }, margin, 0);
  const sOut = sRim + clippedTailLength(wireDiameter);
  const steps = Math.max(2, Math.ceil(sOut / CABLE_BRIDGE_STEP));
  const atRim = exit(sRim);
  const heading = { x: tan.x + p.nx * curve * sRim, y: tan.y + p.ny * curve * sRim };
  const along = Math.hypot(heading.x, heading.y);
  const tailPoint = (s: number): XY =>
    s <= sRim ? exit(s) : { x: atRim.x + (heading.x / along) * (s - sRim), y: atRim.y + (heading.y / along) * (s - sRim) };
  return Array.from({ length: steps + 1 }, (_, i) => tailPoint((sOut * i) / steps));
}

export interface RimSlot {
  outline: XY[];
  seat: XY;
  axis: XY;
}

function rimSlotSection(wireDiameter: number, tolerance: number) {
  const R = clipRadius(wireDiameter, tolerance);
  const neck = (wireDiameter * (1 - CABLE_BASE_CLIP_INTERFERENCE)) / 2;
  const neckStart = Math.sqrt(R * R - neck * neck);
  return { R, neck, neckStart, neckEnd: neckStart + RIM_SLOT_NECK };
}

export function rimSlotWidths(wireDiameter: number, tolerance: number): { seat: number; neck: number } {
  const { R, neck } = rimSlotSection(wireDiameter, tolerance);
  return { seat: 2 * R, neck: 2 * neck };
}

export function rimSlotSeatOffset(margin: number, wireDiameter: number, tolerance: number): number {
  return margin - EDGE_CHAMFER - rimSlotSection(wireDiameter, tolerance).neckEnd;
}

export function requiredRimSlotMargin(wireDiameter: number, tolerance: number): number {
  const { R, neckEnd } = rimSlotSection(wireDiameter, tolerance);
  return RIM_SLOT_WALL_GAP + R + neckEnd + EDGE_CHAMFER;
}

function rimSlotAt(outline: ShapeOutline, margin: number, wireDiameter: number, tolerance: number, u: number): RimSlot {
  const { R, neck, neckStart, neckEnd } = rimSlotSection(wireDiameter, tolerance);
  const c = pointAt(outline, u, rimSlotSeatOffset(margin, wireDiameter, tolerance));
  const a = { x: c.nx, y: c.ny };
  const far = reach((s) => outlineOffsetAt(outline, c.x + a.x * s, c.y + a.y * s).offset, margin, 0) + RIM_SLOT_MOUTH_EXTRA;
  const at = (along: number, across: number): XY => ({ x: c.x + a.x * along - a.y * across, y: c.y + a.y * along + a.x * across });
  const start = Math.atan2(neck, neckStart);
  const arcSteps = Math.ceil(((2 * Math.PI - 2 * start) / (2 * Math.PI)) * RIM_SLOT_SEAT_SEGMENTS);
  const arc = Array.from({ length: arcSteps + 1 }, (_, i) => {
    const phi = start + ((2 * Math.PI - 2 * start) * i) / arcSteps;
    return at(R * Math.cos(phi), R * Math.sin(phi));
  });
  const flare = neck + far - neckEnd;
  return { outline: [at(far, flare), at(neckEnd, neck), ...arc, at(neckEnd, -neck), at(far, -flare)], seat: { x: c.x, y: c.y }, axis: a };
}

function inside(p: XY, poly: XY[]): boolean {
  let odd = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, b] = [poly[i], poly[j]];
    if (a.y > p.y !== b.y > p.y && p.x < a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y)) odd = !odd;
  }
  return odd;
}

function edgeDistance(p: XY, poly: XY[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, b] = [poly[j], poly[i]];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

export function cutClearsKeepOut(cut: XY[], outline: ShapeOutline, margin: number, keepOut: XY[][], clearance: number): boolean {
  const samples = cut.flatMap((a, i) => {
    const b = cut[(i + 1) % cut.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / RIM_SLOT_EDGE_SAMPLE_MM));
    return Array.from({ length: n }, (_, k) => ({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n }));
  });
  const inPlate = samples.filter((p) => outlineOffsetAt(outline, p.x, p.y).offset <= margin);
  return keepOut.every((poly) => inPlate.every((p) => !inside(p, poly) && edgeDistance(p, poly) >= clearance) && poly.every((q) => outlineOffsetAt(outline, q.x, q.y).offset > margin || !inside(q, cut)));
}

export function layoutRimSlot(outline: ShapeOutline, margin: number, wireDiameter: number, tolerance: number, u0: number, keepOut: XY[][] = [], clearance = 0): RimSlot | undefined {
  const du = RIM_SLOT_SEARCH_STEP_MM / offsetPerimeter(outline, Math.max(0, rimSlotSeatOffset(margin, wireDiameter, tolerance)));
  for (let k = 0; k * du <= RIM_SLOT_SEARCH_TURNS; k++) {
    for (const u of k === 0 ? [u0] : [u0 + k * du, u0 - k * du]) {
      const slot = rimSlotAt(outline, margin, wireDiameter, tolerance, u);
      if (cutClearsKeepOut(slot.outline, outline, margin, keepOut, clearance)) return slot;
    }
  }
  return undefined;
}
