// The outer contour of a plate (the base flange or the top cap), with its ears (issues #248, #240). One shared,
// mesh-free definition, so the mesh backend (manifold.ts) and the STEP backend (step/build.ts) can't drift.
//
// A plain plate's contour is the core's outline offset by the margin `m` (shapes.ts): a chain of corner arcs and
// straight sides. An ear is a local lobe on it, one or two discs (a round or a stadium lobe) blended into the plate
// with a concave fillet of radius EAR_FILLET on each side. The plate stays slim everywhere else.
//
// The 45 degree chamfer on the rim stays exact with no extra work. Every row of the rim is the contour moved by
// `delta` (mm, outward): each convex arc keeps its centre and grows by `delta`, each concave fillet keeps its centre
// and shrinks by `delta`, each line moves out by `delta`. All centre distances stay the same, so the tangencies hold
// and the tangent points don't move. Every row has the same topology and the same arc spans, so a ruled loft between
// rows is valid. The radii must stay positive over every row: an ear disc needs r > EDGE_CHAMFER and the fillet
// needs EAR_FILLET > the largest delta (the relief wedge's, +1).

import { EAR_ARC_STEP_DEG, EAR_FILLET, EAR_LINE_STEP, EDGE_CHAMFER } from "./constants";
import { edgeDistance, inside } from "./innerEnd";
import type { XY } from "./innerEnd";
import { outlineOffsetAt, sideLength } from "./shapes";
import type { ShapeOutline } from "./shapes";

export interface EarDisc {
  x: number;
  y: number;
  r: number;
}

/** A lobe of one or two discs of equal radius, counter-clockwise round the plate (the second disc comes later). */
export interface Ear {
  discs: EarDisc[];
}

export interface PlateContour {
  /** The core's outline: the plain plate's contour is this offset by `margin`. */
  outline: ShapeOutline;
  margin: number;
  ears: Ear[];
}

/** The contour of a plate spec (the flange's, or the cap's: the same `outline`, `margin` and `ears`). */
export function plateContourOf(plate: { outline: ShapeOutline; margin: number; ears?: Ear[] }): PlateContour {
  return { outline: plate.outline, margin: plate.margin, ears: plate.ears ?? [] };
}

export interface Line {
  kind: "line";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** A piece of the plain plate's own straight side, sampled at the plate's column density (an ear's flat uses EAR_LINE_STEP). */
  plate: boolean;
}

/** An arc from angle `a0` to `a1`, both in radians: counter-clockwise when `a1 > a0`, clockwise when it is smaller (a concave fillet). */
export interface Arc {
  kind: "arc";
  cx: number;
  cy: number;
  r: number;
  a0: number;
  a1: number;
  concave: boolean;
  /** An arc of the plain plate's own corners, sampled at the plate's column density (the ears' arcs use EAR_ARC_STEP_DEG). */
  plate: boolean;
}

export type Segment = Line | Arc;

const TAU = 2 * Math.PI;
/** `x` modulo a full turn, in [0, 2 pi). */
const wrap = (x: number): number => ((x % TAU) + TAU) % TAU;
/** Lengths and angles below these count as zero. */
const EPS = 1e-9;

/** An element of the plain plate at the land (delta 0): `t` runs 0 to 1 along it. */
type Element =
  | { kind: "arc"; cx: number; cy: number; r: number; a0: number; a1: number }
  | { kind: "line"; x0: number; y0: number; x1: number; y1: number; nx: number; ny: number };

/** The plain plate's land contour, counter-clockwise: corner arc 0, side 0, corner arc 1, ... (shapes.ts's `evalOutline` order). Round is one full circle. */
function plateElements(outline: ShapeOutline, margin: number): Element[] {
  if (outline.cornerRadius === outline.apothem) return [{ kind: "arc", cx: 0, cy: 0, r: outline.apothem + margin, a0: 0, a1: TAU }];
  const n = outline.n;
  const half = Math.PI / n;
  const Rc = (outline.apothem - outline.cornerRadius) / Math.cos(half);
  const r = outline.cornerRadius + margin;
  const out: Element[] = [];
  for (let i = 0; i < n; i++) {
    const th = (TAU * i) / n;
    const next = (TAU * ((i + 1) % n)) / n;
    const [cx, cy] = [Rc * Math.cos(th), Rc * Math.sin(th)];
    out.push({ kind: "arc", cx, cy, r, a0: th - half, a1: th + half });
    const [nx, ny] = [Math.cos(th + half), Math.sin(th + half)];
    const [dx, dy] = [Rc * Math.cos(next) - cx, Rc * Math.sin(next) - cy];
    if (Math.hypot(dx, dy) > EPS) out.push({ kind: "line", x0: cx + r * nx, y0: cy + r * ny, x1: cx + dx + r * nx, y1: cy + dy + r * ny, nx, ny });
  }
  return out;
}

/** The part of `el` from `t0` to `t1`, with the contour moved out by `delta`. */
function slice(el: Element, t0: number, t1: number, delta: number): Segment {
  if (el.kind === "arc") {
    const span = el.a1 - el.a0;
    return { kind: "arc", cx: el.cx, cy: el.cy, r: el.r + delta, a0: el.a0 + t0 * span, a1: el.a0 + t1 * span, concave: false, plate: true };
  }
  const [dx, dy] = [el.x1 - el.x0, el.y1 - el.y0];
  return {
    kind: "line",
    x0: el.x0 + t0 * dx + delta * el.nx,
    y0: el.y0 + t0 * dy + delta * el.ny,
    x1: el.x0 + t1 * dx + delta * el.nx,
    y1: el.y0 + t1 * dy + delta * el.ny,
    plate: true,
  };
}

/** Where a fillet leaves the plain plate: element `k` at fraction `t`, so loop position `k + t`. */
interface Fillet {
  /** The fillet circle's centre. */
  fx: number;
  fy: number;
  /** The direction, seen from the centre, to the plate's tangent point. */
  toPlate: number;
  position: number;
}

/**
 * The fillet between the plain plate and the ear disc `d`, on the side before it (`side` -1: the contour arrives from
 * the plate) or after it (+1). Its circle lies outside the plate and touches both the plate element it meets and the
 * disc from outside.
 */
function solveFillet(elements: Element[], d: EarDisc, side: -1 | 1): Fillet {
  const rf = EAR_FILLET;
  const found: Array<Fillet & { off: number }> = [];
  // `ahead` is how far round the plate the circle lies beyond the disc (positive: later along the contour).
  const consider = (fx: number, fy: number, ahead: number, toPlate: number, position: number) => {
    if (ahead * side <= 0) return;
    found.push({ fx, fy, toPlate, position, off: Math.hypot(fx + rf * Math.cos(toPlate) - d.x, fy + rf * Math.sin(toPlate) - d.y) });
  };
  elements.forEach((el, k) => {
    if (el.kind === "arc") {
      const [R0, R1] = [el.r + rf, d.r + rf];
      const [dx, dy] = [d.x - el.cx, d.y - el.cy];
      const dist = Math.hypot(dx, dy);
      if (dist < EPS || dist > R0 + R1 || dist < Math.abs(R0 - R1)) return;
      const a = (R0 * R0 - R1 * R1 + dist * dist) / (2 * dist);
      const h = Math.sqrt(Math.max(0, R0 * R0 - a * a));
      const [ux, uy] = [dx / dist, dy / dist];
      for (const sign of [-1, 1]) {
        const [fx, fy] = [el.cx + a * ux - sign * h * uy, el.cy + a * uy + sign * h * ux];
        // Where on the arc the fillet touches it: a full circle (round) takes every direction, a corner arc only its own span.
        const t = wrap(Math.atan2(fy - el.cy, fx - el.cx) - el.a0) / (el.a1 - el.a0);
        // Round the arc's centre, counter-clockwise is later along the contour.
        if (t <= 1 + EPS) consider(fx, fy, dx * (fy - el.cy) - dy * (fx - el.cx), Math.atan2(el.cy - fy, el.cx - fx), k + Math.min(1, t));
      }
    } else {
      const len = Math.hypot(el.x1 - el.x0, el.y1 - el.y0);
      const [ux, uy] = [(el.x1 - el.x0) / len, (el.y1 - el.y0) / len];
      const [wx, wy] = [el.x0 + rf * el.nx - d.x, el.y0 + rf * el.ny - d.y];
      const b = wx * ux + wy * uy;
      const disc = b * b - (wx * wx + wy * wy - (d.r + rf) ** 2);
      if (disc < 0) return;
      for (const sign of [-1, 1]) {
        const s = -b + sign * Math.sqrt(disc);
        if (s < -EPS || s > len + EPS) continue;
        const sc = Math.min(len, Math.max(0, s));
        const [fx, fy] = [el.x0 + sc * ux + rf * el.nx, el.y0 + sc * uy + rf * el.ny];
        consider(fx, fy, (fx - d.x) * ux + (fy - d.y) * uy, Math.atan2(-el.ny, -el.nx), k + sc / len);
      }
    }
  });
  if (found.length === 0) throw new Error("Plate ear: no fillet blends the ear into the plate there");
  return found.reduce((best, f) => (f.off < best.off ? f : best));
}

/** The ear's own discs, in counter-clockwise order round the plate. */
function orderedDiscs(ear: Ear): EarDisc[] {
  const [a, b] = ear.discs;
  if (!b) return [a];
  if (Math.abs(a.r - b.r) > EPS) throw new Error("Plate ear: the two discs of an ear must have the same radius");
  // Travelling a -> b counter-clockwise round the plate, the outside is on the right.
  const outward = (b.y - a.y) * (a.x + b.x) - (b.x - a.x) * (a.y + b.y);
  return outward >= 0 ? [a, b] : [b, a];
}

interface PlacedEar {
  discs: EarDisc[];
  enter: Fillet;
  exit: Fillet;
  /** The entering fillet's position, and the exit's, unwrapped to run at least as far (the ear's window on the loop). */
  from: number;
  to: number;
}

function placeEar(elements: Element[], plate: ShapeOutline, margin: number, ear: Ear): PlacedEar {
  const discs = orderedDiscs(ear);
  for (const d of discs) {
    if (d.r <= EDGE_CHAMFER) throw new Error(`Plate ear: a disc's radius ${d.r} mm is not past the rim chamfer`);
    if (outlineOffsetAt(plate, d.x, d.y).offset + d.r <= margin + EPS) throw new Error("Plate ear: a disc doesn't reach past the plate's land");
  }
  const enter = solveFillet(elements, discs[0], -1);
  const exit = solveFillet(elements, discs[discs.length - 1], 1);
  const n = elements.length;
  return { discs, enter, exit, from: enter.position, to: enter.position + (((exit.position - enter.position) % n) + n) % n };
}

/** The contour round the ear, from its entering fillet to its exiting one, with the contour moved out by `delta`. */
function earSegments(e: PlacedEar, delta: number): Segment[] {
  const rf = EAR_FILLET - delta;
  const first = e.discs[0];
  const last = e.discs[e.discs.length - 1];
  const out: Segment[] = [];
  // The fillets run clockwise round their centres (concave): from the plate to the disc, and from the disc to the plate.
  const toDisc = (f: Fillet, d: EarDisc) => Math.atan2(d.y - f.fy, d.x - f.fx);
  const enterAngle = toDisc(e.enter, first);
  out.push({ kind: "arc", cx: e.enter.fx, cy: e.enter.fy, r: rf, a0: e.enter.toPlate, a1: e.enter.toPlate - wrap(e.enter.toPlate - enterAngle), concave: true, plate: false });
  const exitAngle = toDisc(e.exit, last);
  const fromEnter = Math.atan2(e.enter.fy - first.y, e.enter.fx - first.x);
  const fromExit = Math.atan2(e.exit.fy - last.y, e.exit.fx - last.x);
  const arc = (d: EarDisc, a0: number, a1: number): Segment => ({ kind: "arc", cx: d.x, cy: d.y, r: d.r + delta, a0, a1: a0 + wrap(a1 - a0), concave: false, plate: false });
  if (e.discs.length === 1) {
    out.push(arc(first, fromEnter, fromExit));
  } else {
    // The outer tangent between two discs of one radius: the right-hand normal of the way from one to the other.
    const [dx, dy] = [last.x - first.x, last.y - first.y];
    const len = Math.hypot(dx, dy);
    const [nx, ny] = [dy / len, -dx / len];
    const normal = Math.atan2(ny, nx);
    const r = first.r + delta;
    out.push(arc(first, fromEnter, normal));
    out.push({ kind: "line", x0: first.x + r * nx, y0: first.y + r * ny, x1: last.x + r * nx, y1: last.y + r * ny, plate: false });
    out.push(arc(last, normal, fromExit));
  }
  out.push({ kind: "arc", cx: e.exit.fx, cy: e.exit.fy, r: rf, a0: exitAngle, a1: exitAngle - wrap(exitAngle - e.exit.toPlate), concave: true, plate: false });
  return out;
}

/**
 * The plate's contour at `delta` mm outside its land (negative: inside, as on the chamfer's foot), closed and
 * counter-clockwise. The segments' topology and angle spans don't depend on `delta` (see the file header).
 * Throws when an ear can't blend into the plate (a disc that doesn't reach past the land, or ears that overlap).
 */
export function contourSegments(pc: PlateContour, delta: number): Segment[] {
  const elements = plateElements(pc.outline, pc.margin);
  const N = elements.length;
  const ears = pc.ears.map((ear) => placeEar(elements, pc.outline, pc.margin, ear)).sort((a, b) => a.from - b.from);
  if (ears.length === 0) return elements.map((el) => slice(el, 0, 1, delta));
  ears.forEach((e, i) => {
    const next = ears[(i + 1) % ears.length];
    if (e.to > next.from + (i + 1 === ears.length ? N : 0) - EPS) throw new Error("Plate ear: two ears overlap");
  });
  const out: Segment[] = [];
  // The plate between one ear's exit and the next one's entry.
  const walk = (from: number, to: number) => {
    let at = from;
    let left = to - from;
    while (left > EPS) {
      const base = Math.floor(at + EPS);
      const k = base % N;
      const t0 = Math.max(0, at - base);
      const step = Math.min(left, 1 - t0);
      if (step > EPS) out.push(slice(elements[k], t0, t0 + step, delta));
      at += step;
      left -= step;
    }
  };
  ears.forEach((e, i) => {
    out.push(...earSegments(e, delta));
    const next = ears[(i + 1) % ears.length];
    walk(e.to, next.from + (i + 1 === ears.length ? N : 0));
  });
  return out;
}

/** How densely the plain plate's own rim is sampled, as `outlineColumnParams` (shapes.ts) spends its columns: radians per facet on a corner arc, and the length of a facet of a straight side, mm. */
function plateSteps(outline: ShapeOutline, columns: number, minCornerSegments: number): { arc: number; side: number } {
  const side = sideLength(outline);
  if (side <= 1e-9) return { arc: TAU / columns, side: Infinity };
  const half = Math.PI / outline.n;
  const arc = 2 * half * outline.cornerRadius;
  const perimeter = outline.n * (arc + side);
  const cornerSegments = arc <= 1e-9 ? 1 : Math.max(minCornerSegments, Math.round((columns * arc) / perimeter), 1);
  const sideSegments = Math.max(1, Math.round((columns - outline.n * cornerSegments) / outline.n));
  return { arc: (2 * half) / cornerSegments, side: side / sideSegments };
}

/** A row of the contour's points (`contourPoints`). `ears` are the index ranges `[from, to]` of the points round each ear, from its entering fillet's start (on the plain plate) to the next plate point after it (also on the plain plate), both ends included. */
export interface ContourRow {
  points: Array<[number, number]>;
  ears: Array<[number, number]>;
}

/**
 * The contour's points at `delta`, counter-clockwise, one per facet start. How many each segment gets is fixed by its
 * length at the land and its angle span (not by `delta`), so the rows of a rim all have the same count and matching
 * indices. The plain plate's corner arcs and straight sides take the density of its columns; the ears' and
 * fillets' arcs at most EAR_ARC_STEP_DEG per facet, and the ears' own flat sides EAR_LINE_STEP mm.
 */
export function contourPoints(pc: PlateContour, delta: number, opts: { columns: number; minCornerSegments: number }): ContourRow {
  const step = plateSteps(pc.outline, opts.columns, opts.minCornerSegments);
  const earStep = (EAR_ARC_STEP_DEG * Math.PI) / 180;
  const points: Array<[number, number]> = [];
  const ears: Array<[number, number]> = [];
  let open: number | undefined;
  for (const seg of contourSegments(pc, delta)) {
    const onPlate = seg.plate;
    if (onPlate && open !== undefined) {
      ears.push([open, points.length]);
      open = undefined;
    } else if (!onPlate && open === undefined) open = points.length;
    if (seg.kind === "line") {
      const length = Math.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0);
      const count = Math.max(1, Math.ceil(length / (onPlate ? step.side : EAR_LINE_STEP) - 1e-9));
      for (let i = 0; i < count; i++) points.push([seg.x0 + ((seg.x1 - seg.x0) * i) / count, seg.y0 + ((seg.y1 - seg.y0) * i) / count]);
      continue;
    }
    const sweep = seg.a1 - seg.a0;
    const count = Math.max(1, Math.ceil(Math.abs(sweep) / (onPlate ? step.arc : earStep) - 1e-9));
    for (let i = 0; i < count; i++) {
      const a = seg.a0 + (sweep * i) / count;
      points.push([seg.cx + seg.r * Math.cos(a), seg.cy + seg.r * Math.sin(a)]);
    }
  }
  // A window still open at the end runs into the first point (two ears with no plate between them, the last one round the start).
  if (open !== undefined) ears.push([open, 0]);
  return { points, ears };
}

const landSegments = new WeakMap<PlateContour, Segment[]>();

/**
 * The signed distance from (x, y) to the land contour (negative inside), plus the margin: so it compares directly
 * with edgeChamfer.ts's `RimRow.offset`, and for the plain plate it is shapes.ts's `outlineOffsetAt` itself.
 */
export function contourOffsetAt(pc: PlateContour, x: number, y: number): number {
  if (pc.ears.length === 0) return outlineOffsetAt(pc.outline, x, y).offset;
  let segs = landSegments.get(pc);
  if (!segs) landSegments.set(pc, (segs = contourSegments(pc, 0)));
  let best = Infinity;
  let sign = 1;
  const take = (qx: number, qy: number, nx: number, ny: number) => {
    const d = Math.hypot(x - qx, y - qy);
    if (d < best) {
      best = d;
      sign = (x - qx) * nx + (y - qy) * ny > 0 ? 1 : -1;
    }
  };
  for (const seg of segs) {
    if (seg.kind === "line") {
      const [dx, dy] = [seg.x1 - seg.x0, seg.y1 - seg.y0];
      const len = Math.hypot(dx, dy);
      const f = Math.max(0, Math.min(1, ((x - seg.x0) * dx + (y - seg.y0) * dy) / (len * len)));
      take(seg.x0 + f * dx, seg.y0 + f * dy, dy / len, -dx / len);
      continue;
    }
    const sweep = seg.a1 - seg.a0;
    const angle = Math.atan2(y - seg.cy, x - seg.cx);
    const along = sweep >= 0 ? wrap(angle - seg.a0) : wrap(seg.a0 - angle);
    const point = (a: number) => take(seg.cx + seg.r * Math.cos(a), seg.cy + seg.r * Math.sin(a), (seg.concave ? -1 : 1) * Math.cos(a), (seg.concave ? -1 : 1) * Math.sin(a));
    if (along <= Math.abs(sweep)) point(angle);
    else {
      point(seg.a0);
      point(seg.a1);
    }
  }
  return sign * best + pc.margin;
}

/** Whether (x, y) lies inside the plate's land contour. */
export function insideContour(pc: PlateContour, x: number, y: number): boolean {
  return contourOffsetAt(pc, x, y) <= pc.margin;
}

/**
 * Whether the ear's own footprint (what it adds outside the plain plate, fillets included) keeps `clearance` from
 * every polygon in `keepOut`, with none of their corners inside it. False too when the ear can't be built there.
 */
export function earKeepsClear(pc: PlateContour, keepOut: XY[][], clearance: number): boolean {
  let segs: Segment[];
  try {
    segs = contourSegments(pc, 0);
  } catch {
    return false;
  }
  const outside = (x: number, y: number) => outlineOffsetAt(pc.outline, x, y).offset > pc.margin + 1e-6;
  // The ear's edge outside the plain plate, sampled finely.
  const edge: XY[] = [];
  for (const seg of segs) {
    const length = seg.kind === "line" ? Math.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0) : Math.abs(seg.r * (seg.a1 - seg.a0));
    const n = Math.max(1, Math.ceil(length / 0.25));
    for (let i = 0; i < n; i++) {
      const f = i / n;
      const [x, y] = seg.kind === "line" ? [seg.x0 + f * (seg.x1 - seg.x0), seg.y0 + f * (seg.y1 - seg.y0)] : [seg.cx + seg.r * Math.cos(seg.a0 + f * (seg.a1 - seg.a0)), seg.cy + seg.r * Math.sin(seg.a0 + f * (seg.a1 - seg.a0))];
      if (outside(x, y)) edge.push({ x, y });
    }
  }
  return keepOut.every((poly) => edge.every((p) => !inside(p, poly) && edgeDistance(p, poly) >= clearance) && poly.every((q) => !outside(q.x, q.y) || !insideContour(pc, q.x, q.y)));
}
