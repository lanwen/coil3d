import {
  SKADIS_SLOT_LENGTH,
  SKADIS_SLOT_WIDTH,
  SKADIS_TCLIP_BAR_LENGTH,
  SKADIS_TCLIP_BAR_THICKNESS,
  SKADIS_TCLIP_CLAMPED_BOARD_THICKNESS,
  SKADIS_TCLIP_CHAMFER,
  SKADIS_TCLIP_FIN_HEIGHT,
  SKADIS_TCLIP_FIN_TOP_GAP,
  SKADIS_TCLIP_FLOOR_WALL,
  SKADIS_TCLIP_HANDLE_LENGTH,
  SKADIS_TCLIP_HANDLE_THICKNESS,
  SKADIS_TCLIP_LEAD_IN,
  SKADIS_TCLIP_LEAD_IN_ROOT,
  SKADIS_TCLIP_NOTCH_DEPTH,
  SKADIS_TCLIP_NOTCH_FLOOR,
  SKADIS_TCLIP_NOTCH_LEAD,
  SKADIS_TCLIP_NOTCH_WIDTH,
  SKADIS_TCLIP_RAMP,
  SKADIS_TCLIP_RAMP_LENGTH,
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
import { circumscribedRadius, isPill, outlineOffsetAt } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { PegboardSection } from "./types";

type Pt = [number, number];

export interface TclipPiece {
  poly: Pt[];
  chamfer: number;
}

export interface Tclip {
  side: number;
  axisUp: number;
  insertUp: number;
  pieces: TclipPiece[];
}

export interface TclipCutter {
  levels: Array<{ z: number; poly: XY[] }>;
}

interface TclipRecess {
  bottom: number;
  top: number;
  pieces: XY[][];
}

export interface TclipCutters {
  slot: TclipCutter;
  recess: TclipRecess;
  leadIns: TclipCutter[];
}

export interface SkadisTclipLayout {
  axisDeg: number;
  clips: Tclip[];
  cutters: TclipCutters[];
  finTop: number;
  boardFrontZ: number;
  note?: string;
  warning?: string;
}

interface SkadisTclipInput {
  boreOutline: ShapeOutline;
  capHole?: ShapeOutline;
  ring?: { holeOutline: ShapeOutline; funnelFloor: number };
  wallTop: number;
  engageDepth: number;
  thickness: number;
  tolerance: number;
}

const STEM_OVERLAP = 0.5;
const MIN_NOTCH_DEPTH = 1;
const SEARCH_STEP = 0.25;
const REACH_MARGIN_UP = 1;
const RECESS_SECTOR_STEPS = 10;
const STADIUM_STEPS = 12;
const PARALLEL_EDGE_EPSILON = 1e-12;
const MAX_BOTTOM_ROWS = 12;
const SPREAD_EPSILON = 1e-9;
const NEAR_COLUMN_SIDE = 20;
const FAR_COLUMN_SIDE = 40;
const PAIR_HALF_SPACING = 20;
const DIAGONAL_HALF_SPACING = 10;
const FLAT_BOTTOM_FAN_DEG = 180;

const W = SKADIS_TCLIP_WIDTH;
const RECESS_H = SKADIS_TCLIP_HANDLE_LENGTH / 2;

function offsetConvex(poly: Pt[], d: number): Pt[] {
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
    if (Math.abs(den) < PARALLEL_EDGE_EPSILON) return [b.px, b.py];
    const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / den;
    return [a.px + a.dx * t, a.py + a.dy * t];
  });
}

function finPieces(recessFloor: number, finTop: number, halfFin: number, chamfer: number): Pt[][] {
  const notchDepth = Math.min(SKADIS_TCLIP_NOTCH_DEPTH, finTop - SKADIS_TCLIP_NOTCH_FLOOR);
  const corners: Pt[] = [[-halfFin, recessFloor], [halfFin, recessFloor], [halfFin, finTop], [-halfFin, finTop]];
  if (notchDepth < MIN_NOTCH_DEPTH) return [chamferCorners(corners, corners, chamfer)];
  const notchHalf = SKADIS_TCLIP_NOTCH_WIDTH / 2;
  const notchFloor = finTop - notchDepth;
  const prongRoot = notchFloor - 2 * chamfer;
  const base = chamferCorners([[-halfFin, recessFloor], [halfFin, recessFloor], [halfFin, notchFloor], [-halfFin, notchFloor]], corners, chamfer);
  const prong = (points: Pt[], outerTop: Pt, innerTop: Pt) => chamferCorners(chamferCorners(points, [outerTop], chamfer), [innerTop], SKADIS_TCLIP_NOTCH_LEAD);
  return [
    base,
    prong([[notchHalf, prongRoot], [halfFin, prongRoot], [halfFin, finTop], [notchHalf, finTop]], [halfFin, finTop], [notchHalf, finTop]),
    prong([[-halfFin, prongRoot], [-notchHalf, prongRoot], [-notchHalf, finTop], [-halfFin, finTop]], [-halfFin, finTop], [-notchHalf, finTop]),
  ];
}

function pieces(thickness: number, finTop: number): TclipPiece[] {
  const recessFloor = -SKADIS_TCLIP_RECESS_DEPTH;
  const boardBack = -thickness - SKADIS_TCLIP_CLAMPED_BOARD_THICKNESS;
  const barBottom = boardBack - SKADIS_TCLIP_BAR_THICKNESS;
  const halfFin = SKADIS_TCLIP_HANDLE_LENGTH / 2;
  const halfStem = SKADIS_TCLIP_STEM / 2;
  const halfBar = SKADIS_TCLIP_BAR_LENGTH / 2;
  const chamfer = SKADIS_TCLIP_CHAMFER;
  const rampDepth = SKADIS_TCLIP_RAMP;
  const rampLength = SKADIS_TCLIP_RAMP_LENGTH;
  const fin = finPieces(recessFloor, finTop, halfFin, chamfer);
  const stem: Pt[] = [[-halfStem, boardBack - STEM_OVERLAP], [halfStem, boardBack - STEM_OVERLAP], [halfStem, recessFloor + STEM_OVERLAP], [-halfStem, recessFloor + STEM_OVERLAP]];
  const bar = chamferCorners(
    [[-halfBar, barBottom], [halfBar, barBottom], [halfBar, boardBack - rampDepth], [halfBar - rampLength, boardBack], [-(halfBar - rampLength), boardBack], [-halfBar, boardBack - rampDepth]],
    [[-halfBar, barBottom], [halfBar, barBottom]],
    chamfer,
  );
  return [
    ...fin.map((poly): TclipPiece => ({ poly, chamfer })),
    { poly: stem, chamfer: SKADIS_TCLIP_STEM_CHAMFER },
    { poly: bar, chamfer },
  ];
}

function stemPlan(): Pt[] {
  const corners: Pt[] = [[-SKADIS_TCLIP_STEM / 2, -W / 2], [SKADIS_TCLIP_STEM / 2, -W / 2], [SKADIS_TCLIP_STEM / 2, W / 2], [-SKADIS_TCLIP_STEM / 2, W / 2]];
  return chamferCorners(corners, corners, SKADIS_TCLIP_STEM_CHAMFER);
}

function tclipDrop(slotWidth: number, slotLength: number): number {
  const r = slotWidth / 2;
  const straight = slotLength / 2 - r;
  return Math.min(...stemPlan().filter(([x]) => Math.abs(x) < r).map(([x, y]) => straight + Math.sqrt(r * r - x * x) + y));
}

const TCLIP_DROP = tclipDrop(SKADIS_SLOT_WIDTH, SKADIS_SLOT_LENGTH);

function recessPieces(c: number): Pt[][] {
  const h = RECESS_H + c;
  const w = W / 2 + c;
  const r = Math.hypot(h, w);
  const d = Math.atan2(w, h);
  const steps = RECESS_SECTOR_STEPS;
  const sector = (from: number): Pt[] => [[0, 0], ...Array.from({ length: steps + 1 }, (_, i): Pt => {
    const phi = from + d + ((Math.PI / 2) * i) / steps;
    return [r * Math.sin(phi), r * Math.cos(phi)];
  }).reverse()];
  const rect = (hx: number, hy: number): Pt[] => [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
  return [rect(w, h), rect(h, w), sector(0), sector(Math.PI)];
}

function tclipSweep(c: number): number {
  return Math.hypot(RECESS_H + c, W / 2 + c);
}

function stadium(r: number, half: number, steps = STADIUM_STEPS): Pt[] {
  const top = Array.from({ length: steps + 1 }, (_, i): Pt => [r * Math.cos((Math.PI * i) / steps), half + r * Math.sin((Math.PI * i) / steps)]);
  const bottom = Array.from({ length: steps + 1 }, (_, i): Pt => [r * Math.cos(Math.PI + (Math.PI * i) / steps), -half + r * Math.sin(Math.PI + (Math.PI * i) / steps)]);
  return [...top, ...bottom];
}

function cuttersFor(toXY: (u: number, s: number) => XY, side: number, axisUp: number, thickness: number, c: number): TclipCutters {
  const leadIn = SKADIS_TCLIP_LEAD_IN;
  const overlap = WELD_OVERLAP;
  const place = (poly: Pt[]) => poly.map(([s, u]) => toXY(axisUp + u, side + s));
  const leadInOf = (poly: Pt[]): TclipCutter => ({
    levels: [
      { z: -leadIn - SKADIS_TCLIP_LEAD_IN_ROOT, poly: place(offsetConvex(poly, -SKADIS_TCLIP_LEAD_IN_ROOT)) },
      { z: -leadIn, poly: place(poly) },
      { z: 0, poly: place(offsetConvex(poly, leadIn)) },
      { z: overlap, poly: place(offsetConvex(poly, leadIn + overlap)) },
    ],
  });
  const stemRadius = Math.max(...stemPlan().map(([x, y]) => Math.hypot(x, y)));
  const slotRadius = Math.max(W / 2 + c, stemRadius + SKADIS_TCLIP_SLOT_CLEARANCE);
  const barHalfW = W / 2 + c;
  const stadiumHalf = SKADIS_TCLIP_BAR_LENGTH / 2 + c - Math.sqrt(Math.max(0, slotRadius * slotRadius - barHalfW * barHalfW));
  const recessFloor = -SKADIS_TCLIP_RECESS_DEPTH;
  const slot: TclipCutter = { levels: [{ z: -thickness - overlap, poly: place(stadium(slotRadius, stadiumHalf)) }, { z: recessFloor + overlap, poly: place(stadium(slotRadius, stadiumHalf)) }] };
  const recessShapes = recessPieces(c);
  return {
    slot,
    recess: { bottom: recessFloor, top: overlap - leadIn, pieces: recessShapes.map(place) },
    leadIns: recessShapes.map(leadInOf),
  };
}

export function tclipCutterPolys({ slot, recess, leadIns }: TclipCutters): XY[][] {
  return [...slot.levels, ...leadIns.flatMap((cutter) => cutter.levels)].map((level) => level.poly).concat(recess.pieces);
}

function keptIn(input: SkadisTclipInput, p: XY, keep: number): boolean {
  if (outlineOffsetAt(input.boreOutline, p.x, p.y).offset > -keep) return false;
  if (input.capHole && outlineOffsetAt(input.capHole, p.x, p.y).offset > -SKADIS_TCLIP_REACH_MARGIN) return false;
  if (input.ring && outlineOffsetAt(input.ring.holeOutline, p.x, p.y).offset > -tclipSweep(input.tolerance)) return false;
  return true;
}

type Placement = (side: number, up: number) => boolean;

function threeClipPositions(ups: number[], fits: Placement): Pt[] | undefined {
  let best: { spread: number; pos: Pt[] } | undefined;
  for (const top of ups) {
    if (top <= 0 || !fits(0, top)) continue;
    for (const side of [NEAR_COLUMN_SIDE, FAR_COLUMN_SIDE]) {
      for (let k = 1; k <= MAX_BOTTOM_ROWS; k++) {
        const dy = side === NEAR_COLUMN_SIDE ? NEAR_COLUMN_SIDE * (2 * k - 1) : FAR_COLUMN_SIDE * k;
        const bottom = top - dy;
        if (bottom >= 0) continue;
        if (!fits(side, bottom) || !fits(-side, bottom)) continue;
        const spread = top - bottom;
        if (!best || spread > best.spread + SPREAD_EPSILON || (Math.abs(spread - best.spread) < SPREAD_EPSILON && Math.abs(top + bottom) < Math.abs(best.pos[0][1] + best.pos[1][1]))) {
          best = { spread, pos: [[0, top], [-side, bottom], [side, bottom]] };
        }
      }
    }
  }
  return best?.pos;
}

function pairPositions(ups: number[], fits: Placement): Pt[] | undefined {
  const pairs: Array<(m: number) => Pt[]> = [
    (m) => [[0, m + PAIR_HALF_SPACING], [0, m - PAIR_HALF_SPACING]],
    (m) => [[-PAIR_HALF_SPACING, m], [PAIR_HALF_SPACING, m]],
    (m) => [[-DIAGONAL_HALF_SPACING, m - DIAGONAL_HALF_SPACING], [DIAGONAL_HALF_SPACING, m + DIAGONAL_HALF_SPACING]],
  ];
  for (const pair of pairs) {
    for (const m of ups) {
      const pos = pair(m);
      if (pos.every(([s, u]) => fits(s, u))) return pos;
    }
  }
  return undefined;
}

export function layoutSkadisTclips(input: SkadisTclipInput): SkadisTclipLayout {
  const { boreOutline, thickness, tolerance: c, wallTop } = input;
  const axisDeg = bestAxisDeg(boreOutline, FLAT_BOTTOM_FAN_DEG);
  const { toXY } = basisFor(axisDeg);
  const keep = tclipSweep(c) + SKADIS_TCLIP_FLOOR_WALL;
  const fits: Placement = (s, u) => keptIn(input, toXY(u, s), keep);
  const boreReach = (isPill(boreOutline) ? circumscribedRadius(boreOutline, 0) : boreOutline.apothem / Math.cos(Math.PI / boreOutline.n)) + REACH_MARGIN_UP;
  const ups: number[] = [];
  for (let u = Math.ceil(boreReach / SEARCH_STEP) * SEARCH_STEP; u >= -boreReach; u -= SEARCH_STEP) ups.push(u);

  let chosen = threeClipPositions(ups, fits);
  let note: string | undefined;
  if (!chosen) {
    chosen = pairPositions(ups, fits);
    if (chosen) note = "The bore only has room for 2 SKÅDIS T-clips; the coil hangs straight from the pair.";
  }
  if (!chosen) {
    const top = ups.find((u) => fits(0, u));
    if (top !== undefined) {
      chosen = [[0, top]];
      note = "The bore only has room for 1 SKÅDIS T-clip: the coil hangs straight below it, and its weight keeps the clip seated in the slot, so neither turns unless you lift the coil.";
    }
  }

  const zf = -SKADIS_TCLIP_RECESS_DEPTH;
  const capOn = !!input.capHole;
  const finCeiling = input.ring ? input.ring.funnelFloor : wallTop - (capOn ? input.engageDepth : 0);
  const finRoom = finCeiling - SKADIS_TCLIP_FIN_TOP_GAP;
  const finTop = Math.max(zf + SKADIS_TCLIP_HANDLE_THICKNESS, Math.min(SKADIS_TCLIP_FIN_HEIGHT, finRoom));
  if (!chosen) {
    return {
      axisDeg,
      clips: [],
      cutters: [],
      finTop,
      boardFrontZ: -thickness,
      warning: "The bore is too small for SKÅDIS T-clips inside it, so they were left out: choose the SKÅDIS rim clips for a core this small.",
    };
  }
  const clipPieces = pieces(thickness, finTop);
  const clips = chosen.map(([side, axisUp]): Tclip => ({ side, axisUp, insertUp: axisUp + TCLIP_DROP, pieces: clipPieces }));
  return {
    axisDeg,
    clips,
    cutters: clips.map((cl) => cuttersFor(toXY, cl.side, cl.axisUp, thickness, c)),
    finTop,
    boardFrontZ: -thickness,
    note,
  };
}

function tclipFrame(axisDeg: number, clip: Tclip) {
  const { up, side } = basisFor(axisDeg);
  return {
    up,
    side,
    at: (u: number, zz: number, t: number) => ({ x: (clip.side + u) * side.x + (clip.axisUp + t) * up.x, y: (clip.side + u) * side.y + (clip.axisUp + t) * up.y, z: zz }),
  };
}

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

export function tclipPrintRotateZ(axisDeg: number): number {
  return (axisDeg * Math.PI) / 180;
}

export function skadisTclipBoardSection(layout: SkadisTclipLayout, radius: number): PegboardSection | undefined {
  const first = layout.clips[0];
  if (!first) return undefined;
  return boardSection(layout.axisDeg, first.side, first.insertUp, layout.boardFrontZ, radius);
}
