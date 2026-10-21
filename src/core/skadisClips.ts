import {
  CABLE_DENSITY_G_PER_MM3,
  FLANGE_PAD_COLLAR,
  SKADIS_BIGHT_THICKNESS,
  SKADIS_BOARD_THICKNESS,
  SKADIS_BOARD_THICKNESS_MAX,
  SKADIS_CLIP_BOARD_EDGE_MIN,
  SKADIS_CLIP_BOARD_FILLET,
  SKADIS_CLIP_FILLET_MAX,
  SKADIS_CLIP_FILLET_MIN_CONVEX,
  SKADIS_CLIP_FILLET_SEGMENTS_PER_90,
  SKADIS_CLIP_WIDTH,
  SKADIS_ENVELOPE_CLEARANCE,
  SKADIS_HEAVY_CABLE_KG,
  SKADIS_JAW_OVERLAP,
  SKADIS_LATCH_ARM_REACH,
  SKADIS_LATCH_ARM_THICKNESS,
  SKADIS_LATCH_END_GAP,
  SKADIS_LATCH_FACE_DEG,
  SKADIS_LATCH_LIFT,
  SKADIS_LATCH_MAST_THICKNESS,
  SKADIS_LATCH_ROOT,
  SKADIS_LATCH_SLIT,
  SKADIS_LATCH_TOOTH_DEPTH,
  SKADIS_LATCH_TOOTH_LENGTH,
  SKADIS_LATTICE_STEP,
  SKADIS_LIP_THICKNESS,
  SKADIS_NOTCH_DEPTH,
  SKADIS_NOTCH_MIN_CROSSING_DEG,
  SKADIS_SLOT_LENGTH,
  SKADIS_SLOT_LENGTH_MIN,
  SKADIS_SLOT_WIDTH,
  SKADIS_SLOT_WIDTH_MIN,
  SKADIS_STANDOFF,
  SKADIS_STEM_HEIGHT,
  SKADIS_TONGUE_GAP,
  SKADIS_TONGUE_LENGTH,
  SKADIS_TONGUE_THICKNESS,
  WELD_OVERLAP,
} from "./constants";
import type { XY } from "./innerEnd";
import { bestAxisDeg } from "./mount";
import { WELD_EPSILON } from "./weld";
import { offsetOutline, pointAt } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { PegboardSection } from "./types";

const MIN_PAD_DEPTH = 1e-6;
const LIP_FLARE_CLEARANCE = 0.5;
const NEAR_POINT_COINCIDENT = 1e-6;
const CONVEX_CROSS_EPSILON = 1e-9;
const SIDE_CROSSING_EPSILON = 1e-12;
const STEM_SEAT_EPSILON = 1e-9;
const PARALLEL_SEGMENT_EPSILON = 1e-12;
const AXIS_DISTINCT_EPSILON = 1e-6;
const ENVELOPE_SAMPLES = 8;
const AVOID_SAMPLES_UP = 6;
const AVOID_SAMPLES_SIDE = 4;
const PAD_SAMPLES_UP = 13;
const PAD_SAMPLES_SIDE = 24;
const FLAT_BOTTOM_FAN_DEG = 180;
const FLAT_TOP_FAN_DEG = 0;
const MIN_CLIP_COUNTS = [3, 2];
const BOTTOM_COLUMN_CHOICES = [[-20, 20], [-60, 60], [-20, -60], [20, 60], [0]];
const LAST_RESORT_BOTTOM_COLUMNS = [[-40], [40]];
const NOTCH_DEPTH_OUT = 50;
const COLLINEAR_EPSILON = 1e-6;
const ARC_SEGMENT_EPSILON = 1e-9;
const BIGHT_FILLET_PLATE_SHARE = 4;

function clearOfStemTop(jawTip: number, stemTop: number): number {
  const step = jawTip - stemTop;
  return step > 0 && step < SKADIS_CLIP_BOARD_EDGE_MIN ? stemTop + SKADIS_CLIP_BOARD_EDGE_MIN : jawTip;
}
const MARGIN_SEARCH_LIMIT = 1e4;
const MARGIN_BISECTIONS = 30;
const MARGIN_ROUNDING = 1e-6;
const PROFILE_SAMPLES = 720;

export interface RimClip {
  role: "top" | "bottom";
  side: number;
  floor: number;
  stemUp: number;
  slotUp: number;
  profile: Array<[number, number]>;
  latch?: { toothTop: number; toothBottom: number; depth: number; armReach: number };
}

export interface NotchCutter {
  side0: number;
  width: number;
  profile: Array<[number, number]>;
}

export interface SkadisClipLayout {
  axisDeg: number;
  clips: RimClip[];
  notches: XY[][];
  notchCutters: NotchCutter[];
  boardFrontZ: number;
  warning?: string;
}

export interface SkadisClipInput {
  flangeOutline: ShapeOutline;
  boreOutline: ShapeOutline;
  envelopeOutline: ShapeOutline;
  thickness: number;
  plateThickness: number;
  tolerance: number;
  latch: boolean;
  heavy: boolean;
  avoid?: XY[];
  padFootprints?: XY[][];
  primaryOnly?: boolean;
}

export function lipKeepOffset(envelopeOffset: number, thickness: number, plateThickness: number, tolerance: number): number {
  const depth = thickness - plateThickness;
  if (depth < MIN_PAD_DEPTH) return envelopeOffset;
  return Math.max(envelopeOffset, FLANGE_PAD_COLLAR + depth - tolerance + LIP_FLARE_CLEARANCE - SKADIS_ENVELOPE_CLEARANCE);
}

export function cableWeightKg(diameter: number, length: number): number {
  return (CABLE_DENSITY_G_PER_MM3 * Math.PI * (diameter / 2) ** 2 * length) / 1000;
}

export function isHeavyCable(diameter: number, length: number): boolean {
  return cableWeightKg(diameter, length) > SKADIS_HEAVY_CABLE_KG;
}

export function basisFor(axisDeg: number) {
  const a = (axisDeg * Math.PI) / 180;
  const up = { x: Math.sin(a), y: Math.cos(a) };
  const side = { x: Math.cos(a), y: -Math.sin(a) };
  return {
    up,
    side,
    toXY: (u: number, s: number): XY => ({ x: u * up.x + s * side.x, y: u * up.y + s * side.y }),
    project: (p: XY) => ({ up: p.x * up.x + p.y * up.y, side: p.x * side.x + p.y * side.y }),
  };
}

export function rimAt(boundary: Array<{ up: number; side: number }>, s: number): { top: number; bottom: number } {
  let top = -Infinity;
  let bottom = Infinity;
  for (let i = 0; i < boundary.length; i++) {
    const p = boundary[i];
    const q = boundary[(i + 1) % boundary.length];
    if ((p.side - s) * (q.side - s) > 0 || Math.abs(q.side - p.side) < SIDE_CROSSING_EPSILON) continue;
    const u = p.up + ((s - p.side) / (q.side - p.side)) * (q.up - p.up);
    top = Math.max(top, u);
    bottom = Math.min(bottom, u);
  }
  return { top, bottom };
}

export function projectOutline(o: ShapeOutline, project: (p: XY) => { up: number; side: number }, samples = PROFILE_SAMPLES) {
  const pts: Array<{ up: number; side: number }> = [];
  for (let i = 0; i < samples; i++) pts.push(project(pointAt(o, i / samples, 0)));
  return pts;
}

export function stemSeat(slotWidth: number, slotLength: number): number {
  const r = slotWidth / 2;
  const w = SKADIS_CLIP_WIDTH / 2;
  return slotLength / 2 - (r - Math.sqrt(r * r - w * w));
}
function fullWidthHalf(slotWidth: number, slotLength: number): number {
  return stemSeat(slotWidth, slotLength);
}

const SEAT = stemSeat(SKADIS_SLOT_WIDTH, SKADIS_SLOT_LENGTH);

export function ccwWithoutNearPoints(points: Array<[number, number]>): Array<[number, number]> {
  const near = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]) < WELD_EPSILON;
  const out: Array<[number, number]> = [];
  for (const p of points) {
    const q = out[out.length - 1];
    if (!q || !near(p, q)) out.push(p);
  }
  if (out.length > 1 && near(out[0], out[out.length - 1])) out.pop();
  let area = 0;
  for (let i = 0; i < out.length; i++) {
    const [x0, y0] = out[i];
    const [x1, y1] = out[(i + 1) % out.length];
    area += x0 * y1 - x1 * y0;
  }
  return area < 0 ? out.reverse() : out;
}

interface Levels {
  boardFront: number;
  tongueFace: number;
  tongueBack: number;
  outerJawFace: number;
  lipUnderside: number;
  lipTop: number;
}

function levels(thickness: number, plateThickness: number, tolerance: number): Levels {
  const boardFront = -thickness - SKADIS_STANDOFF;
  const tongueFace = boardFront - SKADIS_BOARD_THICKNESS_MAX - SKADIS_TONGUE_GAP;
  const lipUnderside = -thickness + Math.min(plateThickness, thickness) + tolerance;
  return { boardFront, tongueFace, tongueBack: tongueFace - SKADIS_TONGUE_THICKNESS, outerJawFace: -thickness - tolerance, lipUnderside, lipTop: lipUnderside + SKADIS_LIP_THICKNESS };
}

type Pt = [number, number];

export function chamferCorners(points: Pt[], soft: Pt[], d: number): Pt[] {
  const isSoft = (p: Pt) => soft.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < NEAR_POINT_COINCIDENT);
  const n = points.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const a = points[(i + n - 1) % n];
    const b = points[(i + 1) % n];
    const ea = Math.hypot(a[0] - p[0], a[1] - p[1]);
    const eb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const convex = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) > CONVEX_CROSS_EPSILON;
    const room = (e: number, q: Pt) => e >= (isSoft(q) ? 2 * d : d) + WELD_EPSILON;
    if (isSoft(p) && convex && room(ea, a) && room(eb, b)) {
      out.push([p[0] + ((a[0] - p[0]) * d) / ea, p[1] + ((a[1] - p[1]) * d) / ea], [p[0] + ((b[0] - p[0]) * d) / eb, p[1] + ((b[1] - p[1]) * d) / eb]);
    } else {
      out.push(p);
    }
  }
  return out;
}

function bightFilletRadius(z: Levels, c: number): number {
  return c + (z.lipUnderside - z.outerJawFace - 2 * c) / BIGHT_FILLET_PLATE_SHARE;
}

type Corners = Map<Pt, number>;

function cornerSet(): { corners: Corners; at: (u: number, zz: number, cap?: number) => Pt } {
  const corners: Corners = new Map();
  const at = (u: number, zz: number, cap?: number): Pt => {
    const p: Pt = [u, zz];
    if (cap !== undefined) corners.set(p, cap);
    return p;
  };
  return { corners, at };
}

function arcSamples(cx: number, cz: number, r: number, from: number, sweep: number): Pt[] {
  const n = Math.max(1, Math.ceil((SKADIS_CLIP_FILLET_SEGMENTS_PER_90 * Math.abs(sweep)) / (Math.PI / 2) - ARC_SEGMENT_EPSILON));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = from + (sweep * i) / n;
    out.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
  }
  return out;
}

interface CornerFit {
  p: Pt;
  ua: number[];
  ub: number[];
  turn: number;
  k: number;
  convex: boolean;
  ea: number;
  eb: number;
  reach: number;
  t: number;
}

function fitCorners(ring: Pt[], corners: Corners): CornerFit[] {
  const n = ring.length;
  const isSharp = (p: Pt) => corners.get(p) === 0;
  const share = (edge: number, neighbour: Pt) => (isSharp(neighbour) ? edge : edge / 2);
  const fits = ring.map((p, i): CornerFit => {
    const a = ring[(i + n - 1) % n];
    const b = ring[(i + 1) % n];
    const ea = Math.hypot(a[0] - p[0], a[1] - p[1]);
    const eb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const ua = [(a[0] - p[0]) / ea, (a[1] - p[1]) / ea];
    const ub = [(b[0] - p[0]) / eb, (b[1] - p[1]) / eb];
    const turn = Math.acos(Math.max(-1, Math.min(1, -(ua[0] * ub[0] + ua[1] * ub[1]))));
    const k = Math.tan(turn / 2);
    const convex = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) > 0;
    const reach = Math.min(SKADIS_CLIP_FILLET_MAX, corners.get(p) ?? Infinity) * k;
    return { p, ua, ub, turn, k, convex, ea, eb, reach, t: Math.min(reach, Math.min(share(ea, a), share(eb, b))) };
  });
  fits.forEach((f, i) => {
    const before = fits[(i + n - 1) % n];
    const after = fits[(i + 1) % n];
    f.t = Math.max(f.t, Math.min(f.reach, f.ea - before.t, f.eb - after.t));
  });
  return fits;
}

export function filletCorners(points: Pt[], corners: Corners): Pt[] {
  const ring = points.filter((p, i) => {
    const a = points[(i + points.length - 1) % points.length];
    const b = points[(i + 1) % points.length];
    const cross = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]);
    const dot = (p[0] - a[0]) * (b[0] - p[0]) + (p[1] - a[1]) * (b[1] - p[1]);
    return Math.abs(cross) > COLLINEAR_EPSILON * Math.hypot(p[0] - a[0], p[1] - a[1]) * Math.hypot(b[0] - p[0], b[1] - p[1]) || dot < 0;
  });
  const out: Pt[] = [];
  for (const { p, ua, ub, turn, k, convex, t } of fitCorners(ring, corners)) {
    const r = t / k;
    if (r <= 0) {
      out.push(p);
      continue;
    }
    if (convex && r < SKADIS_CLIP_FILLET_MIN_CONVEX - ARC_SEGMENT_EPSILON) throw new Error(`SKÅDIS clip corner at (${p[0].toFixed(2)}, ${p[1].toFixed(2)}) leaves room for a ${r.toFixed(2)} mm fillet only`);
    const toCentre = [ua[0] + ub[0], ua[1] + ub[1]];
    const len = Math.hypot(toCentre[0], toCentre[1]);
    const reach = r / Math.cos(turn / 2);
    const cx = p[0] + (toCentre[0] / len) * reach;
    const cz = p[1] + (toCentre[1] / len) * reach;
    const start = Math.atan2(p[1] + ua[1] * t - cz, p[0] + ua[0] * t - cx);
    out.push(...arcSamples(cx, cz, r, start, convex ? turn : -turn));
  }
  return out.filter((q, i) => {
    const prev = out[(i + out.length - 1) % out.length];
    return Math.hypot(q[0] - prev[0], q[1] - prev[1]) > NEAR_POINT_COINCIDENT;
  });
}

function topProfile(floor: number, z: Levels, c: number, latch: boolean): { profile: Pt[]; stemUp: number; latch?: RimClip["latch"] } {
  const uL = floor - SKADIS_JAW_OVERLAP;
  const uB0 = floor + c;
  const us = uB0 + SKADIS_BIGHT_THICKNESS;
  const uH = us + SKADIS_STEM_HEIGHT;
  const uTl = us - SKADIS_TONGUE_LENGTH;
  const { corners, at } = cornerSet();
  const bight = bightFilletRadius(z, c);
  const base: Pt[] = [
    at(uL, z.boardFront),
    at(uL, z.outerJawFace),
    at(uB0, z.outerJawFace, bight),
    at(uB0, z.lipUnderside, bight),
    at(uL, z.lipUnderside),
    at(uL, z.lipTop),
    at(uH, z.lipTop),
  ];
  const stem: Pt[] = [
    at(uH, z.tongueBack),
    at(uTl, z.tongueBack),
    at(uTl, z.tongueFace, 0),
    at(us, z.tongueFace, 0),
    at(us, z.boardFront, SKADIS_CLIP_BOARD_FILLET),
  ];
  const finish = (points: Pt[]) => filletCorners(ccwWithoutNearPoints(points), corners);
  if (!latch) return { profile: finish([...base, ...stem]), stemUp: us };

  const slotTopTight = us + 2 * fullWidthHalf(SKADIS_SLOT_WIDTH_MIN, SKADIS_SLOT_LENGTH_MIN);
  const uT1 = slotTopTight - SKADIS_LATCH_LIFT;
  const uT0 = uT1 - SKADIS_LATCH_TOOTH_LENGTH;
  const dt = SKADIS_LATCH_TOOTH_DEPTH;
  const uT2 = uT1 + dt * Math.tan((SKADIS_LATCH_FACE_DEG * Math.PI) / 180);
  const uA0 = uH + SKADIS_LATCH_END_GAP;
  const uR0 = (uT0 + uT1) / 2 + SKADIS_LATCH_ARM_REACH + SKADIS_LATCH_SLIT / 2;
  const uR1 = uR0 + SKADIS_LATCH_ROOT;
  const zA1 = z.boardFront + SKADIS_LATCH_ARM_THICKNESS;
  const zM0 = zA1 + SKADIS_LATCH_SLIT;
  const zM1 = zM0 + SKADIS_LATCH_MAST_THICKNESS;
  const latchPts: Pt[] = [
    at(uH, zM1),
    at(uR1, zM1),
    at(uR1, z.boardFront),
    at(uT2, z.boardFront, 0),
    at(uT1, z.boardFront - dt, 0),
    at(uT0, z.boardFront - dt),
    at(Math.max(uA0, uT0 - dt), z.boardFront),
    at(uA0, z.boardFront),
    at(uA0, zA1),
    at(uR0, zA1),
    at(uR0, zM0),
    at(uH, zM0, SKADIS_LATCH_END_GAP),
  ];
  return {
    profile: finish([...base, ...latchPts, ...stem]),
    stemUp: us,
    latch: { toothTop: uT1, toothBottom: uT0, depth: dt, armReach: SKADIS_LATCH_ARM_REACH },
  };
}

function bottomProfile(floor: number, stemUp: number, z: Levels, c: number): Pt[] {
  const uB0 = floor - c;
  const stemBesideBight = stemUp >= uB0 - SKADIS_BIGHT_THICKNESS - STEM_SEAT_EPSILON;
  const uB1 = stemBesideBight ? Math.min(uB0 - SKADIS_BIGHT_THICKNESS, stemUp - SKADIS_CLIP_BOARD_EDGE_MIN) : uB0 - SKADIS_BIGHT_THICKNESS;
  const uJ = floor + SKADIS_JAW_OVERLAP;
  const sTop = stemUp + SKADIS_STEM_HEIGHT;
  const uTl = stemUp - SKADIS_TONGUE_LENGTH;
  const { corners, at } = cornerSet();
  const bight = bightFilletRadius(z, c);
  const stem: Pt[] = [
    at(sTop, z.boardFront),
    at(sTop, z.tongueBack),
    at(uTl, z.tongueBack),
    at(uTl, z.tongueFace, 0),
    at(stemUp, z.tongueFace, 0),
    at(stemUp, z.boardFront, SKADIS_CLIP_BOARD_FILLET),
  ];
  const finish = (points: Pt[]) => filletCorners(ccwWithoutNearPoints(points), corners);
  if (stemBesideBight) {
    const top = clearOfStemTop(Math.max(uJ, sTop), sTop);
    return finish([at(uB1, z.lipTop), at(uJ, z.lipTop), at(uJ, z.lipUnderside), at(uB0, z.lipUnderside, bight), at(uB0, z.outerJawFace, bight), at(top, z.outerJawFace), at(top, z.boardFront), ...stem, at(uB1, z.boardFront)]);
  }
  const jawTip = clearOfStemTop(uJ, sTop);
  return finish([at(stemUp, z.lipTop), at(uJ, z.lipTop), at(uJ, z.lipUnderside), at(uB0, z.lipUnderside, bight), at(uB0, z.outerJawFace, bight), at(jawTip, z.outerJawFace), at(jawTip, z.boardFront), ...stem]);
}

function bottomStem(uB1: number, uJ: number, originSlot: number, parityOdd: boolean): number {
  const step = SKADIS_LATTICE_STEP;
  let best = NaN;
  let bestLen = Infinity;
  const k0 = Math.floor((uB1 - originSlot) / step) - 4;
  for (let k = k0; k <= k0 + 8; k++) {
    if (Math.abs(k % 2) === 1 !== parityOdd) continue;
    const stemUp = originSlot + k * step - SEAT;
    const sTop = stemUp + SKADIS_STEM_HEIGHT;
    const len = stemUp >= uB1 ? Math.max(0, sTop - uJ) : uB1 - stemUp;
    if (len < bestLen - STEM_SEAT_EPSILON) {
      bestLen = len;
      best = stemUp;
    }
  }
  return best;
}

export function distanceToPolygon(p: XY, poly: XY[]): number {
  let best = Infinity;
  let inside = false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (a.y > p.y !== b.y > p.y && p.x < a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y)) inside = !inside;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > PARALLEL_SEGMENT_EPSILON ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return inside ? 0 : best;
}

const CHANNEL_KEEP_OUT = 4;

const LIP_PAD_CLEARANCE = 0.05;

interface Placement {
  side: number;
  floor: number;
  ok: boolean;
}

export function layoutSkadisClips(input: SkadisClipInput): SkadisClipLayout {
  const axes = [bestAxisDeg(input.boreOutline, FLAT_BOTTOM_FAN_DEG)];
  const flatTop = bestAxisDeg(input.boreOutline, FLAT_TOP_FAN_DEG);
  if (!input.primaryOnly && Math.abs(flatTop - axes[0]) > AXIS_DISTINCT_EPSILON) axes.push(flatTop);
  for (const lastResort of input.primaryOnly ? [false] : [false, true]) {
    for (const axisDeg of axes) {
      const layout = layoutOnAxis(input, axisDeg, lastResort);
      if (layout) return layout;
    }
  }
  return {
    axisDeg: axes[0],
    clips: [],
    notches: [],
    notchCutters: [],
    boardFrontZ: levels(input.thickness, input.plateThickness, input.tolerance).boardFront,
    warning: "The flange is too small or too crowded for the SKÅDIS rim clips, so they were left out (try a bigger core).",
  };
}

function layoutOnAxis(input: SkadisClipInput, axisDeg: number, lastResort: boolean): SkadisClipLayout | undefined {
  const { flangeOutline, envelopeOutline, thickness, tolerance: c, latch, heavy, avoid } = input;
  const { toXY, project } = basisFor(axisDeg);
  const rim = projectOutline(flangeOutline, project);
  const env = projectOutline(envelopeOutline, project);
  const z = levels(thickness, input.plateThickness, c);
  const halfBand = SKADIS_CLIP_WIDTH / 2 + c;

  const place = (side: number, role: "top" | "bottom"): Placement => {
    const s0 = side - halfBand;
    const s1 = side + halfBand;
    const a = rimAt(rim, s0);
    const b = rimAt(rim, s1);
    if (![a.top, a.bottom, b.top, b.bottom].every(Number.isFinite)) return { side, floor: 0, ok: false };
    const rimUp = (s: number) => (role === "top" ? rimAt(rim, s).top : rimAt(rim, s).bottom);
    const crossesRimAtClearAngle = (s: number, out: number) => Math.abs(rimUp(s + 0.5 * out) - rimUp(s)) <= 0.5 * Math.tan(((90 - SKADIS_NOTCH_MIN_CROSSING_DEG) * Math.PI) / 180);
    if (!crossesRimAtClearAngle(s0, -1) || !crossesRimAtClearAngle(s1, 1)) return { side, floor: 0, ok: false };
    const floor = role === "top" ? Math.min(a.top, b.top) - SKADIS_NOTCH_DEPTH : Math.max(a.bottom, b.bottom) + SKADIS_NOTCH_DEPTH;
    let ok = true;
    for (let i = 0; i <= ENVELOPE_SAMPLES; i++) {
      const e = rimAt(env, s0 + ((s1 - s0) * i) / ENVELOPE_SAMPLES);
      if (!Number.isFinite(e.top)) continue;
      if (role === "top" && floor - SKADIS_JAW_OVERLAP - SKADIS_ENVELOPE_CLEARANCE < e.top) ok = false;
      if (role === "bottom" && floor + SKADIS_JAW_OVERLAP + SKADIS_ENVELOPE_CLEARANCE > e.bottom) ok = false;
    }
    if (ok && avoid && avoid.length >= 3) {
      const inner = role === "top" ? floor - SKADIS_JAW_OVERLAP - CHANNEL_KEEP_OUT : floor + SKADIS_JAW_OVERLAP + CHANNEL_KEEP_OUT;
      const outer = role === "top" ? Math.max(a.top, b.top) + CHANNEL_KEEP_OUT : Math.min(a.bottom, b.bottom) - CHANNEL_KEEP_OUT;
      const lo = Math.min(inner, outer);
      const hi = Math.max(inner, outer);
      const w = halfBand + CHANNEL_KEEP_OUT;
      for (let i = 0; i <= AVOID_SAMPLES_UP && ok; i++) {
        for (let j = 0; j <= AVOID_SAMPLES_SIDE && ok; j++) {
          if (distanceToPolygon(toXY(lo + ((hi - lo) * i) / AVOID_SAMPLES_UP, side - w + (2 * w * j) / AVOID_SAMPLES_SIDE), avoid) < STEM_SEAT_EPSILON) ok = false;
        }
      }
      for (const v of avoid) {
        const q = project(v);
        if (q.up >= lo && q.up <= hi && Math.abs(q.side - side) <= w) ok = false;
      }
    }
    if (ok && input.padFootprints && input.padFootprints.length > 0) {
      const dir = role === "top" ? -1 : 1;
      for (let i = 0; i <= PAD_SAMPLES_UP && ok; i++) {
        for (let j = 0; j <= PAD_SAMPLES_SIDE && ok; j++) {
          const p = toXY(floor + dir * ((SKADIS_JAW_OVERLAP * i) / PAD_SAMPLES_UP), side - halfBand + (2 * halfBand * j) / PAD_SAMPLES_SIDE);
          if (input.padFootprints.some((pad) => distanceToPolygon(p, pad) < LIP_PAD_CLEARANCE)) ok = false;
        }
      }
    }
    return { side, floor, ok };
  };

  const topColumnChoices = heavy ? [[-20, 20], [-60, 60], [0]] : [[0], [-40], [40], [-20, 20]];
  const bottomColumnChoices = lastResort ? LAST_RESORT_BOTTOM_COLUMNS : BOTTOM_COLUMN_CHOICES;
  for (const minClips of MIN_CLIP_COUNTS) {
    for (const topSides of input.primaryOnly ? topColumnChoices.slice(0, 1) : topColumnChoices) {
      const tops = topSides.map((s) => place(s, "top"));
      if (!tops.every((t) => t.ok)) continue;
      const topFloor = Math.min(...tops.map((t) => t.floor));
      for (const bottomSides of input.primaryOnly ? bottomColumnChoices.slice(0, 1) : bottomColumnChoices) {
        if (topSides.length + bottomSides.length < minClips) continue;
        const bottoms = bottomSides.map((s) => place(s, "bottom"));
        if (!bottoms.every((b) => b.ok)) continue;
        return build(axisDeg, topSides, topFloor, bottoms, z, c, latch, toXY, halfBand);
      }
    }
  }
  return undefined;
}

function build(
  axisDeg: number,
  topSides: number[],
  topFloor: number,
  bottoms: Placement[],
  z: Levels,
  c: number,
  latch: boolean,
  toXY: (u: number, s: number) => XY,
  halfBand: number,
): SkadisClipLayout {
  const clips: RimClip[] = [];
  const top = topProfile(topFloor, z, c, latch);
  const originSlot = top.stemUp + SEAT;
  const originSide = topSides[0];
  for (const side of topSides) clips.push({ role: "top", side, floor: topFloor, stemUp: top.stemUp, slotUp: originSlot, profile: top.profile, latch: top.latch });
  for (const b of bottoms) {
    const uB1 = b.floor - c - SKADIS_BIGHT_THICKNESS;
    const parityOdd = Math.round((b.side - originSide) / SKADIS_LATTICE_STEP) % 2 !== 0;
    const stemUp = bottomStem(uB1, b.floor + SKADIS_JAW_OVERLAP, originSlot, parityOdd);
    clips.push({ role: "bottom", side: b.side, floor: b.floor, stemUp, slotUp: stemUp + SEAT, profile: bottomProfile(b.floor, stemUp, z, c) });
  }
  const relief = bightFilletRadius(z, c) - c;
  const notches: XY[][] = [];
  const notchCutters: NotchCutter[] = [];
  for (const clip of clips) {
    const dir = clip.role === "top" ? 1 : -1;
    const far = clip.floor + dir * NOTCH_DEPTH_OUT;
    const near = clip.floor - dir * relief;
    notches.push([toXY(near, clip.side - halfBand), toXY(near, clip.side + halfBand), toXY(far, clip.side + halfBand), toXY(far, clip.side - halfBand)]);
    notchCutters.push({ side0: clip.side - halfBand, width: 2 * halfBand, profile: notchReliefProfile(clip.floor, dir, z, c, relief) });
  }
  return { axisDeg, clips, notches, notchCutters, boardFrontZ: z.boardFront };
}

function notchReliefProfile(floor: number, dir: 1 | -1, z: Levels, c: number, relief: number): Pt[] {
  const bottom = z.outerJawFace + c;
  const top = z.lipUnderside - c;
  const overshoot = WELD_OVERLAP + 1;
  const toward = (u: number): number => floor + dir * (u - floor);
  const back = floor - relief;
  const ring: Pt[] = [
    [back, bottom - overshoot],
    [floor + NOTCH_DEPTH_OUT, bottom - overshoot],
    [floor + NOTCH_DEPTH_OUT, overshoot],
    [back, overshoot],
    ...arcSamples(back, top - relief, relief, Math.PI / 2, -Math.PI / 2),
    [floor, bottom + relief],
    [back, bottom],
  ].map(([u, zz]): Pt => [toward(u), zz]);
  return dir === 1 ? ring : ring.reverse();
}

export function requiredSkadisMargin(outline: ShapeOutline, boreOutline: ShapeOutline, envelopeOffset: number, heavy: boolean, thickness: number, plateThickness: number, tolerance: number): number {
  const envelopeOutline = offsetOutline(outline, lipKeepOffset(envelopeOffset, thickness, plateThickness, tolerance));
  const fits = (margin: number) =>
    layoutSkadisClips({ flangeOutline: offsetOutline(outline, margin), boreOutline, envelopeOutline, thickness, plateThickness, tolerance, latch: false, heavy, primaryOnly: true }).clips.length > 0;
  let lo = 0;
  let hi = 1;
  while (!fits(hi) && hi < MARGIN_SEARCH_LIMIT) hi *= 2;
  for (let i = 0; i < MARGIN_BISECTIONS; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi + MARGIN_ROUNDING;
}

export function clipFrame(axisDeg: number, side: number) {
  const { up, side: sv } = basisFor(axisDeg);
  return {
    up,
    side: sv,
    at: (u: number, zz: number, t: number) => ({ x: u * up.x + (side + t) * sv.x, y: u * up.y + (side + t) * sv.y, z: zz }),
  };
}

export function clipPrintRotateZ(axisDeg: number): number {
  return Math.PI / 2 + (axisDeg * Math.PI) / 180;
}

export function skadisBoardSection(layout: SkadisClipLayout, radius: number): PegboardSection | undefined {
  const first = layout.clips[0];
  if (!first) return undefined;
  return boardSection(layout.axisDeg, first.side, first.slotUp, layout.boardFrontZ, radius);
}

export function boardSection(axisDeg: number, originSide: number, originUp: number, frontZ: number, radius: number): PegboardSection {
  const { toXY } = basisFor(axisDeg);
  const step = SKADIS_LATTICE_STEP;
  const n = Math.ceil((radius + Math.hypot(originSide, originUp)) / step) + 1;
  const slots: XY[] = [];
  for (let a = -n; a <= n; a++) {
    for (let b = -n; b <= n; b++) {
      if (Math.abs(a + b) % 2 !== 0) continue;
      const s = originSide + a * step;
      const u = originUp + b * step;
      if (Math.hypot(s, u) > radius) continue;
      slots.push(toXY(u, s));
    }
  }
  return { slots, slotWidth: SKADIS_SLOT_WIDTH, slotLength: SKADIS_SLOT_LENGTH, thickness: SKADIS_BOARD_THICKNESS, frontZ, axisDeg };
}

export function skadisClipFootprints(layout: SkadisClipLayout): XY[][] {
  return layout.clips.map((clip) => {
    const ups = clip.profile.map(([u]) => u);
    const [lo, hi] = [Math.min(...ups), Math.max(...ups)];
    const { at } = clipFrame(layout.axisDeg, clip.side);
    const w = SKADIS_CLIP_WIDTH / 2;
    return [at(lo, 0, -w), at(hi, 0, -w), at(hi, 0, w), at(lo, 0, w)].map(({ x, y }) => ({ x, y }));
  });
}
