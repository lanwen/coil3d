import {
  CABLE_BASE_CLIP_INTERFERENCE,
  CABLE_BEND_BUDGET,
  CABLE_BRIDGE_STEP,
  CABLE_SWEEP_ARC_SEGMENTS,
  CABLE_SWEEP_MAX_SAG,
  CABLE_SWEEP_STEP,
  CENTRE_ALPHA_STEP_DEG,
  CENTRE_BORE_CLEARANCE,
  CENTRE_CAP_NOTCH_CLEARANCE,
  CENTRE_CHORD_MIN,
  CENTRE_CONNECTOR_PASSAGE,
  CENTRE_CUT_BELOW_BED,
  CENTRE_EXIT_OVERLAP,
  CENTRE_FLAT_MARGIN,
  CENTRE_GROOVE_CLEARANCE,
  CENTRE_GRIP_LENGTH,
  CENTRE_MIN_CROSSING_DEG,
  CENTRE_NECK_RAMP,
  CENTRE_PLAN_SHARE,
  CENTRE_SLACK_FRACTION,
  CENTRE_SLOT_LEAN_DEG,
  CENTRE_ROOF_ANGLE_DEG,
  CENTRE_VARIANTS,
  type CentreVariant,
  CENTRE_ROOF_FADE,
  CENTRE_ROOF_TAIL_DEG,
  CENTRE_RIB_EMBED,
  CENTRE_RIB_WALL,
  CENTRE_SEAT_GAP,
  CENTRE_TAIL_ABOVE,
  CENTRE_Z_SHARE,
  SIZE_HI,
  SIZE_LO_FLOOR,
} from "./constants";
import { bump, clipRadius } from "./innerEnd";
import type { SweepSolid, XY, XYZ } from "./innerEnd";
import { offsetPerimeter, pointAt, sideLength } from "./shapes";
import type { ShapeOutline } from "./shapes";
import { bottomMargin, grooveShape, grooveStartHeight, wallThickness } from "./wall";

export function centreBendRadius(mbr: number): number {
  return mbr / CABLE_BEND_BUDGET;
}

export function minCentreEndsHeight(wireDiameter: number, tolerance: number, mbr: number): number {
  return CENTRE_GRIP_LENGTH + centreBendRadius(mbr) + clipRadius(wireDiameter, tolerance);
}

export function ribProtrusion(wireDiameter: number, tolerance: number): number {
  return 2 * clipRadius(wireDiameter, tolerance) + CENTRE_SEAT_GAP + CENTRE_RIB_WALL;
}

export interface CentreInnerEnd {
  seat: XY;
  seatRadius: number;
  neckWidth: number;
  rib: XY[];
  neck: XY[];
  capNotch: XY[];
  path: XYZ[];
  channel: SweepSolid;
  channelVariants: SweepSolid[];
  variant: number;
  channelRibbon: XY[];
  floorRibbon: XY[];
  length: number;
  entry: XYZ;
  height: number;
  floorZ: number;
  feasible: boolean;
  ribOnFlat: boolean;
  arcAngle: number;
}

interface CentrePlan {
  alpha: number;
  arcRadius: number;
  bendRadius: number;
  seatRadius: number;
  seat: XY;
  neckDir: XY;
  bendEnd: XY;
  arcStart: XY;
  arcCentre: XY;
  j: XY;
  tangent: XY;
  normal: XY;
  levelZ: number;
  startZ: number;
  fallLength: number;
  fall: (s: number) => number;
  slack: number;
  feasible: boolean;
  ribOnFlat: boolean;
  chordLength: number;
  arcLength: number;
  arcPlanLength: number;
}

const CIRCLE_SAMPLES = 32;
const FALL_SAMPLES = 24;
const PLAN_CACHE_LIMIT = 256;
const planCache = new Map<string, CentrePlan>();

interface OutlineGeometry {
  half: number;
  innerApothem: number;
  cornerRadius: number;
  cornerCentreRadius: number;
  corners: XY[];
  flatNormals: XY[];
  sideHalf: number;
}

function outlineGeometry(o: ShapeOutline): OutlineGeometry {
  const half = Math.PI / o.n;
  const innerApothem = o.apothem - o.cornerRadius;
  const cornerCentreRadius = innerApothem / Math.cos(half);
  const corners = Array.from({ length: o.n }, (_, i) => ({ x: cornerCentreRadius * Math.cos((2 * Math.PI * i) / o.n), y: cornerCentreRadius * Math.sin((2 * Math.PI * i) / o.n) }));
  const flatNormals = Array.from({ length: o.n }, (_, i) => ({ x: Math.cos((2 * Math.PI * i) / o.n + half), y: Math.sin((2 * Math.PI * i) / o.n + half) }));
  return { half, innerApothem, cornerRadius: o.cornerRadius, cornerCentreRadius, corners, flatNormals, sideHalf: sideLength(o) / 2 };
}

function depthInside(g: OutlineGeometry, x: number, y: number): number {
  let q = -Infinity;
  for (const n of g.flatNormals) q = Math.max(q, x * n.x + y * n.y - g.innerApothem);
  if (q > 0) {
    q = Infinity;
    for (let i = 0; i < g.corners.length; i++) {
      const a = g.corners[i];
      const b = g.corners[(i + 1) % g.corners.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
      q = Math.min(q, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)));
    }
  }
  return g.cornerRadius - q;
}

function wrapAngle(a: number): number {
  let w = a;
  while (w > Math.PI) w -= 2 * Math.PI;
  while (w < -Math.PI) w += 2 * Math.PI;
  return w;
}

function lineChord(g: OutlineGeometry, apothem: number, px: number, py: number, dx: number, dy: number): [number, number] | undefined {
  const hits: number[] = [];
  for (let i = 0; i < g.corners.length; i++) {
    const c = g.corners[i];
    const fx = px - c.x;
    const fy = py - c.y;
    const b = fx * dx + fy * dy;
    const disc = b * b - (fx * fx + fy * fy - g.cornerRadius * g.cornerRadius);
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      const mid = (2 * Math.PI * i) / g.corners.length;
      for (const s of [-b - root, -b + root]) {
        const psi = Math.atan2(fy + s * dy, fx + s * dx);
        if (Math.abs(wrapAngle(psi - mid)) <= g.half + 1e-9) hits.push(s);
      }
    }
    const n = g.flatNormals[i];
    const along = dx * n.x + dy * n.y;
    if (Math.abs(along) > 1e-12) {
      const s = (apothem - (px * n.x + py * n.y)) / along;
      const tangential = (px + s * dx) * -n.y + (py + s * dy) * n.x;
      if (Math.abs(tangential) <= g.sideHalf + 1e-9) hits.push(s);
    }
  }
  if (hits.length < 2) return undefined;
  return [Math.min(...hits), Math.max(...hits)];
}

function ribFitsFlat(g: OutlineGeometry, p: XY, halfSpan: number): boolean {
  if (g.sideHalf <= 1e-6) return true;
  const angle = Math.atan2(p.y, p.x);
  let best = g.flatNormals[0];
  let bestGap = Infinity;
  for (const n of g.flatNormals) {
    const gap = Math.abs(wrapAngle(angle - Math.atan2(n.y, n.x)));
    if (gap < bestGap) {
      bestGap = gap;
      best = n;
    }
  }
  const tangential = p.x * -best.y + p.y * best.x;
  return Math.abs(tangential) + halfSpan <= g.sideHalf - CENTRE_FLAT_MARGIN;
}

function layerOneStart(outline: ShapeOutline, wireDiameter: number) {
  const groove = grooveShape(wireDiameter);
  const layerOffset = wireDiameter / 2 - groove.depth;
  const j = pointAt(outline, 0, layerOffset);
  const EPS = 1e-6;
  const ahead = pointAt(outline, EPS, layerOffset);
  const dx = ahead.x - j.x;
  const dy = ahead.y - j.y;
  const speed = Math.hypot(dx, dy) / EPS;
  return {
    j: { x: j.x, y: j.y },
    tangent: { x: dx / (speed * EPS), y: dy / (speed * EPS) },
    normal: { x: j.nx, y: j.ny },
    helixSlope: groove.pitch / speed,
    startZ: grooveStartHeight(groove, bottomMargin(wireDiameter)),
    perimeter: offsetPerimeter(outline, layerOffset),
  };
}

function fallProfile(rise: number, helixSlope: number, maxCurvature: number): { length: number; fall: (s: number) => number } {
  if (Math.abs(rise) < 1e-9 && helixSlope < 1e-9) return { length: 0, fall: () => 0 };
  let length = 1;
  while (bump(rise, helixSlope, length).A > maxCurvature && length < 1e5) length *= 2;
  let lo = 0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + length) / 2;
    if (bump(rise, helixSlope, mid).A > maxCurvature) lo = mid;
    else length = mid;
  }
  return { length, fall: bump(rise, helixSlope, length).value };
}

function seatAlong(g: OutlineGeometry, a: XY, e: XY, sIn: number, sOut: number, depth: number): number | undefined {
  const at = (s: number) => depthInside(g, a.x + e.x * s, a.y + e.y * s);
  if (at((sIn + sOut) / 2) < depth) return undefined;
  let lo = sIn;
  let hi = (sIn + sOut) / 2;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) < depth) lo = mid;
    else hi = mid;
  }
  return hi;
}

function boreCrossingDegrees(bore: OutlineGeometry, seat: XY, e: XY, centre: XY, arcRadius: number, normal: XY, tangent: XY, alpha: number, sSeat: number): number {
  const points: XY[] = [];
  for (let i = 0; i <= 16; i++) points.push({ x: seat.x + e.x * (i / 16) * -sSeat, y: seat.y + e.y * (i / 16) * -sSeat });
  for (let i = 1; i <= 40; i++) {
    const beta = alpha * (1 - i / 40);
    points.push({ x: centre.x + arcRadius * (normal.x * Math.cos(beta) - tangent.x * Math.sin(beta)), y: centre.y + arcRadius * (normal.y * Math.cos(beta) - tangent.y * Math.sin(beta)) });
  }
  for (let i = 0; i + 1 < points.length; i++) {
    if (depthInside(bore, points[i].x, points[i].y) < 0 || depthInside(bore, points[i + 1].x, points[i + 1].y) >= 0) continue;
    const h = { x: points[i + 1].x - points[i].x, y: points[i + 1].y - points[i].y };
    const hl = Math.hypot(h.x, h.y) || 1;
    const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
    const eps = 1e-3;
    const g = { x: depthInside(bore, mid.x + eps, mid.y) - depthInside(bore, mid.x - eps, mid.y), y: depthInside(bore, mid.x, mid.y + eps) - depthInside(bore, mid.x, mid.y - eps) };
    const gl = Math.hypot(g.x, g.y) || 1;
    return (Math.asin(Math.min(1, Math.abs((h.x * g.x + h.y * g.y) / (hl * gl)))) * 180) / Math.PI;
  }
  return 90;
}

function planKey(outline: ShapeOutline, bore: ShapeOutline, d: number, t: number, mbr: number): string {
  return [outline.n, outline.apothem, outline.cornerRadius, bore.apothem, bore.cornerRadius, d, t, mbr].join("|");
}

function planCentreInnerEnd(outline: ShapeOutline, boreOutline: ShapeOutline, d: number, t: number, mbr: number): CentrePlan {
  const key = planKey(outline, boreOutline, d, t, mbr);
  const cached = planCache.get(key);
  if (cached) return cached;
  const plan = computePlan(outline, boreOutline, d, t, mbr);
  if (planCache.size >= PLAN_CACHE_LIMIT) planCache.delete(planCache.keys().next().value!);
  planCache.set(key, plan);
  return plan;
}

function computePlan(outline: ShapeOutline, boreOutline: ShapeOutline, d: number, t: number, mbr: number): CentrePlan {
  const R = clipRadius(d, t);
  const bendRadius = centreBendRadius(mbr);
  const arcRadius = bendRadius / CENTRE_PLAN_SHARE;
  const start = layerOneStart(outline, d);
  const { j, tangent, normal, helixSlope, startZ } = start;
  const levelZ = R;
  const centre: XY = { x: j.x - arcRadius * normal.x, y: j.y - arcRadius * normal.y };
  const bore = outlineGeometry(boreOutline);
  const wall = outlineGeometry(outline);
  const layerOffset = d / 2 - grooveShape(d).depth;
  const boss = R + CENTRE_RIB_WALL;
  const seatDepth = R + CENTRE_SEAT_GAP;

  type Candidate = { alpha: number; slack: number; flat: boolean; steep: number; seat: XY; e: XY; a: XY; sSeat: number; sOut: number };
  const roomy = (slack: number) => slack >= CENTRE_SLACK_FRACTION * bendRadius;
  const rank = (c: Candidate): [number, number, number, number] => [roomy(c.slack) ? 1 : 0, roomy(c.slack) ? c.steep : 0, roomy(c.slack) && c.flat ? 1 : 0, c.slack];
  const outranks = (a: Candidate, b: Candidate) => {
    const [ra, rb] = [rank(a), rank(b)];
    for (let i = 0; i < 4; i++) if (ra[i] !== rb[i]) return ra[i] > rb[i];
    return false;
  };
  let best: Candidate | undefined;
  const steps = Math.floor(200 / CENTRE_ALPHA_STEP_DEG);
  for (let k = 2; k <= steps; k++) {
    const alpha = (k * CENTRE_ALPHA_STEP_DEG * Math.PI) / 180;
    const cs = Math.cos(alpha);
    const sn = Math.sin(alpha);
    const a: XY = { x: centre.x + arcRadius * (normal.x * cs - tangent.x * sn), y: centre.y + arcRadius * (normal.y * cs - tangent.y * sn) };
    const e: XY = { x: normal.x * sn + tangent.x * cs, y: normal.y * sn + tangent.y * cs };
    const chord = lineChord(bore, boreOutline.apothem, a.x, a.y, e.x, e.y);
    if (!chord || chord[0] >= 0) continue;
    const sSeat = seatAlong(bore, a, e, chord[0], chord[1], seatDepth);
    if (sSeat === undefined) continue;
    let inside = true;
    for (let q = 1; q <= 8 && inside; q++) {
      const beta = (alpha * q) / 9;
      const x = centre.x + arcRadius * (normal.x * Math.cos(beta) - tangent.x * Math.sin(beta));
      const y = centre.y + arcRadius * (normal.y * Math.cos(beta) - tangent.y * Math.sin(beta));
      inside = depthInside(wall, x, y) >= -layerOffset - 1e-6;
    }
    if (!inside) continue;
    const sBend = sSeat + bendRadius;
    const slack = Math.min(-CENTRE_CHORD_MIN - sBend, chord[1] - CENTRE_BORE_CLEARANCE - R - sBend);
    const seat: XY = { x: a.x + e.x * sSeat, y: a.y + e.y * sSeat };
    const flat = ribFitsFlat(bore, seat, boss);
    const steep = roomy(slack) ? Math.min(CENTRE_MIN_CROSSING_DEG, boreCrossingDegrees(bore, seat, e, centre, arcRadius, normal, tangent, alpha, sSeat)) : 0;
    const candidate = { alpha, slack, flat, steep, seat, e, a, sSeat, sOut: chord[1] };
    if (!best || outranks(candidate, best)) best = candidate;
  }
  if (!best) {
    const alpha = Math.PI / 2;
    const a: XY = { x: centre.x - arcRadius * tangent.x, y: centre.y - arcRadius * tangent.y };
    const e: XY = { x: normal.x, y: normal.y };
    best = { alpha, slack: -Infinity, flat: false, steep: 0, seat: { x: a.x - e.x * bendRadius, y: a.y - e.y * bendRadius }, e, a, sSeat: -bendRadius, sOut: 0 };
  }

  const zCurvature = (CENTRE_Z_SHARE * CABLE_BEND_BUDGET) / mbr;
  const fallProfileAt = fallProfile(startZ - levelZ, helixSlope, zCurvature);
  const arcLength = arcRadius * best.alpha;
  const chordLength = -best.sSeat - bendRadius;
  let arc3d = 0;
  for (let q = 0; q < FALL_SAMPLES; q++) {
    const s0 = (arcLength * q) / FALL_SAMPLES;
    const s1 = (arcLength * (q + 1)) / FALL_SAMPLES;
    arc3d += Math.hypot(s1 - s0, fallProfileAt.fall(s1) - fallProfileAt.fall(s0));
  }
  return {
    alpha: best.alpha,
    arcRadius,
    bendRadius,
    seatRadius: R,
    seat: best.seat,
    neckDir: best.e,
    bendEnd: { x: best.seat.x + best.e.x * bendRadius, y: best.seat.y + best.e.y * bendRadius },
    arcStart: best.a,
    arcCentre: centre,
    j,
    tangent,
    normal,
    levelZ,
    startZ,
    fallLength: fallProfileAt.length,
    fall: fallProfileAt.fall,
    slack: best.slack,
    feasible: roomy(best.slack) && fallProfileAt.length <= arcLength + chordLength,
    ribOnFlat: best.flat,
    chordLength,
    arcLength: arc3d,
    arcPlanLength: arcLength,
  };
}

export function centreInnerEndLength(outline: ShapeOutline, boreOutline: ShapeOutline, wireDiameter: number, tolerance: number, mbr: number, height: number): number {
  const plan = planCentreInnerEnd(outline, boreOutline, wireDiameter, tolerance, mbr);
  const verticalRun = Math.max(0, height - plan.levelZ - plan.bendRadius);
  return verticalRun + (Math.PI / 2) * plan.bendRadius + plan.chordLength + plan.arcLength;
}

export function centreInnerEndFits(outline: ShapeOutline, boreOutline: ShapeOutline, wireDiameter: number, tolerance: number, mbr: number): boolean {
  return planCentreInnerEnd(outline, boreOutline, wireDiameter, tolerance, mbr).feasible;
}

export function minCentreEndsOuterSize(outlineAt: (outerSize: number) => ShapeOutline, boreAt: (outline: ShapeOutline) => ShapeOutline, wireDiameter: number, tolerance: number, mbr: number): number {
  const passes = (size: number) => {
    const outline = outlineAt(size);
    const bore = boreAt(outline);
    if (2 * bore.apothem - ribProtrusion(wireDiameter, tolerance) < CENTRE_CONNECTOR_PASSAGE) return false;
    return wallThickness(wireDiameter) < size / 2 && centreInnerEndFits(outline, bore, wireDiameter, tolerance, mbr);
  };
  if (!passes(SIZE_HI)) return SIZE_HI;
  let tooSmall = SIZE_LO_FLOOR;
  let fits = SIZE_HI;
  for (let i = 0; i < 40; i++) {
    const middle = (tooSmall + fits) / 2;
    if (passes(middle)) fits = middle;
    else tooSmall = middle;
  }
  return fits;
}

interface PathFrame {
  centre: XYZ;
  u: XY;
  w: XYZ;
  lambda: number;
  roofDeg: number;
}

function ringOf(frame: PathFrame, radius: number, depth: number, variant: CentreVariant): XYZ[] {
  const { centre, u, w, lambda } = frame;
  const at = (a: number, b: number): XYZ => ({ x: centre.x + u.x * a + w.x * b, y: centre.y + u.y * a + w.y * b, z: centre.z + w.z * b });
  const roof = ((frame.roofDeg + variant.roofDeg) * Math.PI) / 180;
  const ring: XYZ[] = [at(0, radius / Math.cos(roof))];
  const upperSteps = 2;
  const lowerSteps = (3 * CABLE_SWEEP_ARC_SEGMENTS) / 2 - 2 * upperSteps;
  const angles: number[] = [];
  for (let j = 0; j <= upperSteps; j++) angles.push(roof + ((Math.PI / 2 - roof) * j) / upperSteps);
  for (let j = 1; j < lowerSteps; j++) angles.push(Math.PI / 2 + (Math.PI * j) / lowerSteps);
  for (let j = 0; j <= upperSteps; j++) angles.push((3 * Math.PI) / 2 + ((Math.PI / 2 - roof) * j) / upperSteps);
  for (const psi of angles) {
    const circle: XY = { x: radius * Math.sin(psi), y: radius * Math.cos(psi) };
    if (psi <= Math.PI / 2 + 1e-9 || psi >= (3 * Math.PI) / 2 - 1e-9 || lambda <= 0) {
      ring.push(at(circle.x, circle.y));
      continue;
    }
    const dirU = Math.sin(psi);
    const dirW = Math.cos(psi);
    const tilt = Math.tan(((CENTRE_SLOT_LEAN_DEG + variant.leanDeg) * Math.PI) / 180);
    const lean = Math.abs(dirU) + dirW * tilt;
    const reach = Math.min(lean > 1e-9 ? radius / lean : Infinity, depth / Math.abs(dirW));
    ring.push(at(circle.x + (reach * dirU - circle.x) * lambda, circle.y + (reach * dirW - circle.y) * lambda));
  }
  return ring;
}

function convexHull(points: XY[]): XY[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: XY, a: XY, b: XY) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const build = (pts: XY[]) => {
    const hull: XY[] = [];
    for (const p of pts) {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
      hull.push(p);
    }
    hull.pop();
    return hull;
  };
  return [...build(sorted), ...build([...sorted].reverse())];
}

export function layoutCentreInnerEnd(outline: ShapeOutline, boreOutline: ShapeOutline, wireDiameter: number, tolerance: number, mbr: number, height: number, floorZ = 0): CentreInnerEnd {
  const plan = planCentreInnerEnd(outline, boreOutline, wireDiameter, tolerance, mbr);
  const { seat, neckDir: e, bendRadius, arcRadius, arcCentre, normal, tangent, levelZ, seatRadius: R } = plan;
  const bore = outlineGeometry(boreOutline);
  const boss = R + CENTRE_RIB_WALL;

  const bendStartZ = levelZ + bendRadius;
  const topZ = height + CENTRE_TAIL_ABOVE;
  const coreTopZ = height + 1;
  const arcPoint = (beta: number): XY => ({
    x: arcCentre.x + arcRadius * (normal.x * Math.cos(beta) - tangent.x * Math.sin(beta)),
    y: arcCentre.y + arcRadius * (normal.y * Math.cos(beta) - tangent.y * Math.sin(beta)),
  });
  const heading = (beta: number): XY => ({ x: normal.x * Math.sin(beta) + tangent.x * Math.cos(beta), y: normal.y * Math.sin(beta) + tangent.y * Math.cos(beta) });
  const arcZ = (beta: number) => plan.startZ - plan.fall(arcRadius * beta);
  const chordZ = (x: number) => plan.startZ - plan.fall(plan.arcPlanLength + bendRadius + plan.chordLength - x);

  const path: XYZ[] = [];
  const verticalSteps = Math.max(1, Math.ceil((topZ - bendStartZ) / (4 * CABLE_BRIDGE_STEP)));
  for (let i = 0; i <= verticalSteps; i++) path.push({ x: seat.x, y: seat.y, z: topZ - ((topZ - bendStartZ) * i) / verticalSteps });
  const bendSteps = Math.max(2, Math.ceil(((Math.PI / 2) * bendRadius) / CABLE_BRIDGE_STEP));
  for (let i = 1; i <= bendSteps; i++) {
    const phi = ((Math.PI / 2) * i) / bendSteps;
    const x = bendRadius * (1 - Math.cos(phi));
    path.push({ x: seat.x + e.x * x, y: seat.y + e.y * x, z: bendStartZ - bendRadius * Math.sin(phi) });
  }
  const chordSteps = Math.max(1, Math.ceil(plan.chordLength / (4 * CABLE_BRIDGE_STEP)));
  for (let i = 1; i <= chordSteps; i++) {
    const x = bendRadius + (plan.chordLength * i) / chordSteps;
    path.push({ x: seat.x + e.x * x, y: seat.y + e.y * x, z: chordZ(x) });
  }
  const arcSteps = Math.max(2, Math.ceil((arcRadius * plan.alpha) / CABLE_BRIDGE_STEP));
  for (let i = 1; i <= arcSteps; i++) {
    const beta = plan.alpha * (1 - i / arcSteps);
    const p = arcPoint(beta);
    path.push({ x: p.x, y: p.y, z: arcZ(beta) });
  }

  const sweepStep = (radius: number) => Math.min(CABLE_SWEEP_STEP, Math.sqrt(8 * CABLE_SWEEP_MAX_SAG * radius));
  const up = (h: XY): XY => {
    const length = Math.hypot(h.x, h.y) || 1;
    return { x: -h.y / length, y: h.x / length };
  };
  const cutDepth = (z: number) => z - (floorZ - CENTRE_CUT_BELOW_BED);
  const frames: PathFrame[] = [];
  frames.push({ centre: { x: seat.x, y: seat.y, z: coreTopZ }, u: up(e), w: { x: e.x, y: e.y, z: 0 }, lambda: 0, roofDeg: CENTRE_ROOF_ANGLE_DEG });
  const bendCount = Math.max(2, Math.ceil(((Math.PI / 2) * bendRadius) / sweepStep(bendRadius)));
  for (let i = 0; i <= bendCount; i++) {
    const phi = ((Math.PI / 2) * i) / bendCount;
    const x = bendRadius * (1 - Math.cos(phi));
    frames.push({
      centre: { x: seat.x + e.x * x, y: seat.y + e.y * x, z: bendStartZ - bendRadius * Math.sin(phi) },
      u: up(e),
      w: { x: e.x * Math.cos(phi), y: e.y * Math.cos(phi), z: Math.sin(phi) },
      lambda: 0,
      roofDeg: CENTRE_ROOF_ANGLE_DEG,
    });
  }
  const ramp = Math.min(CENTRE_NECK_RAMP, Math.max(plan.chordLength, 0.2));
  const levelFrame = (x: number, lambda: number): PathFrame => ({ centre: { x: seat.x + e.x * x, y: seat.y + e.y * x, z: chordZ(x) }, u: up(e), w: { x: 0, y: 0, z: 1 }, lambda, roofDeg: CENTRE_ROOF_ANGLE_DEG });
  if (plan.chordLength > 1e-6) {
    frames.push(levelFrame(bendRadius + ramp, 1));
    frames.push(levelFrame(bendRadius + plan.chordLength, 1));
  } else {
    frames[frames.length - 1] = levelFrame(bendRadius, 1);
  }
  const groove = grooveShape(wireDiameter);
  const cutRadius = Math.min(R, groove.radius - CENTRE_GROOVE_CLEARANCE);
  const roofAt = (toGroove: number): number => {
    const fade = 1 - Math.min(1, toGroove / (CENTRE_ROOF_FADE * cutRadius));
    return CENTRE_ROOF_ANGLE_DEG + (CENTRE_ROOF_TAIL_DEG - CENTRE_ROOF_ANGLE_DEG) * fade;
  };
  const arcCount = Math.max(2, Math.ceil((arcRadius * plan.alpha) / sweepStep(arcRadius)));
  for (let i = 1; i <= arcCount; i++) {
    const beta = plan.alpha * (1 - i / arcCount);
    const p = arcPoint(beta);
    frames.push({ centre: { x: p.x, y: p.y, z: arcZ(beta) }, u: up(heading(beta)), w: { x: 0, y: 0, z: 1 }, lambda: 1, roofDeg: roofAt(arcRadius * beta) });
  }
  const layerOffset = wireDiameter / 2 - groove.depth;
  const turnLength = offsetPerimeter(outline, layerOffset);
  const exitCount = Math.max(1, Math.ceil(CENTRE_EXIT_OVERLAP / sweepStep(arcRadius)));
  for (let i = 1; i <= exitCount; i++) {
    const t = (CENTRE_EXIT_OVERLAP * i) / exitCount / turnLength;
    const p = pointAt(outline, t, layerOffset);
    const ahead = pointAt(outline, t + 1e-4, layerOffset);
    frames.push({ centre: { x: p.x, y: p.y, z: plan.startZ + groove.pitch * t }, u: up({ x: ahead.x - p.x, y: ahead.y - p.y }), w: { x: 0, y: 0, z: 1 }, lambda: 1, roofDeg: CENTRE_ROOF_TAIL_DEG });
  }
  const first = frames[0].centre;
  const last = frames[frames.length - 1].centre;
  const channelVariants: SweepSolid[] = CENTRE_VARIANTS.map((variant) => ({
    rings: frames.map((f) => ringOf(f, cutRadius, cutDepth(f.centre.z), variant)),
    start: { x: first.x, y: first.y, z: first.z },
    end: { x: last.x, y: last.y, z: last.z },
  }));
  const channel = channelVariants[0];

  const neckHalf = (wireDiameter * (1 - CABLE_BASE_CLIP_INTERFERENCE)) / 2;
  const neckLength = boss + 1;
  const side = { x: -e.y, y: e.x };
  const neck: XY[] = [
    { x: seat.x - side.x * neckHalf, y: seat.y - side.y * neckHalf },
    { x: seat.x + e.x * neckLength - side.x * neckHalf, y: seat.y + e.y * neckLength - side.y * neckHalf },
    { x: seat.x + e.x * neckLength + side.x * neckHalf, y: seat.y + e.y * neckLength + side.y * neckHalf },
    { x: seat.x + side.x * neckHalf, y: seat.y + side.y * neckHalf },
  ];

  const around = Array.from({ length: CIRCLE_SAMPLES }, (_, i) => ({ x: seat.x + boss * Math.cos((2 * Math.PI * i) / CIRCLE_SAMPLES), y: seat.y + boss * Math.sin((2 * Math.PI * i) / CIRCLE_SAMPLES) }));
  const eps = 1e-3;
  const grad = { x: depthInside(bore, seat.x + eps, seat.y) - depthInside(bore, seat.x - eps, seat.y), y: depthInside(bore, seat.x, seat.y + eps) - depthInside(bore, seat.x, seat.y - eps) };
  const gradLength = Math.hypot(grad.x, grad.y) || 1;
  const towardWall = { x: -grad.x / gradLength, y: -grad.y / gradLength };
  const embed = depthInside(bore, seat.x, seat.y) + CENTRE_RIB_EMBED;
  const across = { x: -towardWall.y, y: towardWall.x };
  const tabCorners = (reachAcross: number, reachIn: number): XY[] =>
    [-1, 1].map((sign) => ({ x: seat.x + towardWall.x * reachIn + across.x * sign * reachAcross, y: seat.y + towardWall.y * reachIn + across.y * sign * reachAcross }));
  const rib = convexHull([...around, ...tabCorners(boss, embed)]);

  const notchRadius = boss + CENTRE_CAP_NOTCH_CLEARANCE;
  const notchAround = Array.from({ length: CIRCLE_SAMPLES }, (_, i) => ({ x: seat.x + notchRadius * Math.cos((2 * Math.PI * i) / CIRCLE_SAMPLES), y: seat.y + notchRadius * Math.sin((2 * Math.PI * i) / CIRCLE_SAMPLES) }));
  const insideBore = (p: XY): XY => {
    const depth = depthInside(bore, p.x, p.y);
    return depth >= 0 ? p : { x: p.x + towardWall.x * depth, y: p.y + towardWall.y * depth };
  };
  const toWall = depthInside(bore, seat.x, seat.y);
  const capNotch = convexHull([...notchAround, ...tabCorners(notchRadius, toWall)].map(insideBore));

  const levelStations = path.filter((p) => p.z < levelZ + 2 * R + 1);
  const ribbonOf = (stations: XYZ[]): XY[] => {
    const rail = (sign: 1 | -1): XY[] =>
      stations.map((p, i) => {
        const a = stations[Math.max(0, i - 1)];
        const b = stations[Math.min(stations.length - 1, i + 1)];
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        return { x: p.x + (sign * -(b.y - a.y) * R) / len, y: p.y + (sign * (b.x - a.x) * R) / len };
      });
    return stations.length >= 2 ? [...rail(1), ...rail(-1).reverse()] : [];
  };
  const slotEdges = (side: 1 | -1): XY[] =>
    channelVariants[0].rings.flatMap((ring, i) => {
      if (frames[i].lambda <= 0) return [];
      const lowest = Math.min(...ring.map((q) => q.z));
      const bottom = ring.filter((q) => q.z <= lowest + 1e-9);
      const lateral = (q: XYZ) => (q.x - frames[i].centre.x) * frames[i].u.x + (q.y - frames[i].centre.y) * frames[i].u.y;
      const edge = bottom.reduce((best, q) => (side * lateral(q) > side * lateral(best) ? q : best));
      return [{ x: edge.x, y: edge.y }];
    });
  const channelRibbon = [...slotEdges(1), ...slotEdges(-1).reverse()];
  const floorRibbon = ribbonOf(levelStations);

  return {
    seat: { x: seat.x, y: seat.y },
    seatRadius: R,
    neckWidth: 2 * neckHalf,
    rib,
    neck,
    capNotch,
    path,
    channel,
    channelVariants,
    variant: 0,
    channelRibbon,
    floorRibbon,
    length: centreInnerEndLength(outline, boreOutline, wireDiameter, tolerance, mbr, height),
    entry: path[0],
    height,
    floorZ,
    feasible: plan.feasible,
    ribOnFlat: plan.ribOnFlat,
    arcAngle: plan.alpha,
  };
}
