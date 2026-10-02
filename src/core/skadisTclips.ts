// SKÅDIS T-clips (issue #213, docs/mounts.md): a twist lock adapted from the
// Skadis T-Clip System by Line Arc Line (Printables 256896, CC BY 4.0). The
// layout both geometry backends build from. Our own dimensions and receiver;
// nothing is taken from the original's files.
//
// Each clip is one flat "I" profile in the (u, z) plane -- a handle, a stem
// and a T bar -- extruded SKADIS_TCLIP_WIDTH and printed lying on that face.
// u runs along the bars; z is the assembly frame's (the flange is
// z = [-T, 0], and the board's front face is the flange's outer face,
// z = -T: the flange is clamped flat to the board).
//
// Each clip sits in a lug on the flange's rim: a round-ended pad with a slot
// through it and a recess in its face that the handle turns in. Fitting one:
//   1. Hold the coil on the board, each lug's slot over a board slot. Push
//      the clip through both with its bars upright: the T bar passes the
//      board's slot at the slot's centre (`insertUp`).
//   2. Turn it a quarter turn clockwise (seen from the room) until the
//      handle stops in the recess: the T bar now spans the slot behind the
//      board, and the handle bears on the recess floor.
//   3. Let go: the coil and its clips drop together until the stems rest on
//      the bottoms of the board's slots (the clips' axes at `axisUp`). The
//      lugs hang on the handles (the recess's across arm sits on them).
// Taking it down: lift the coil back to the slots' centres, turn the clips
// back.
//
// Placement and count follow the rim clips (skadisClips.ts): 1 top clip
// (column 0) and 2 bottom clips (columns ±20), or 2 + 2 for a heavy cable,
// every board slot on one of SKÅDIS's two interleaved 40 mm grids. Each lug
// reaches out past the wound cable, so the flange's own margin never grows.

import {
  FLANGE_PAD_WALL,
  SKADIS_LATTICE_STEP,
  SKADIS_SLOT_LENGTH,
  SKADIS_SLOT_WIDTH,
  SKADIS_TCLIP_BAR_LENGTH,
  SKADIS_TCLIP_BAR_THICKNESS,
  SKADIS_TCLIP_BOARD,
  SKADIS_TCLIP_ENVELOPE_CLEARANCE,
  SKADIS_TCLIP_HANDLE_LENGTH,
  SKADIS_TCLIP_HANDLE_THICKNESS,
  SKADIS_TCLIP_LUG_WALL,
  SKADIS_TCLIP_RECESS_DEPTH,
  SKADIS_TCLIP_SLOT_CLEARANCE,
  SKADIS_TCLIP_STEM,
  SKADIS_TCLIP_WIDTH,
} from "./constants";
import type { XY } from "./innerEnd";
import { bestAxisDeg } from "./mount";
import { basisFor, boardSection, distanceToPolygon, projectOutline, rimAt, tidy } from "./skadisClips";
import type { ShapeOutline } from "./shapes";
import type { PegboardSection } from "./types";

export interface Tclip {
  role: "top" | "bottom";
  /** The clip's axis along side. */
  side: number;
  /** The clip's axis along up, seated (its stem on the bottom of the slot). */
  axisUp: number;
  /** The board slot's centre along up (nominal slot): where the clip goes in and turns. */
  insertUp: number;
  /** The closed (u, z) profile, counter-clockwise; u along the bars. */
  profile: Array<[number, number]>;
}

export interface SkadisTclipLayout {
  axisDeg: number;
  clips: Tclip[];
  /** Per clip: the lug added to the flange (a closed polygon in the flange plane, z = [-T, 0]). */
  lugs: XY[][];
  /** Per clip: the slot through the lug. */
  slots: XY[][];
  /** Per clip: the handle's recess in the lug's face, z = [-SKADIS_TCLIP_RECESS_DEPTH, 0], as polygons to union (the quarter-turn sweep). */
  recesses: XY[][][];
  /** Stadium pads (flangePads.ts) that keep the flange full thickness where a lug overlaps it. */
  pads: Array<{ a: XY; b: XY; radius: number }>;
  /** The board's front face (z): the flange's outer face. */
  boardFrontZ: number;
  warning?: string;
}

export interface SkadisTclipInput {
  /** The flange's true outer outline (the core's outline offset by the margin). */
  flangeOutline: ShapeOutline;
  boreOutline: ShapeOutline;
  /** The wound cable's outer surface: the recesses keep clear of it. */
  envelopeOutline: ShapeOutline;
  /** The flange's full thickness T. */
  thickness: number;
  tolerance: number;
  heavy: boolean;
  /** The inner-end channel's footprint: no lug goes near it. */
  avoid?: XY[];
}

const W = SKADIS_TCLIP_WIDTH;
/** Where a stem `halfWidth` wide rests in a slot: its lower corners on the rounded end, this far up from the slot's very bottom. */
const rest = (slotWidth: number, halfWidth: number) => slotWidth / 2 - Math.sqrt((slotWidth / 2) ** 2 - halfWidth ** 2);
/** Seated, the clip's axis sits this far below its (nominal) slot's centre: the stem, W tall once turned, rests on the slot's bottom. */
export const TCLIP_DROP = SKADIS_SLOT_LENGTH / 2 - rest(SKADIS_SLOT_WIDTH, SKADIS_TCLIP_STEM / 2) - W / 2;

/** The handle's recess half-extents, with clearance: `h` along the handle, `w` across it, and the radius its corners sweep. */
function recessDims(c: number) {
  const h = SKADIS_TCLIP_HANDLE_LENGTH / 2 + c;
  const w = W / 2 + c;
  return { h, w, r: Math.hypot(h, w) };
}

/**
 * The region the handle sweeps turning a quarter turn clockwise (seen from
 * the room) about (0, 0), from upright to across, in local (side, up)
 * coordinates: the upright and across bars, and the two quarter arcs their
 * far corners trace (a bow tie). The recess's walls stop the handle at both
 * ends of the turn.
 */
function quarterTurn(h: number, w: number, r: number, steps = 12): Array<[number, number]> {
  const d = Math.atan2(w, h); // a corner's angle off the bar's axis
  const arc = (from: number, to: number): Array<[number, number]> =>
    Array.from({ length: steps + 1 }, (_, i) => {
      const phi = from + ((to - from) * i) / steps; // clockwise from +up
      return [r * Math.sin(phi), r * Math.cos(phi)];
    });
  return [
    [-w, h],
    ...arc(d, Math.PI / 2 + d), // (w, h) round to (h, -w)
    [w, -w],
    [w, -h],
    ...arc(Math.PI + d, (3 * Math.PI) / 2 + d), // (-w, -h) round to (-h, w)
    [-w, w],
  ];
}

/** A closed stadium polygon from `a` to `b` at radius `r`. */
function stadium(a: XY, b: XY, r: number, steps = 16): XY[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const base = len > 1e-9 ? Math.atan2(b.y - a.y, b.x - a.x) : 0;
  const pts: XY[] = [];
  for (let i = 0; i <= steps; i++) {
    const phi = base - Math.PI / 2 + (Math.PI * i) / steps;
    pts.push({ x: b.x + r * Math.cos(phi), y: b.y + r * Math.sin(phi) });
  }
  for (let i = 0; i <= steps; i++) {
    const phi = base + Math.PI / 2 + (Math.PI * i) / steps;
    pts.push({ x: a.x + r * Math.cos(phi), y: a.y + r * Math.sin(phi) });
  }
  return pts;
}

/** The clip's "I" profile: handle on the recess floor, T bar on the back of the thickest board. */
function profile(thickness: number): Array<[number, number]> {
  const zf = -SKADIS_TCLIP_RECESS_DEPTH;
  const zh = zf + SKADIS_TCLIP_HANDLE_THICKNESS;
  const zb = -thickness - SKADIS_TCLIP_BOARD;
  const zB = zb - SKADIS_TCLIP_BAR_THICKNESS;
  const hl = SKADIS_TCLIP_HANDLE_LENGTH / 2;
  const s = SKADIS_TCLIP_STEM / 2;
  const t = SKADIS_TCLIP_BAR_LENGTH / 2;
  return tidy([
    [-hl, zf],
    [-s, zf],
    [-s, zb],
    [-t, zb],
    [-t, zB],
    [t, zB],
    [t, zb],
    [s, zb],
    [s, zf],
    [hl, zf],
    [hl, zh],
    [-hl, zh],
  ]);
}

/** The lug, its slot, the recess and the pad for one clip at `side`, seated at `axisUp` and put in at `insertUp`; the lug runs from the clip into the flange as far as `inner` (along up). */
function lugFor(toXY: (u: number, s: number) => XY, side: number, axisUp: number, insertUp: number, c: number, inner: number) {
  const { h, w, r } = recessDims(c);
  const R = r + SKADIS_TCLIP_LUG_WALL;
  const lo = Math.min(axisUp, insertUp, inner);
  const hi = Math.max(axisUp, insertUp, inner);
  const lug = stadium(toXY(lo, side), toXY(hi, side), R);
  // The slot, centred on the clip's axis: the T bar passes it upright, and the stem turns in it.
  const sr = SKADIS_SLOT_WIDTH / 2 + SKADIS_TCLIP_SLOT_CLEARANCE;
  const barHalfW = W / 2 + c;
  const arc = SKADIS_TCLIP_BAR_LENGTH / 2 + c - Math.sqrt(Math.max(0, sr * sr - barHalfW * barHalfW)); // the arcs' centres clear the bar's corners
  const slot = stadium(toXY(axisUp - arc, side), toXY(axisUp + arc, side), sr);
  // The recess, round the axis: the handle's quarter turn. Turned, the handle sits in its across arm, whose upper
  // edge rests on the handle's left half: that carries the coil.
  const turn = quarterTurn(h, w, r);
  // Full thickness wherever the lug overlaps the flange (the pad's chamfer runs out beyond it).
  const pad = { a: toXY(lo, side), b: toXY(hi, side), radius: R - FLANGE_PAD_WALL };
  return { lug, slot, recess: [turn.map(([s, u]) => toXY(axisUp + u, side + s))], pad };
}

const CHANNEL_KEEP_OUT = 3;

/** Lay out the T-clips, like the rim clips: the default columns first, then fallbacks for a channel in the way, on the flat-bottomed axis and then the flat-topped one. */
export function layoutSkadisTclips(input: SkadisTclipInput): SkadisTclipLayout {
  const axes = [bestAxisDeg(input.boreOutline, 180)];
  const flatTop = bestAxisDeg(input.boreOutline, 0);
  if (Math.abs(flatTop - axes[0]) > 1e-6) axes.push(flatTop);
  for (const axisDeg of axes) {
    const layout = layoutOnAxis(input, axisDeg);
    if (layout) return layout;
  }
  return {
    axisDeg: axes[0],
    clips: [],
    lugs: [],
    slots: [],
    recesses: [],
    pads: [],
    boardFrontZ: -input.thickness,
    warning: "The inner cable end's channel is in the way of every SKÅDIS T-clip position, so they were left out.",
  };
}

function layoutOnAxis(input: SkadisTclipInput, axisDeg: number): SkadisTclipLayout | undefined {
  const { flangeOutline, envelopeOutline, thickness, tolerance: c, heavy, avoid } = input;
  const { toXY, project } = basisFor(axisDeg);
  const rim = projectOutline(flangeOutline, project);
  const env = projectOutline(envelopeOutline, project);
  const { r } = recessDims(c);
  const R = r + SKADIS_TCLIP_LUG_WALL;
  const clear = r + SKADIS_TCLIP_ENVELOPE_CLEARANCE;

  /** The wound cable's extent across a lug's band, and the rim's, at `side`. */
  const band = (side: number) => {
    let envTop = -Infinity;
    let envBottom = Infinity;
    let rimTop = Infinity;
    let rimBottom = -Infinity;
    for (let i = 0; i <= 16; i++) {
      const s = side - R + (2 * R * i) / 16;
      const e = rimAt(env, s);
      if (Number.isFinite(e.top)) {
        envTop = Math.max(envTop, e.top);
        envBottom = Math.min(envBottom, e.bottom);
      }
      const f = rimAt(rim, s);
      if (Number.isFinite(f.top)) {
        rimTop = Math.min(rimTop, f.top);
        rimBottom = Math.max(rimBottom, f.bottom);
      }
    }
    return { envTop, envBottom, rimTop, rimBottom };
  };

  type Placed = { clip: Tclip; parts: ReturnType<typeof lugFor> };
  const z = profile(thickness);
  const placeTop = (side: number, originUp?: number, lift = 0): Placed | undefined => {
    const b = band(side);
    if (!Number.isFinite(b.envTop) || !Number.isFinite(b.rimTop)) return undefined;
    // The recess's bottom (round the seated axis) clears the cable; the first top clip sets the board's origin.
    let axisUp = b.envTop + clear + lift;
    if (originUp !== undefined) axisUp = originUp - TCLIP_DROP;
    const insertUp = axisUp + TCLIP_DROP;
    // The lug's round inner end reaches 3 mm in past the rim (never into the bore or the wall).
    const parts = lugFor(toXY, side, axisUp, insertUp, c, Math.min(axisUp, b.rimTop - 3 + R));
    return { clip: { role: "top", side, axisUp, insertUp, profile: z }, parts };
  };
  const placeBottom = (side: number, originSide: number, originUp: number): (Placed & { slack: number }) | undefined => {
    const b = band(side);
    if (!Number.isFinite(b.envBottom) || !Number.isFinite(b.rimBottom)) return undefined;
    // The highest slot on the right one of the two grids whose recess top (round the insertion axis) clears the cable.
    const odd = Math.round((side - originSide) / SKADIS_LATTICE_STEP) % 2 !== 0;
    let k = Math.floor((b.envBottom - clear - originUp) / SKADIS_LATTICE_STEP);
    if ((Math.abs(k) % 2 === 1) !== odd) k -= 1;
    const insertUp = originUp + k * SKADIS_LATTICE_STEP;
    const axisUp = insertUp - TCLIP_DROP;
    const parts = lugFor(toXY, side, axisUp, insertUp, c, Math.max(insertUp, b.rimBottom + 3 - R));
    return { clip: { role: "bottom", side, axisUp, insertUp, profile: z }, parts, slack: b.envBottom - clear - insertUp };
  };
  const clearOfChannel = (p: Placed) => {
    if (!avoid || avoid.length < 3) return true;
    for (const v of p.parts.lug) if (distanceToPolygon(v, avoid) < CHANNEL_KEEP_OUT) return false;
    for (const v of avoid) if (distanceToPolygon(v, p.parts.lug) < CHANNEL_KEEP_OUT) return false;
    return true;
  };

  const topChoices = heavy ? [[-20, 20], [-60, 60], [0]] : [[0], [-40], [40], [-20, 20]];
  const bottomChoices = [[-20, 20], [-60, 60], [-20, -60], [20, 60], [0]];
  for (const minClips of [3, 2]) {
    for (const topSides of topChoices) {
      for (const bottomSides of bottomChoices) {
        if (topSides.length + bottomSides.length < minClips) continue;
        // The bottom slots land on a 40 mm grid, so they can sit up to 40 mm below the cable: lift the top clip by
        // half that slack, which brings the bottom ones up by the other half (shorter lugs at both ends).
        const trial = placeTop(topSides[0]);
        if (!trial) continue;
        const slack = Math.min(...bottomSides.map((s) => placeBottom(s, topSides[0], trial.clip.insertUp)?.slack ?? 0));
        const first = placeTop(topSides[0], undefined, Math.max(0, slack) / 2)!;
        const tops = [first, ...topSides.slice(1).map((s) => placeTop(s, first.clip.insertUp))];
        if (!tops.every((t): t is Placed => !!t && clearOfChannel(t))) continue;
        const bottoms = bottomSides.map((s) => placeBottom(s, topSides[0], first.clip.insertUp));
        if (!bottoms.every((b): b is Placed & { slack: number } => !!b && clearOfChannel(b))) continue;
        const all = [...(tops as Placed[]), ...(bottoms as Placed[])];
        return {
          axisDeg,
          clips: all.map((p) => p.clip),
          lugs: all.map((p) => p.parts.lug),
          slots: all.map((p) => p.parts.slot),
          recesses: all.map((p) => p.parts.recess),
          pads: all.map((p) => p.parts.pad),
          boardFrontZ: -thickness,
        };
      }
    }
  }
  return undefined;
}

/** Every T-clip's mapping from its (u, z) profile, extruded across the clip, into the assembly frame (seated, turned): u along side, the extrusion along up, centred on the clip's axis. */
export function tclipFrame(axisDeg: number, clip: Tclip) {
  const { up, side } = basisFor(axisDeg);
  return {
    up,
    side,
    at: (u: number, zz: number, t: number) => ({ x: (clip.side + u) * side.x + (clip.axisUp + t) * up.x, y: (clip.side + u) * side.y + (clip.axisUp + t) * up.y, z: zz }),
  };
}

/** The print pose: the extrusion (up) axis onto Z, so the clip lies flat on its face (a turn about Z, then a quarter turn about X). */
export function tclipPrintRotateZ(axisDeg: number): number {
  return (axisDeg * Math.PI) / 180;
}

/** The board the T-clips hang on (for the viewer and the guide). */
export function skadisTclipBoardSection(layout: SkadisTclipLayout, radius: number): PegboardSection | undefined {
  const first = layout.clips[0];
  if (!first) return undefined;
  return boardSection(layout.axisDeg, first.side, first.insertUp, layout.boardFrontZ, radius);
}
