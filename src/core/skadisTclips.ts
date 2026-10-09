// SKÅDIS T-clips (issues #213, #221, docs/mounts.md): a twist lock adapted
// from the Skadis T-Clip System by Line Arc Line (Printables 256896, CC BY
// 4.0). The layout both geometry backends build from. Our own dimensions and
// receiver; nothing is taken from the original's files.
//
// The receivers are inside the bore (issue #221): a floor fills the bottom of
// the bore, printed on the bed with the rest of the core, and each clip has a
// slot through it and a recess in its top face. Nothing sticks out past the
// flange. The clips are reached through the hollow core and the top cap's
// hole: each handle is a tall fin, pinched at its top and turned.
//
// Each clip is a flat "I" in the (u, z) plane -- a fin, a stem and a T bar --
// SKADIS_TCLIP_WIDTH thick across (t), printed lying on that face. It is
// built from convex pieces, each a chamfered prism (every edge chamfered:
// the profile's corners and both faces' edges), unioned; the backends build
// each piece as the hull of its four levels (mesh) or the loft through them
// (STEP), the same solid either way. u runs along the bars; z is the
// assembly frame's (the flange and the floor are z = [-T, 0], and the
// board's front face is their outer face, z = -T).
//
// Fitting one:
//   1. Hold the coil on the board, each floor slot over a board slot. Push
//      the clip through both with its bars upright: the T bar passes the
//      board's slot at the slot's centre (`insertUp`).
//   2. Turn it a quarter turn clockwise (seen from the room) until the fin
//      stops in the recess: the T bar now spans the slot behind the board,
//      and the fin bears on the recess floor.
//   3. Let go: the coil and its clips drop together until the stems rest on
//      the bottoms of the board's slots (the clips' axes at `axisUp`). The
//      floor hangs on the fins (the recess's across arm sits on them).
//
// How many: 3 when they fit -- 1 above the centre of mass (column 0) and 2
// below it (columns ±20 or ±40), on one of SKÅDIS's two interleaved 40 mm
// grids. A smaller bore takes 2 (a pair the coil hangs straight from) or 1
// (straight above the centre of mass); none at all, and the mount is left
// out with a warning.

import {
  CAP_THICKNESS,
  JOINT_ENGAGE_DEPTH,
  SKADIS_SLOT_LENGTH,
  SKADIS_SLOT_WIDTH,
  SKADIS_TCLIP_BAR_LENGTH,
  SKADIS_TCLIP_BAR_THICKNESS,
  SKADIS_TCLIP_CLAMPED_BOARD_THICKNESS,
  SKADIS_TCLIP_CHAMFER,
  SKADIS_TCLIP_FIN_MAX,
  SKADIS_TCLIP_FIN_TOP_GAP,
  SKADIS_TCLIP_HAND_WIDTH,
  SKADIS_TCLIP_FLOOR_WALL,
  SKADIS_TCLIP_HANDLE_LENGTH,
  SKADIS_TCLIP_HANDLE_THICKNESS,
  SKADIS_TCLIP_LEAD_IN,
  SKADIS_TCLIP_RAMP,
  SKADIS_TCLIP_RAMP_LENGTH,
  SKADIS_TCLIP_REACH_DEPTH,
  SKADIS_TCLIP_REACH_MARGIN,
  SKADIS_TCLIP_RECESS_DEPTH,
  SKADIS_TCLIP_SLOT_CLEARANCE,
  SKADIS_TCLIP_STEM,
  SKADIS_TCLIP_STEM_CHAMFER,
  SKADIS_TCLIP_WIDTH,
  WELD_OVERLAP,
} from "./constants";
import type { XY } from "./innerEnd";
import { bestAxisDeg } from "./mount";
import { basisFor, boardSection, chamferCorners } from "./skadisClips";
import { outlineOffsetAt } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { PegboardSection } from "./types";

type Pt = [number, number];

/** One convex piece of a clip: its (u, z) polygon (counter-clockwise) and how far its faces' edges are chamfered. */
export interface TclipPiece {
  poly: Pt[];
  chamfer: number;
}

export interface Tclip {
  /** The clip's axis along side. */
  side: number;
  /** The clip's axis along up, seated (its stem on the bottom of the slot). */
  axisUp: number;
  /** The board slot's centre along up (nominal slot): where the clip goes in and turns. */
  insertUp: number;
  /** The clip's convex pieces (the fin, the stem, the T bar). */
  pieces: TclipPiece[];
}

/** A convex cutter: closed polygons in the flange plane at rising z, all with the same vertex count (the backends hull or loft through them). */
export interface TclipCutter {
  levels: Array<{ z: number; poly: XY[] }>;
}

export interface SkadisTclipLayout {
  axisDeg: number;
  clips: Tclip[];
  /** Per clip: the cutters for its slot and its recess (with their 45 degree lead-ins). */
  cutters: TclipCutter[][];
  /** The fin's top (z), and how far it sits below the core's top. */
  finTop: number;
  reachDepth: number;
  /** The board's front face (z): the floor's and the flange's outer face. */
  boardFrontZ: number;
  /** Set when fewer than 3 clips fit (a note), or none (a problem: the mount is left out). */
  note?: string;
  warning?: string;
}

export interface SkadisTclipInput {
  boreOutline: ShapeOutline;
  /** The top cap's hole, when there is a cap: each fin's top must be reachable through it. */
  capHole?: ShapeOutline;
  ring?: { holeOutline: ShapeOutline; funnelFloor: number };
  /** The wall's top (z), the core's winding height. */
  wallTop: number;
  /** The flange's (and the floor's) full thickness T. */
  thickness: number;
  tolerance: number;
}

const W = SKADIS_TCLIP_WIDTH;
const RECESS_H = SKADIS_TCLIP_HANDLE_LENGTH / 2;

/** `poly` (convex, counter-clockwise) with every edge moved out by `d` (in for a negative `d`): the same vertices, mitred. */
export function offsetConvex(poly: Pt[], d: number): Pt[] {
  const n = poly.length;
  const lines = poly.map((p, i) => {
    const q = poly[(i + 1) % n];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const nx = (q[1] - p[1]) / len;
    const ny = -(q[0] - p[0]) / len;
    return { px: p[0] + nx * d, py: p[1] + ny * d, dx: q[0] - p[0], dy: q[1] - p[1] };
  });
  return poly.map((_, i) => {
    const a = lines[(i + n - 1) % n];
    const b = lines[i];
    const den = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(den) < 1e-12) return [b.px, b.py];
    const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / den;
    return [a.px + a.dx * t, a.py + a.dy * t];
  });
}

/** The clip's pieces, for a fin reaching `finTop` (z). */
function pieces(thickness: number, finTop: number): TclipPiece[] {
  const zf = -SKADIS_TCLIP_RECESS_DEPTH;
  const zb = -thickness - SKADIS_TCLIP_CLAMPED_BOARD_THICKNESS;
  const zB = zb - SKADIS_TCLIP_BAR_THICKNESS;
  const hl = SKADIS_TCLIP_HANDLE_LENGTH / 2;
  const s = SKADIS_TCLIP_STEM / 2;
  const t = SKADIS_TCLIP_BAR_LENGTH / 2;
  const c = SKADIS_TCLIP_CHAMFER;
  const r = SKADIS_TCLIP_RAMP;
  const rl = SKADIS_TCLIP_RAMP_LENGTH;
  const over = 0.5; // the stem runs this far into the fin and the bar
  const finCorners: Pt[] = [[-hl, zf], [hl, zf], [hl, finTop], [-hl, finTop]];
  const fin = chamferCorners(finCorners, finCorners, c);
  const stem: Pt[] = [[-s, zb - over], [s, zb - over], [s, zf + over], [-s, zf + over]];
  // The T bar's bearing face (on the back of the board) ramps down at both ends: the original's hook ramps.
  const bar = chamferCorners([[-t, zB], [t, zB], [t, zb - r], [t - rl, zb], [-(t - rl), zb], [-t, zb - r]], [[-t, zB], [t, zB]], c);
  return [
    { poly: fin, chamfer: c },
    { poly: stem, chamfer: SKADIS_TCLIP_STEM_CHAMFER },
    { poly: bar, chamfer: c },
  ];
}

/** The stem's outline across the board (side, up from the axis), turned: 2 mm along side, W along up, corners chamfered. */
function stemPlan(): Pt[] {
  const corners: Pt[] = [[-SKADIS_TCLIP_STEM / 2, -W / 2], [SKADIS_TCLIP_STEM / 2, -W / 2], [SKADIS_TCLIP_STEM / 2, W / 2], [-SKADIS_TCLIP_STEM / 2, W / 2]];
  return chamferCorners(corners, corners, SKADIS_TCLIP_STEM_CHAMFER);
}

/** Seated in a slot of this size, how far the clip's axis sits below the slot's centre: the turned stem's lowest points on the slot's rounded bottom. */
export function tclipDrop(slotWidth: number, slotLength: number): number {
  const r = slotWidth / 2;
  const straight = slotLength / 2 - r;
  return Math.min(...stemPlan().filter(([x]) => Math.abs(x) < r).map(([x, y]) => straight + Math.sqrt(r * r - x * x) + y));
}

/** Seated, the clip's axis sits this far below its (nominal) slot's centre. */
export const TCLIP_DROP = tclipDrop(SKADIS_SLOT_WIDTH, SKADIS_SLOT_LENGTH);

/** The recess the fin turns in, round (0, 0) in local (side, up): the upright and across bars, and the two quarter sectors their far corners sweep turning clockwise (seen from the room) -- convex pieces whose union is a bow tie. Its walls stop the fin at both ends of the turn. */
function recessPieces(c: number): Pt[][] {
  const h = RECESS_H + c;
  const w = W / 2 + c;
  const r = Math.hypot(h, w);
  const d = Math.atan2(w, h);
  const steps = 10;
  const sector = (from: number): Pt[] => [[0, 0], ...Array.from({ length: steps + 1 }, (_, i): Pt => {
    const phi = from + d + ((Math.PI / 2) * i) / steps; // clockwise from +up
    return [r * Math.sin(phi), r * Math.cos(phi)];
  }).reverse()];
  const rect = (hx: number, hy: number): Pt[] => [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
  return [rect(w, h), rect(h, w), sector(0), sector(Math.PI)];
}

/** The recess's sweep radius (a clip's corners), for the keep-in. */
export function tclipSweep(c: number): number {
  return Math.hypot(RECESS_H + c, W / 2 + c);
}

/** A stadium (vertical, round-ended) centred on (0, 0) in local (side, up), counter-clockwise. */
function stadium(r: number, half: number, steps = 12): Pt[] {
  const top = Array.from({ length: steps + 1 }, (_, i): Pt => [r * Math.cos((Math.PI * i) / steps), half + r * Math.sin((Math.PI * i) / steps)]);
  const bottom = Array.from({ length: steps + 1 }, (_, i): Pt => [r * Math.cos(Math.PI + (Math.PI * i) / steps), -half + r * Math.sin(Math.PI + (Math.PI * i) / steps)]);
  return [...top, ...bottom];
}

/** The slot and recess cutters for a clip at (`side`, `axisUp`), each a convex loft with a 45 degree lead-in at its mouth. */
function cuttersFor(toXY: (u: number, s: number) => XY, side: number, axisUp: number, thickness: number, c: number): TclipCutter[] {
  const L = SKADIS_TCLIP_LEAD_IN;
  const E = WELD_OVERLAP;
  const place = (poly: Pt[]) => poly.map(([s, u]) => toXY(axisUp + u, side + s));
  // Two convex pieces (a hull of both would bulge over the lead-in's inner corner): the straight prism, then the 45-degree mouth.
  const loft = (poly: Pt[], bottom: number, mouth: number): TclipCutter[] => [
    { levels: [{ z: bottom, poly: place(poly) }, { z: mouth - L + E, poly: place(poly) }] },
    {
      levels: [
        { z: mouth - L, poly: place(poly) },
        { z: mouth, poly: place(offsetConvex(poly, L)) },
        { z: mouth + E, poly: place(offsetConvex(poly, L + E)) },
      ],
    },
  ];
  // The slot through the floor, centred on the clip's axis: the T bar passes it upright, and the stem turns in it. As wide
  // as the recess's upright arm (wider only if the turning stem needs it), so the two make one straight channel; the
  // lead-in is at the recess's mouth, where the T bar goes in.
  const stemRadius = Math.max(...stemPlan().map(([x, y]) => Math.hypot(x, y)));
  const sr = Math.max(W / 2 + c, stemRadius + SKADIS_TCLIP_SLOT_CLEARANCE);
  const barHalfW = W / 2 + c;
  const arc = SKADIS_TCLIP_BAR_LENGTH / 2 + c - Math.sqrt(Math.max(0, sr * sr - barHalfW * barHalfW));
  const zf = -SKADIS_TCLIP_RECESS_DEPTH;
  const slot: TclipCutter = { levels: [{ z: -thickness - E, poly: place(stadium(sr, arc)) }, { z: zf + E, poly: place(stadium(sr, arc)) }] };
  return [slot, ...recessPieces(c).flatMap((p) => loft(p, zf, 0))];
}

/** Is a clip axis at `p` inside the keep-in: its recess's sweep clear of the bore's wall, and (with a cap) a fingertip's reach inside the cap's hole? */
function keptIn(input: SkadisTclipInput, p: XY, keep: number): boolean {
  if (outlineOffsetAt(input.boreOutline, p.x, p.y).offset > -keep) return false;
  if (input.capHole && outlineOffsetAt(input.capHole, p.x, p.y).offset > -SKADIS_TCLIP_REACH_MARGIN) return false;
  if (input.ring && outlineOffsetAt(input.ring.holeOutline, p.x, p.y).offset > -tclipSweep(input.tolerance)) return false;
  return true;
}

/** Lay out the T-clips in the bore: 3 when they fit (1 above the centre, 2 below), else 2, else 1, else none. */
export function layoutSkadisTclips(input: SkadisTclipInput): SkadisTclipLayout {
  const { boreOutline, thickness, tolerance: c, wallTop } = input;
  const axisDeg = bestAxisDeg(boreOutline, 180);
  const { toXY } = basisFor(axisDeg);
  const keep = tclipSweep(c) + SKADIS_TCLIP_FLOOR_WALL;
  const ok = (s: number, u: number) => keptIn(input, toXY(u, s), keep);
  const R = boreOutline.apothem / Math.cos(Math.PI / boreOutline.n) + 1; // a bound on the bore's reach
  const ups: number[] = [];
  for (let u = Math.ceil(R / 0.25) * 0.25; u >= -R; u -= 0.25) ups.push(u);

  // Clip axes, as (side, up). All on one lattice: (20a, 20b) with a + b even, relative to the first.
  let chosen: Pt[] | undefined;
  let note: string | undefined;
  // 3: the top clip at side 0 as high as it can go, and a pair below the centre at side ±20 or ±40, as low as they can go.
  let best: { spread: number; pos: Pt[] } | undefined;
  for (const top of ups) {
    if (top <= 0 || !ok(0, top)) continue;
    for (const side of [20, 40]) {
      for (let k = 1; k <= 12; k++) {
        const dy = side === 20 ? 20 * (2 * k - 1) : 40 * k;
        const bottom = top - dy;
        if (bottom >= 0) continue;
        if (!ok(side, bottom) || !ok(-side, bottom)) continue;
        const spread = top - bottom;
        if (!best || spread > best.spread + 1e-9 || (Math.abs(spread - best.spread) < 1e-9 && Math.abs(top + bottom) < Math.abs(best.pos[0][1] + best.pos[1][1]))) {
          best = { spread, pos: [[0, top], [-side, bottom], [side, bottom]] };
        }
      }
    }
  }
  if (best) chosen = best.pos;
  if (!chosen) {
    // 2: a pair the coil hangs straight from (their midpoint over the centre): one above the other, side by side, or diagonal.
    const pairs: Array<(m: number) => Pt[]> = [
      (m) => [[0, m + 20], [0, m - 20]],
      (m) => [[-20, m], [20, m]],
      (m) => [[-10, m - 10], [10, m + 10]],
    ];
    for (const pair of pairs) {
      for (const m of ups) {
        const pos = pair(m);
        if (pos.every(([s, u]) => ok(s, u))) {
          chosen = pos;
          break;
        }
      }
      if (chosen) break;
    }
    if (chosen) note = "The bore only has room for 2 SKÅDIS T-clips; the coil hangs straight from the pair.";
  }
  if (!chosen) {
    // 1: straight above the centre of mass, as high as it goes. The coil hangs below it like a pendulum.
    const top = ups.find((u) => ok(0, u));
    if (top !== undefined) {
      chosen = [[0, top]];
      note = "The bore only has room for 1 SKÅDIS T-clip: the coil hangs straight below it, and its weight keeps the clip seated in the slot, so neither turns unless you lift the coil.";
    }
  }

  const zf = -SKADIS_TCLIP_RECESS_DEPTH;
  const capOn = !!input.capHole;
  // In a bore too narrow for a hand, the fins rise to the top (a fingertip only pinches there).
  const narrow = -outlineOffsetAt(boreOutline, 0, 0).offset * 2 < SKADIS_TCLIP_HAND_WIDTH;
  const finCeiling = input.ring ? input.ring.funnelFloor : wallTop - (capOn ? JOINT_ENGAGE_DEPTH : 0);
  const finRoom = finCeiling - SKADIS_TCLIP_FIN_TOP_GAP;
  const finTop = Math.max(zf + SKADIS_TCLIP_HANDLE_THICKNESS, narrow ? finRoom : Math.min(zf + SKADIS_TCLIP_FIN_MAX, finRoom));
  const reachDepth = wallTop + (capOn ? CAP_THICKNESS : 0) - finTop;
  if (!chosen) {
    return {
      axisDeg,
      clips: [],
      cutters: [],
      finTop,
      reachDepth,
      boardFrontZ: -thickness,
      warning: "The bore is too small for SKÅDIS T-clips inside it, so they were left out: choose the SKÅDIS rim clips for a core this small.",
    };
  }
  if (reachDepth > SKADIS_TCLIP_REACH_DEPTH) {
    note = `${note ? `${note} ` : ""}The T-clips' fins sit ${reachDepth.toFixed(0)} mm below the core's top: a long reach.`;
  }
  const clipPieces = pieces(thickness, finTop);
  const clips = chosen.map(([side, axisUp]): Tclip => ({ side, axisUp, insertUp: axisUp + TCLIP_DROP, pieces: clipPieces }));
  return {
    axisDeg,
    clips,
    cutters: clips.map((cl) => cuttersFor(toXY, cl.side, cl.axisUp, thickness, c)),
    finTop,
    reachDepth,
    boardFrontZ: -thickness,
    note,
  };
}

/** Every T-clip's mapping from its (u, z) profile and its across offset t into the assembly frame (seated, turned): u along side, t along up, centred on the clip's axis. */
export function tclipFrame(axisDeg: number, clip: Tclip) {
  const { up, side } = basisFor(axisDeg);
  return {
    up,
    side,
    at: (u: number, zz: number, t: number) => ({ x: (clip.side + u) * side.x + (clip.axisUp + t) * up.x, y: (clip.side + u) * side.y + (clip.axisUp + t) * up.y, z: zz }),
  };
}

/** One piece's four levels across the clip (chamfered faces at both ends of the thickness), as points in the assembly frame. */
export function tclipPieceLevels(axisDeg: number, clip: Tclip, piece: TclipPiece): Array<Array<{ x: number; y: number; z: number }>> {
  const { at } = tclipFrame(axisDeg, clip);
  const inset = offsetConvex(piece.poly, -piece.chamfer);
  const h = W / 2;
  return [
    [inset, -h],
    [piece.poly, -h + piece.chamfer],
    [piece.poly, h - piece.chamfer],
    [inset, h],
  ].map(([poly, t]) => (poly as Pt[]).map(([u, z]) => at(u, z, t as number)));
}

/** The print pose: the across (up) axis onto Z, so the clip lies flat on its face (a turn about Z, then a quarter turn about X). */
export function tclipPrintRotateZ(axisDeg: number): number {
  return (axisDeg * Math.PI) / 180;
}

/** The board the T-clips hang on (for the viewer and the guide). */
export function skadisTclipBoardSection(layout: SkadisTclipLayout, radius: number): PegboardSection | undefined {
  const first = layout.clips[0];
  if (!first) return undefined;
  return boardSection(layout.axisDeg, first.side, first.insertUp, layout.boardFrontZ, radius);
}
