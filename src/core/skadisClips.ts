// SKÅDIS rim clips (issue #207, docs/mounts.md): the layout both geometry
// backends build from. There is no plate: separate clips hook the board's
// slots and wrap the bottom flange's rim, each in a small notch.
//
// Frame: like mount.ts, "up" = (sin a, cos a) and "side" = (cos a, -sin a)
// for the chosen axis a (degrees). Every clip is one closed polygon in the
// (up, z) plane, extruded SKADIS_CLIP_WIDTH along side, centred on the clip's
// `side`. z is the assembly frame's: the flange is z = [-T, 0] (T its full
// thickness, on the pads), and the board's front face is at
// z = -T - SKADIS_STANDOFF.
//
// The axis puts a flat at the bottom where the shape has one (a square sits on
// a side, a triangle on a side with its apex up), so the bottom clips cradle
// the coil on a flat. 1 top clip (column 0) and 2 bottom clips (columns
// ±20), or 2 + 2 above SKADIS_HEAVY_CABLE_KG of cable. The first top clip's
// slot is the board's origin; every other clip picks the nearest slot on the
// same one of SKÅDIS's two interleaved 40 mm grids ((20a, 20b), a + b even),
// and its spine absorbs the difference.
//
// Seated means each stem rests on the bottom of a nominal 5 x 15 mm slot:
// the stem's lower corners on the slot's rounded end.

import {
  CABLE_DENSITY,
  SKADIS_BIGHT_THICKNESS,
  SKADIS_BOARD_THICKNESS,
  SKADIS_BOARD_THICKNESS_MAX,
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
  SKADIS_SLOT_LENGTH,
  SKADIS_SLOT_LENGTH_MIN,
  SKADIS_SLOT_WIDTH,
  SKADIS_SLOT_WIDTH_MIN,
  SKADIS_STANDOFF,
  SKADIS_STEM_HEIGHT,
  SKADIS_TONGUE_GAP,
  SKADIS_TONGUE_LENGTH,
  SKADIS_TONGUE_THICKNESS,
} from "./constants";
import type { XY } from "./innerEnd";
import { bestAxisDeg } from "./mount";
import { offsetOutline, pointAt } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { PegboardSection } from "./types";

export interface RimClip {
  /** "top" clips hook over the top rim and carry the latch; "bottom" clips cradle the bottom rim and carry the weight. */
  role: "top" | "bottom";
  /** The clip's centre along side, mm. */
  side: number;
  /** The notch floor along up: the rim the bight wraps. */
  floor: number;
  /** The stem's bottom along up, seated. */
  stemUp: number;
  /** The centre of the clip's slot along up (nominal slot). */
  slotUp: number;
  /** The closed (up, z) profile, counter-clockwise. */
  profile: Array<[number, number]>;
  /** Present on a latched clip: the tooth, for the fit test and the docs. */
  latch?: { toothTop: number; toothBottom: number; depth: number; armReach: number };
}

export interface SkadisClipLayout {
  axisDeg: number;
  clips: RimClip[];
  /** Cut through the flange at each clip (closed polygons in the flange plane). */
  notches: XY[][];
  /** Stadium pads (flangePads.ts) that bring the flange to full thickness under each clip's jaws. */
  pads: Array<{ a: XY; b: XY; radius: number }>;
  /** The board's front face (z). */
  boardFrontZ: number;
  /** Set when no clip arrangement fits (no clips then). */
  warning?: string;
}

export interface SkadisClipInput {
  /** The flange's true outer outline (the core's outline offset by the margin). */
  flangeOutline: ShapeOutline;
  boreOutline: ShapeOutline;
  /** The wound cable's outer surface, as an outline (the lips keep clear of it). */
  envelopeOutline: ShapeOutline;
  /** The flange's full thickness T. */
  thickness: number;
  tolerance: number;
  latch: boolean;
  heavy: boolean;
  /** The inner-end channel's footprint: no clip goes near it. */
  avoid?: XY[];
  /** Only the default columns (flange.ts sizes the margin for those; the others are a fallback for a channel in the way). */
  primaryOnly?: boolean;
}

/** The estimated cable weight (kg): its cross-section at CABLE_DENSITY. */
export function cableWeightKg(diameter: number, length: number): number {
  return (CABLE_DENSITY * Math.PI * (diameter / 2) ** 2 * length) / 1000;
}

/** Whether this cable gets a second top clip (SKADIS_HEAVY_CABLE_KG). */
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

/** The rim's top and bottom (along up) where it crosses side = s. */
export function rimAt(boundary: Array<{ up: number; side: number }>, s: number): { top: number; bottom: number } {
  let top = -Infinity;
  let bottom = Infinity;
  for (let i = 0; i < boundary.length; i++) {
    const p = boundary[i];
    const q = boundary[(i + 1) % boundary.length];
    if ((p.side - s) * (q.side - s) > 0 || Math.abs(q.side - p.side) < 1e-12) continue;
    const u = p.up + ((s - p.side) / (q.side - p.side)) * (q.up - p.up);
    top = Math.max(top, u);
    bottom = Math.min(bottom, u);
  }
  return { top, bottom };
}

export function projectOutline(o: ShapeOutline, project: (p: XY) => { up: number; side: number }, samples = 720) {
  const pts: Array<{ up: number; side: number }> = [];
  for (let i = 0; i < samples; i++) pts.push(project(pointAt(o, i / samples, 0)));
  return pts;
}

/** The seated stem's bottom, measured down from its slot's centre, in a slot of this size (the stem's lower corners on the rounded end). */
export function stemSeat(slotWidth: number, slotLength: number): number {
  const r = slotWidth / 2;
  const w = SKADIS_CLIP_WIDTH / 2;
  return slotLength / 2 - (r - Math.sqrt(r * r - w * w));
}
/** The full-width part of a slot for the clip (its half length). */
function fullWidthHalf(slotWidth: number, slotLength: number): number {
  return stemSeat(slotWidth, slotLength);
}

const SEAT = stemSeat(SKADIS_SLOT_WIDTH, SKADIS_SLOT_LENGTH);

/** Counter-clockwise, consecutive duplicates removed. */
export function tidy(points: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const p of points) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 1e-9 || Math.abs(q[1] - p[1]) > 1e-9) out.push(p);
  }
  if (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) < 1e-9 && Math.abs(out[0][1] - out[out.length - 1][1]) < 1e-9) out.pop();
  let area = 0;
  for (let i = 0; i < out.length; i++) {
    const [x0, y0] = out[i];
    const [x1, y1] = out[(i + 1) % out.length];
    area += x0 * y1 - x1 * y0;
  }
  return area < 0 ? out.reverse() : out;
}

interface Levels {
  zb: number; // board front
  zt: number; // tongue's retaining face
  zT: number; // tongue's back
  zj: number; // outer jaw's flange-facing face
  zl0: number; // lip's underside
  zl1: number; // lip's top
}

function levels(thickness: number, tolerance: number): Levels {
  const zb = -thickness - SKADIS_STANDOFF;
  const zt = zb - SKADIS_BOARD_THICKNESS_MAX - SKADIS_TONGUE_GAP;
  return { zb, zt, zT: zt - SKADIS_TONGUE_THICKNESS, zj: -thickness - tolerance, zl0: tolerance, zl1: tolerance + SKADIS_LIP_THICKNESS };
}

/** The top clip's profile: jaws round the rim at `floor`, the stem right above the bight, and (latched) the arm, mast and tooth above the stem. */
function topProfile(floor: number, z: Levels, c: number, latch: boolean): { profile: Array<[number, number]>; stemUp: number; latch?: RimClip["latch"] } {
  const uL = floor - SKADIS_JAW_OVERLAP;
  const uB0 = floor + c;
  const us = uB0 + SKADIS_BIGHT_THICKNESS;
  const uH = us + SKADIS_STEM_HEIGHT;
  const uTl = us - SKADIS_TONGUE_LENGTH;
  const base: Array<[number, number]> = [
    [uL, z.zb],
    [uL, z.zj],
    [uB0, z.zj],
    [uB0, z.zl0],
    [uL, z.zl0],
    [uL, z.zl1],
    [uH, z.zl1],
  ];
  const stem: Array<[number, number]> = [
    [uH, z.zT],
    [uTl, z.zT],
    [uTl, z.zt],
    [us, z.zt],
    [us, z.zb],
  ];
  if (!latch) return { profile: tidy([...base, ...stem]), stemUp: us };

  // The tooth: its top a SKADIS_LATCH_LIFT below the top of the tightest
  // slot's full-width part once seated (the stem then sits that slot's seat
  // above the nominal one, which only adds to the margin).
  const slotTopTight = us + 2 * fullWidthHalf(SKADIS_SLOT_WIDTH_MIN, SKADIS_SLOT_LENGTH_MIN);
  const uT1 = slotTopTight - SKADIS_LATCH_LIFT;
  const uT0 = uT1 - SKADIS_LATCH_TOOTH_LENGTH;
  const dt = SKADIS_LATCH_TOOTH_DEPTH;
  const uT2 = uT1 + dt * Math.tan((SKADIS_LATCH_FACE_DEG * Math.PI) / 180);
  const uA0 = uH + SKADIS_LATCH_END_GAP;
  const uR0 = (uT0 + uT1) / 2 + SKADIS_LATCH_ARM_REACH;
  const uR1 = uR0 + SKADIS_LATCH_ROOT;
  const zA1 = z.zb + SKADIS_LATCH_ARM_THICKNESS;
  const zM0 = zA1 + SKADIS_LATCH_SLIT;
  const zM1 = zM0 + SKADIS_LATCH_MAST_THICKNESS;
  const latchPts: Array<[number, number]> = [
    [uH, zM1],
    [uR1, zM1],
    [uR1, z.zb],
    [uT2, z.zb],
    [uT1, z.zb - dt],
    [uT0, z.zb - dt],
    [Math.max(uA0, uT0 - dt), z.zb],
    [uA0, z.zb],
    [uA0, zA1],
    [uR0, zA1],
    [uR0, zM0],
    [uH, zM0],
  ];
  return {
    profile: tidy([...base, ...latchPts, ...stem]),
    stemUp: us,
    latch: { toothTop: uT1, toothBottom: uT0, depth: dt, armReach: SKADIS_LATCH_ARM_REACH },
  };
}

/** A bottom clip's profile: the bight under the rim at `floor` (negative up), the lip and outer jaw rising from it, and the stem at `stemUp` -- behind the outer jaw, or below the bight on a short spine. */
function bottomProfile(floor: number, stemUp: number, z: Levels, c: number): Array<[number, number]> {
  const uB0 = floor - c;
  const uB1 = uB0 - SKADIS_BIGHT_THICKNESS;
  const uJ = floor + SKADIS_JAW_OVERLAP;
  const sTop = stemUp + SKADIS_STEM_HEIGHT;
  const uTl = stemUp - SKADIS_TONGUE_LENGTH;
  const stem: Array<[number, number]> = [
    [sTop, z.zb],
    [sTop, z.zT],
    [uTl, z.zT],
    [uTl, z.zt],
    [stemUp, z.zt],
    [stemUp, z.zb],
  ];
  if (stemUp >= uB1 - 1e-9) {
    // Inside: the outer jaw runs up past the stem.
    const top = Math.max(uJ, sTop);
    return tidy([[uB1, z.zl1], [uJ, z.zl1], [uJ, z.zl0], [uB0, z.zl0], [uB0, z.zj], [top, z.zj], [top, z.zb], ...stem, [uB1, z.zb]]);
  }
  // Below: a spine as deep as the bight joins it to the stem.
  return tidy([[stemUp, z.zl1], [uJ, z.zl1], [uJ, z.zl0], [uB0, z.zl0], [uB0, z.zj], [uJ, z.zj], [uJ, z.zb], ...stem]);
}

/** The nearest stem position (along up) on a lattice row with the given parity, to a clip whose bight bottom is at `uB1`. */
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
    if (len < bestLen - 1e-9) {
      bestLen = len;
      best = stemUp;
    }
  }
  return best;
}

/** Distance from `p` to a closed polygon (0 inside). */
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
    const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return inside ? 0 : best;
}

/** How far a clip's flange footprint keeps from the inner-end channel (its pad wall plus a little). */
const CHANNEL_KEEP_OUT = 4;

interface Placement {
  side: number;
  floor: number;
  /** The clip's footprint on the flange (notch, pad, jaws), as (up, side) samples. */
  ok: boolean;
}

/**
 * Lay out the rim clips. Tries column choices in order (the channel may sit
 * where the default ones would go), on the shape's flat-bottomed axis first
 * and then its flat-topped one (a triangle can hang apex down instead), and
 * returns the first that fits; with none, no clips and a warning.
 */
export function layoutSkadisClips(input: SkadisClipInput): SkadisClipLayout {
  // The axis whose bottom is a flat (fanned 180 degrees: the cheapest bottom), then the one whose top is.
  const axes = [bestAxisDeg(input.boreOutline, 180)];
  const flatTop = bestAxisDeg(input.boreOutline, 0);
  if (!input.primaryOnly && Math.abs(flatTop - axes[0]) > 1e-6) axes.push(flatTop);
  for (const axisDeg of axes) {
    const layout = layoutOnAxis(input, axisDeg);
    if (layout) return layout;
  }
  return {
    axisDeg: axes[0],
    clips: [],
    notches: [],
    pads: [],
    boardFrontZ: levels(input.thickness, input.tolerance).zb,
    warning: "The flange is too small or too crowded for the SKÅDIS rim clips, so they were left out (try a bigger core).",
  };
}

function layoutOnAxis(input: SkadisClipInput, axisDeg: number): SkadisClipLayout | undefined {
  const { flangeOutline, envelopeOutline, thickness, tolerance: c, latch, heavy, avoid } = input;
  const { toXY, project } = basisFor(axisDeg);
  const rim = projectOutline(flangeOutline, project);
  const env = projectOutline(envelopeOutline, project);
  const z = levels(thickness, c);
  const halfBand = SKADIS_CLIP_WIDTH / 2 + c;

  const place = (side: number, role: "top" | "bottom"): Placement => {
    const s0 = side - halfBand;
    const s1 = side + halfBand;
    const a = rimAt(rim, s0);
    const b = rimAt(rim, s1);
    if (![a.top, a.bottom, b.top, b.bottom].every(Number.isFinite)) return { side, floor: 0, ok: false };
    const floor = role === "top" ? Math.min(a.top, b.top) - SKADIS_NOTCH_DEPTH : Math.max(a.bottom, b.bottom) + SKADIS_NOTCH_DEPTH;
    // The jaws reach in SKADIS_JAW_OVERLAP from the floor; the lip keeps clear of the wound cable there.
    let ok = true;
    for (let i = 0; i <= 8; i++) {
      const e = rimAt(env, s0 + ((s1 - s0) * i) / 8);
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
      for (let i = 0; i <= 6 && ok; i++) {
        for (let j = 0; j <= 4 && ok; j++) {
          if (distanceToPolygon(toXY(lo + ((hi - lo) * i) / 6, side - w + (2 * w * j) / 4), avoid) < 1e-9) ok = false;
        }
      }
      for (const v of avoid) {
        const q = project(v);
        if (q.up >= lo && q.up <= hi && Math.abs(q.side - side) <= w) ok = false;
      }
    }
    return { side, floor, ok };
  };

  // The defaults first, then fallbacks for when the inner-end channel is in
  // the way: other columns, a top pair over one bottom clip, or one clip
  // above the other.
  const topChoices = heavy ? [[-20, 20], [-60, 60], [0]] : [[0], [-40], [40], [-20, 20]];
  const bottomChoices = [[-20, 20], [-60, 60], [-20, -60], [20, 60], [0]];
  // Three or more clips if any arrangement allows it; two in one column only as the last resort.
  for (const minClips of [3, 2]) {
    for (const topSides of input.primaryOnly ? topChoices.slice(0, 1) : topChoices) {
      const tops = topSides.map((s) => place(s, "top"));
      if (!tops.every((t) => t.ok)) continue;
      // Symmetric pairs share one floor; an asymmetric outline uses the lower one.
      const topFloor = Math.min(...tops.map((t) => t.floor));
      for (const bottomSides of input.primaryOnly ? bottomChoices.slice(0, 1) : bottomChoices) {
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
  const notches: XY[][] = [];
  const pads: SkadisClipLayout["pads"] = [];
  for (const clip of clips) {
    const dir = clip.role === "top" ? 1 : -1;
    const far = clip.floor + dir * 50;
    notches.push([toXY(clip.floor, clip.side - halfBand), toXY(clip.floor, clip.side + halfBand), toXY(far, clip.side + halfBand), toXY(far, clip.side - halfBand)]);
    pads.push({ a: toXY(clip.floor - dir * (SKADIS_JAW_OVERLAP + 0.5), clip.side), b: toXY(clip.floor + dir * 5, clip.side), radius: halfBand });
  }
  return { axisDeg, clips, notches, pads, boardFrontZ: z.zb };
}

/**
 * The narrowest flange margin at which the clips' lips clear the wound cable
 * (flange.ts grows the margin to at least this). Found by bisection over the
 * real layout, like mountPlate.ts's `requiredMountPlateMargin`; the channel
 * isn't known yet at sizing time, so it's left out here.
 */
export function requiredSkadisMargin(outline: ShapeOutline, boreOutline: ShapeOutline, envelopeOffset: number, heavy: boolean): number {
  const envelopeOutline = offsetOutline(outline, envelopeOffset);
  const fits = (margin: number) =>
    layoutSkadisClips({ flangeOutline: offsetOutline(outline, margin), boreOutline, envelopeOutline, thickness: 5, tolerance: 0.2, latch: false, heavy, primaryOnly: true }).clips.length > 0;
  let lo = 0;
  let hi = 1;
  while (!fits(hi) && hi < 1e4) hi *= 2;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi + 1e-6;
}

/** Every clip's mapping from its own (up, z) profile and side offset t (from the clip's centre) to the assembly frame. */
export function clipFrame(axisDeg: number, side: number) {
  const { up, side: sv } = basisFor(axisDeg);
  return {
    up,
    side: sv,
    /** Profile point (u, z) at side offset t in [-W/2, W/2]. */
    at: (u: number, zz: number, t: number) => ({ x: u * up.x + (side + t) * sv.x, y: u * up.y + (side + t) * sv.y, z: zz }),
  };
}

/** The print pose: the extrusion (side) axis onto Z, so the clip lies flat on its face (types.ts's `RigidTransform.rotateZ`, then a quarter turn about X). */
export function clipPrintRotateZ(axisDeg: number): number {
  return Math.PI / 2 + (axisDeg * Math.PI) / 180;
}

/** The board the clips hang on (for the viewer and the guide): every slot within `radius` of the coil's centre, on the clips' lattice. */
export function skadisBoardSection(layout: SkadisClipLayout, radius: number): PegboardSection | undefined {
  const first = layout.clips[0];
  if (!first) return undefined;
  return boardSection(layout.axisDeg, first.side, first.slotUp, layout.boardFrontZ, radius);
}

/** A SKÅDIS board section: the lattice through the slot at (`originSide`, `originUp`), every slot within `radius` of the coil's centre. Shared by both SKÅDIS mounts. */
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
