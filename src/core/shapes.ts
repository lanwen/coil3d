import { DEFAULT_CORNER_RADIUS, DEFAULT_PILL_RADIUS } from "./constants";

export type ShapeKind = "round" | "sq" | "tri" | "pill";
export type SizeSemantics = "diameter" | "acrossFlats" | "inscribedDiameter" | "length";

export interface ShapeOutline {
  n: number;
  apothem: number;
  cornerRadius: number;
  halfStraight?: number;
}

export interface ShapePlugin {
  kind: ShapeKind;
  label: string;
  sizeSemantics: SizeSemantics;
  corners: number;
  maxCornerRadius(size: number): number;
}

const round: ShapePlugin = {
  kind: "round",
  label: "Round",
  sizeSemantics: "diameter",
  corners: 4,
  maxCornerRadius: (size) => size / 2,
};

const sq: ShapePlugin = {
  kind: "sq",
  label: "Rounded square",
  sizeSemantics: "acrossFlats",
  corners: 4,
  maxCornerRadius: (size) => size / 2,
};

const tri: ShapePlugin = {
  kind: "tri",
  label: "Rounded triangle",
  sizeSemantics: "inscribedDiameter",
  corners: 3,
  maxCornerRadius: (size) => size / 2,
};

const pill: ShapePlugin = {
  kind: "pill",
  label: "Pill",
  sizeSemantics: "length",
  corners: 2,
  maxCornerRadius: (size) => size / 2,
};

export const SHAPES: Record<ShapeKind, ShapePlugin> = { round, sq, tri, pill };

export function shapePlugin(kind: ShapeKind): ShapePlugin {
  return SHAPES[kind];
}

export function defaultCornerRadius(kind: Exclude<ShapeKind, "round">): number {
  return kind === "pill" ? DEFAULT_PILL_RADIUS : DEFAULT_CORNER_RADIUS;
}

const NEGLIGIBLE_LENGTH = 1e-9;
const NEGLIGIBLE_EDGE_LENGTH_SQUARED = 1e-18;
const COINCIDENT_POINT_DISTANCE = 1e-12;

const wrapUnit = (t: number): number => ((t % 1) + 1) % 1;

const PILL_SIDES = 2;

export function isPill(o: ShapeOutline): boolean {
  return o.n === PILL_SIDES;
}

export function isFullCircle(o: ShapeOutline): boolean {
  return o.cornerRadius === o.apothem && !isPill(o);
}

function cornerCentreDistance(o: ShapeOutline): number {
  if (isPill(o)) return o.halfStraight ?? 0;
  return (o.apothem - o.cornerRadius) / Math.cos(Math.PI / o.n);
}

function makePill(length: number, radius: number): ShapeOutline {
  const apothem = length / 2;
  const r = Math.min(Math.max(radius, 0), apothem);
  if (r >= apothem) return { n: round.corners, apothem, cornerRadius: apothem };
  return { n: PILL_SIDES, apothem: r, cornerRadius: r, halfStraight: apothem - r };
}

export function makeOutline(kind: ShapeKind, size: number, cornerRadius: number): ShapeOutline {
  const apothem = size / 2;
  if (kind === "round") return { n: round.corners, apothem, cornerRadius: apothem };
  if (kind === "pill") return makePill(size, cornerRadius);
  const plugin = SHAPES[kind];
  const rc = Math.min(Math.max(cornerRadius, 0), plugin.maxCornerRadius(size));
  return { n: plugin.corners, apothem, cornerRadius: rc };
}

export function sideLength(o: ShapeOutline): number {
  if (isPill(o)) return 2 * cornerCentreDistance(o);
  return 2 * (o.apothem - o.cornerRadius) * Math.tan(Math.PI / o.n);
}

export function straightLength(o: ShapeOutline): number {
  return o.n * sideLength(o);
}

export function offsetPerimeter(o: ShapeOutline, offset: number): number {
  return straightLength(o) + 2 * Math.PI * (o.cornerRadius + offset);
}

export function spiralTurnLength(o: ShapeOutline, offset: number, growth: number): number {
  const side = sideLength(o);
  const cornerArc = ((2 * Math.PI) / o.n) * o.cornerRadius;
  const lateness = (Math.PI * side) / (o.n * (cornerArc + side));
  return Math.hypot(offsetPerimeter(o, offset + growth / 2) - growth * lateness, growth);
}

export function inscribedRadius(o: ShapeOutline, offset: number): number {
  return o.apothem + offset;
}

export function offsetArea(o: ShapeOutline, offset: number): number {
  if (isPill(o)) return straightLength(o) * (o.cornerRadius + offset) + Math.PI * (o.cornerRadius + offset) ** 2;
  const half = Math.PI / o.n;
  const innerApothem = o.apothem - o.cornerRadius;
  const rc = o.cornerRadius + offset;
  return o.n * innerApothem * innerApothem * Math.tan(half) + 2 * o.n * innerApothem * Math.tan(half) * rc + Math.PI * rc * rc;
}

export function circumscribedRadius(o: ShapeOutline, offset: number): number {
  return cornerCentreDistance(o) + o.cornerRadius + offset;
}

export function radiusAtAngle(o: ShapeOutline, phi: number): number {
  if (isFullCircle(o)) return o.apothem;
  const half = Math.PI / o.n;
  const Rc = cornerCentreDistance(o);
  const arcTangentAngle = Math.atan2(o.cornerRadius * Math.sin(half), Rc + o.cornerRadius * Math.cos(half));
  const step = (2 * Math.PI) / o.n;
  const nearestI = Math.round(phi / step);
  const delta = phi - nearestI * step;
  const rayThroughCornerArc = () => Rc * Math.cos(delta) + Math.sqrt(Math.max(0, o.cornerRadius * o.cornerRadius - (Rc * Math.sin(delta)) ** 2));
  const rayThroughFlatSide = () => {
    const sideIndex = delta > 0 ? nearestI : nearestI - 1;
    const sideMidAngle = (sideIndex + 0.5) * step;
    return o.apothem / Math.cos(phi - sideMidAngle);
  };
  return Math.abs(delta) <= arcTangentAngle ? rayThroughCornerArc() : rayThroughFlatSide();
}

export function offsetOutline(o: ShapeOutline, amount: number): ShapeOutline {
  return { ...o, apothem: o.apothem + amount, cornerRadius: o.cornerRadius + amount };
}

export function minCornerSegments(o: ShapeOutline, segmentsPer90Deg: number): number {
  const sweepDeg = 360 / o.n;
  return Math.max(1, Math.ceil((segmentsPer90Deg * sweepDeg) / 90));
}

export function outlineColumnParams(o: ShapeOutline, requestedColumns: number, minSegments: number): number[] {
  const side = sideLength(o);
  if (side <= NEGLIGIBLE_LENGTH) {
    const ts: number[] = new Array(requestedColumns);
    for (let i = 0; i < requestedColumns; i++) ts[i] = i / requestedColumns;
    return ts;
  }

  const n = o.n;
  const half = Math.PI / n;
  const arc = 2 * half * o.cornerRadius;
  const perimeter = n * (arc + side);

  const proportionalCorner = Math.round((requestedColumns * arc) / perimeter);
  const cornerSegs = arc <= NEGLIGIBLE_LENGTH ? 1 : Math.max(minSegments, proportionalCorner, 1);

  const leftover = requestedColumns - n * cornerSegs;
  const sideSegs = Math.max(1, Math.round(leftover / n));

  const unitLength = arc + side;
  const ts: number[] = [];
  for (let i = 0; i < n; i++) {
    const unitStart = i * unitLength;
    for (let k = 0; k < cornerSegs; k++) ts.push((unitStart + (arc * k) / cornerSegs) / perimeter);
    for (let k = 0; k < sideSegs; k++) ts.push((unitStart + arc + (side * k) / sideSegs) / perimeter);
  }
  return ts;
}

export interface OutlineParam {
  seg: number;
  u: number;
}

export function evalOutline(o: ShapeOutline, p: OutlineParam, offset: number): { x: number; y: number; nx: number; ny: number } {
  const n = o.n;
  const half = Math.PI / n;
  const Rc = cornerCentreDistance(o);
  const i = p.seg >> 1;
  const th = (2 * Math.PI * i) / n;
  const cx = Rc * Math.cos(th);
  const cy = Rc * Math.sin(th);
  const r = o.cornerRadius + offset;
  if ((p.seg & 1) === 0) {
    const psi = th - half + p.u * 2 * half;
    const nx = Math.cos(psi);
    const ny = Math.sin(psi);
    return { x: cx + r * nx, y: cy + r * ny, nx, ny };
  }
  const th2 = (2 * Math.PI * (i + 1)) / n;
  const dx = Rc * Math.cos(th2) - cx;
  const dy = Rc * Math.sin(th2) - cy;
  const psi = th + half;
  const nx = Math.cos(psi);
  const ny = Math.sin(psi);
  return { x: cx + p.u * dx + r * nx, y: cy + p.u * dy + r * ny, nx, ny };
}

export function paramAt(o: ShapeOutline, offset: number, t: number): OutlineParam {
  const arc = ((2 * Math.PI) / o.n) * (o.cornerRadius + offset);
  const side = sideLength(o);
  const P = o.n * (arc + side);
  let s = wrapUnit(t) * P;
  for (let i = 0; i < o.n; i++) {
    if (s <= arc || (side <= NEGLIGIBLE_LENGTH && i === o.n - 1)) return { seg: 2 * i, u: Math.min(1, arc > 0 ? s / arc : 0) };
    s -= arc;
    if (s <= side) return { seg: 2 * i + 1, u: side > 0 ? s / side : 0 };
    s -= side;
  }
  return { seg: 2 * o.n - 1, u: 1 };
}

export function arcLengthFractionAt(o: ShapeOutline, offset: number, t: number): number {
  const side = sideLength(o);
  if (side <= NEGLIGIBLE_LENGTH) return wrapUnit(t);
  const arc = ((2 * Math.PI) / o.n) * (o.cornerRadius + offset);
  const perimeter = o.n * (arc + side);
  const p = paramAt(o, 0, t);
  const i = p.seg >> 1;
  const s = i * (arc + side) + ((p.seg & 1) === 0 ? p.u * arc : arc + p.u * side);
  return s / perimeter;
}

export function parameterAtOffsetArc(o: ShapeOutline, offset: number, s: number): number {
  if (isFullCircle(o)) return wrapUnit(s / (2 * Math.PI * (o.apothem + offset)));
  const side = sideLength(o);
  const arc = ((2 * Math.PI) / o.n) * (o.cornerRadius + offset);
  const arcBase = ((2 * Math.PI) / o.n) * o.cornerRadius;
  const unit = arc + side;
  const wrapped = ((s % (o.n * unit)) + o.n * unit) % (o.n * unit);
  const i = Math.min(o.n - 1, Math.floor(wrapped / unit));
  const along = wrapped - i * unit;
  const base = i * (arcBase + side);
  const t = along <= arc ? base + (arc > 0 ? along / arc : 0) * arcBase : base + arcBase + (along - arc);
  return t / (o.n * (arcBase + side));
}

export function pointAt(o: ShapeOutline, t: number, offset: number): { x: number; y: number; nx: number; ny: number } {
  if (isFullCircle(o)) {
    const theta = 2 * Math.PI * t;
    const nx = Math.cos(theta);
    const ny = Math.sin(theta);
    const r = o.apothem + offset;
    return { x: nx * r, y: ny * r, nx, ny };
  }
  return evalOutline(o, paramAt(o, 0, t), offset);
}

export function pointAlong(o: ShapeOutline, along: ShapeOutline, t: number, offset: number): { x: number; y: number; nx: number; ny: number } {
  if (isFullCircle(o) || isFullCircle(along)) return pointAt(o, t, offset);
  return evalOutline(o, paramAt(along, 0, t), offset);
}

export function polygonVertex(o: ShapeOutline, i: number): [number, number] {
  const half = Math.PI / o.n;
  const Rv = o.apothem / Math.cos(half);
  const theta = (2 * Math.PI * i) / o.n;
  return [Rv * Math.cos(theta), Rv * Math.sin(theta)];
}

export function outlineOffsetAt(o: ShapeOutline, x: number, y: number): { offset: number; nx: number; ny: number } {
  const n = o.n;
  const Rc = cornerCentreDistance(o);
  let bestD = Infinity;
  let qx = 0;
  let qy = 0;
  let inside = true;
  for (let i = 0; i < n; i++) {
    const a0 = (2 * Math.PI * i) / n;
    const a1 = (2 * Math.PI * (i + 1)) / n;
    const ax = Rc * Math.cos(a0);
    const ay = Rc * Math.sin(a0);
    const ex = Rc * Math.cos(a1) - ax;
    const ey = Rc * Math.sin(a1) - ay;
    const len2 = ex * ex + ey * ey;
    if (ex * (y - ay) - ey * (x - ax) < 0) inside = false;
    const f = len2 > NEGLIGIBLE_EDGE_LENGTH_SQUARED ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / len2)) : 0;
    const px = ax + f * ex;
    const py = ay + f * ey;
    const dist = Math.hypot(x - px, y - py);
    if (dist < bestD) {
      bestD = dist;
      qx = px;
      qy = py;
    }
  }
  if (Rc < NEGLIGIBLE_LENGTH || isPill(o)) inside = false;
  const dx = x - qx;
  const dy = y - qy;
  const len = Math.hypot(dx, dy);
  const withinCornerCentrePolygon = inside || len < COINCIDENT_POINT_DISTANCE;
  if (withinCornerCentrePolygon) {
    const r = Math.hypot(x, y) || 1;
    return { offset: -bestD - o.cornerRadius, nx: x / r, ny: y / r };
  }
  return { offset: len - o.cornerRadius, nx: dx / len, ny: dy / len };
}
