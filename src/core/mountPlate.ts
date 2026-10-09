import {
  MOUNT_PLATE_EDGE_MARGIN,
  MOUNT_PLATE_MAX_PER_SIDE,
  MOUNT_PLATE_MIN_CLIPS,
  MOUNT_PLATE_PEG_CORNER,
  MOUNT_PLATE_PEG_LEAD_IN,
  MOUNT_PLATE_PEG_LENGTH,
  MOUNT_PLATE_PEG_RADIUS,
  MOUNT_PLATE_PEG_SIZE,
  OPENGRID_PITCH,
  OPENGRID_PLACEHOLDER_PEG_SIZE,
} from "./constants";
import { bestAxisDeg } from "./mount";
import { basisFor, distanceToPolygon } from "./skadisClips";
import { offsetOutline, pointAt } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { SweepSolid } from "./innerEnd";

export interface ClipInstance {
  x: number;
  y: number;
  rotationDeg: number;
}

export interface AnchorPoint {
  x: number;
  y: number;
  rotationDeg: number;
}

export interface MountPlateLayout {
  outline: ShapeOutline;
  clips: ClipInstance[];
  anchors: AnchorPoint[];
  axisDeg?: number;
  warning?: string;
}

function clipRotationDeg(axisDeg: number): number {
  return 90 - axisDeg;
}

const BOUNDARY_SAMPLES = 512;
const FLAT_SEGMENT_EPSILON = 1e-9;
const MIN_PLATE_APOTHEM = 1;
const ANCHOR_BAND_MARGIN = 1;
const ANCHOR_WALL = 1.5;
const MARGIN_BISECTIONS = 30;
const MARGIN_ROUNDING = 1e-6;
const SIDE_AXIS_TURN_DEG = 0;
const UP_AXIS_TURN_DEG = 90;
const ANCHOR_COUNT = 2;

export interface InnerEndKeepOut {
  channelRibbon: Array<{ x: number; y: number }>;
}
const ANCHOR_KEEP_OUT = MOUNT_PLATE_PEG_RADIUS + ANCHOR_WALL;

function pegOctagon(anchor: { x: number; y: number }, offset: number): Array<{ x: number; y: number }> {
  const halfFlat = MOUNT_PLATE_PEG_SIZE / 2 + offset;
  const diagonalSum = MOUNT_PLATE_PEG_SIZE - MOUNT_PLATE_PEG_CORNER + offset * Math.SQRT2;
  const corners: Array<[number, number]> = [
    [halfFlat, diagonalSum - halfFlat], [diagonalSum - halfFlat, halfFlat], [halfFlat - diagonalSum, halfFlat], [-halfFlat, diagonalSum - halfFlat], [-halfFlat, halfFlat - diagonalSum], [halfFlat - diagonalSum, -halfFlat], [diagonalSum - halfFlat, -halfFlat], [halfFlat, halfFlat - diagonalSum],
  ];
  return corners.map(([x, y]) => ({ x: anchor.x + x, y: anchor.y + y }));
}

export function pegHoleOutline(anchor: { x: number; y: number }, tolerance: number): Array<{ x: number; y: number }> {
  return pegOctagon(anchor, tolerance / 2);
}

export function pegHoleRadius(tolerance: number): number {
  const offset = tolerance / 2;
  const halfFlat = MOUNT_PLATE_PEG_SIZE / 2 + offset;
  const diag = MOUNT_PLATE_PEG_SIZE / 2 - MOUNT_PLATE_PEG_CORNER + offset * (Math.SQRT2 - 1);
  return Math.hypot(halfFlat, diag);
}

export function pegSweep(anchor: { x: number; y: number }, zSeam: number): SweepSolid {
  const ring = (inset: number, z: number) => pegOctagon(anchor, -inset).map((p) => ({ ...p, z }));
  const zBottom = zSeam - MOUNT_PLATE_PEG_LENGTH / 2;
  const zTop = zSeam + MOUNT_PLATE_PEG_LENGTH / 2;
  const leadIn = MOUNT_PLATE_PEG_LEAD_IN;
  return {
    rings: [ring(leadIn, zBottom), ring(0, zBottom + leadIn), ring(0, zTop - leadIn), ring(leadIn, zTop)],
    start: { x: anchor.x, y: anchor.y, z: zBottom },
    end: { x: anchor.x, y: anchor.y, z: zTop },
  };
}

function projectedBoundary(outline: ShapeOutline, axisDeg: number): Array<{ up: number; side: number }> {
  const { project } = basisFor(axisDeg);
  const pts: Array<{ up: number; side: number }> = [];
  for (let i = 0; i <= BOUNDARY_SAMPLES; i++) {
    const t = (i % BOUNDARY_SAMPLES) / BOUNDARY_SAMPLES;
    const p = pointAt(outline, t, 0);
    pts.push(project(p));
  }
  return pts;
}

function upExtent(boundary: Array<{ up: number; side: number }>): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of boundary) {
    if (p.up < lo) lo = p.up;
    if (p.up > hi) hi = p.up;
  }
  return [lo, hi];
}

function halfWidthAtUp(boundary: Array<{ up: number; side: number }>, up0: number): number {
  let maxSide = 0;
  for (let i = 0; i < boundary.length - 1; i++) {
    const a = boundary[i];
    const b = boundary[i + 1];
    const lo = Math.min(a.up, b.up);
    const hi = Math.max(a.up, b.up);
    if (up0 < lo || up0 > hi || hi - lo < FLAT_SEGMENT_EPSILON) continue;
    const frac = (up0 - a.up) / (b.up - a.up);
    const side = Math.abs(a.side + frac * (b.side - a.side));
    if (side > maxSide) maxSide = side;
  }
  return maxSide;
}

function edgesAtUp(boundary: Array<{ up: number; side: number }>, up0: number): { pos: number; neg: number } {
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < boundary.length - 1; i++) {
    const a = boundary[i];
    const b = boundary[i + 1];
    const lo = Math.min(a.up, b.up);
    const hi = Math.max(a.up, b.up);
    if (up0 < lo || up0 > hi || hi - lo < FLAT_SEGMENT_EPSILON) continue;
    const side = a.side + ((up0 - a.up) / (b.up - a.up)) * (b.side - a.side);
    if (side > pos) pos = side;
    if (-side > neg) neg = -side;
  }
  return { pos, neg };
}

export function layoutMountPlate(
  flangeOutline: ShapeOutline,
  boreOutline: ShapeOutline,
  pitch: number,
  clipHalfSide: number,
  clipHalfUp: number,
  avoid?: InnerEndKeepOut,
): MountPlateLayout {
  const outline = offsetOutline(flangeOutline, -MOUNT_PLATE_EDGE_MARGIN);
  if (outline.apothem <= MIN_PLATE_APOTHEM || outline.cornerRadius < 0) {
    return { outline, clips: [], anchors: [], warning: "The flange is too small to fit a mount plate at all." };
  }

  const axisDeg = bestAxisDeg(boreOutline, 0);
  const rotationDeg = clipRotationDeg(axisDeg);
  const { toXY } = basisFor(axisDeg);
  const boundary = projectedBoundary(outline, axisDeg);
  const [minUp, maxUp] = upExtent(boundary);

  const fits = (up: number, side: number): boolean =>
    up >= minUp + clipHalfUp &&
    up <= maxUp - clipHalfUp &&
    Math.min(halfWidthAtUp(boundary, up - clipHalfUp), halfWidthAtUp(boundary, up), halfWidthAtUp(boundary, up + clipHalfUp)) - clipHalfSide >= Math.abs(side);

  const clips: ClipInstance[] = [];
  for (let k = 0; k < MOUNT_PLATE_MAX_PER_SIDE; k++) {
    const side = (k + 1) * pitch;
    const rowsUp = [0];
    for (let n = 1; n <= MOUNT_PLATE_MAX_PER_SIDE; n++) rowsUp.push(n * pitch, -n * pitch);
    for (const up of rowsUp) {
      if (!fits(up, side)) continue;
      for (const s of [side, -side]) clips.push({ ...toXY(up, s), rotationDeg });
    }
  }

  if (clips.length === 0) {
    return {
      outline,
      clips: [],
      anchors: [],
      warning: `The flange is too small to fit at least ${MOUNT_PLATE_MIN_CLIPS} clips on the ${pitch} mm grid (increase the core size, or the mount plate was skipped).`,
    };
  }

  const pairOn = (turnDeg: typeof SIDE_AXIS_TURN_DEG | typeof UP_AXIS_TURN_DEG): AnchorPoint[] => {
    const bore = edgesAtUp(projectedBoundary(boreOutline, axisDeg + turnDeg), 0);
    const edge = edgesAtUp(projectedBoundary(outline, axisDeg + turnDeg), 0);
    const mids: number[] = [];
    for (const [inner, outer, sign] of [[bore.pos + ANCHOR_BAND_MARGIN, edge.pos - ANCHOR_BAND_MARGIN, 1], [bore.neg + ANCHOR_BAND_MARGIN, edge.neg - ANCHOR_BAND_MARGIN, -1]]) {
      if (outer - inner < 2 * MOUNT_PLATE_PEG_RADIUS) return [];
      mids.push((sign * (inner + outer)) / 2);
    }
    const pts = mids.map((m) => (turnDeg === SIDE_AXIS_TURN_DEG ? toXY(0, m) : toXY(-m, 0)));
    return pts.map((p) => ({ ...p, rotationDeg }));
  };
  const clear = (p: { x: number; y: number }) =>
    !avoid || avoid.channelRibbon.length < 3 || distanceToPolygon(p, avoid.channelRibbon) >= ANCHOR_KEEP_OUT;
  const anchors = [pairOn(SIDE_AXIS_TURN_DEG), pairOn(UP_AXIS_TURN_DEG)].find((pair) => pair.length === ANCHOR_COUNT && pair.every(clear)) ?? [];

  return { outline, clips, anchors, axisDeg };
}

export function openGridClipHalfExtents(): { halfUp: number; halfSide: number } {
  return { halfUp: OPENGRID_PLACEHOLDER_PEG_SIZE / 2, halfSide: OPENGRID_PLACEHOLDER_PEG_SIZE / 2 };
}

export function mountPlateLayoutFor(flangeOutline: ShapeOutline, boreOutline: ShapeOutline, avoid?: InnerEndKeepOut): MountPlateLayout {
  const { halfSide, halfUp } = openGridClipHalfExtents();
  return layoutMountPlate(flangeOutline, boreOutline, OPENGRID_PITCH, halfSide, halfUp, avoid);
}

export function requiredMountPlateMargin(outline: ShapeOutline, boreOutline: ShapeOutline): number {
  const fits = (margin: number): boolean => mountPlateLayoutFor(offsetOutline(outline, margin), boreOutline).clips.length > 0;
  let lo = 0;
  let hi = 1;
  while (!fits(hi)) hi *= 2;
  for (let i = 0; i < MARGIN_BISECTIONS; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi + MARGIN_ROUNDING;
}
