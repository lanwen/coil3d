import {
  CABLE_BEND_BUDGET,
  CABLE_BEND_CHECK,
  CABLE_BRIDGE_STEP,
  CENTRE_CONNECTOR_PASSAGE,
  CLIMB_BULGE_SPANS,
  CLIMB_TURNS_STEP,
  CROSSING_MIN_LAYERS,
  FACE_BEND_MARGIN,
  FACE_ARC_JOINT_OVERLAP,
  FACE_EASE_LENGTH,
  FACE_FUNNEL_FIT_STEPS,
  FACE_WIDTH_STEPS,
  FACE_HOLE_CORNER_MIN,
  FACE_ARC_STEP,
  FACE_MARCH_STEP,
  FACE_MIN_CROSSING,
  FACE_MIN_THICKNESS,
  FACE_ROOF,
  FACE_SEAT_CLEARANCE,
  FACE_SEAT_SPAN,
  FACE_TAIL_HANG,
  FACE_WEB,
  HEIGHT_HI,
  LEAD_OUT_TURNS_MAX,
  MARGIN_BOTTOM,
  MARGIN_TOP_FACTOR,
  RAMP_BULGE_SPANS,
  RAMP_CLEAR_SLACK,
  RAMP_TURNS_MAX,
  RAMP_TURNS_MIN,
  RAMP_TURNS_STEP,
  SIZE_HI,
  SIZE_LO_FLOOR,
  TAPER_TURNS,
} from "./constants";
import { maxCurvature, outlineBlend, unitRamp, withNeighbours } from "./blend";
import { phaseShiftTurns, radialPitch, turnsForLayer } from "./capacity";
import { evalOutline, inscribedRadius, offsetPerimeter, outlineOffsetAt, paramAt, pointAt, sideLength } from "./shapes";
import type { ShapeOutline } from "./shapes";
import { grooveCrest, grooveShape, grooveStartHeight, windingSpan } from "./wall";
import type { XY, XYZ } from "./innerEnd";

export type FaceName = "bottom" | "top";

export interface OuterStart {
  t: number;
  z: number;
  slope: number;
  offset: number;
  neighbourOffset: number;
  neighbourTurns: number[];
  neighbourSlope: number;
  stackTop: number;
}

function climbsOutside(start: OuterStart): boolean {
  return start.slope < 0;
}

export interface FaceChannelSpec {
  outline: ShapeOutline;
  boreOutline: ShapeOutline;
  height: number;
  wireDiameter: number;
  tolerance: number;
  bendRadius: number;
  topFace: boolean;
  bottomFace: boolean;
  reserve?: number;
  outerStart?: OuterStart;
}

export interface FaceCutArc {
  centre: XY;
  radius: number;
  from: number;
  sweep: number;
}

export interface FaceEnd {
  face: FaceName;
  level: number;
  arcs: FaceCutArc[];
  hole: XY;
  seat: XY;
  heading: XY;
  run: number;
  bendRadius: number;
  windingZ: number;
  slope: number;
  tailEnd: number;
  length: number;
  ramp?: XYZ[];
}

export interface FaceChannelLayout {
  holeOutline: ShapeOutline;
  ringWidth: number;
  funnelDepth: number;
  channelRadius: number;
  bottomThickness: number;
  topThickness?: number;
  height: number;
  inner?: FaceEnd;
  outer?: FaceEnd;
}

interface Heading {
  x: number;
  y: number;
  tx: number;
  ty: number;
  nx: number;
  ny: number;
}

interface WindingFacts {
  zStart: number;
  zEnd: number;
  topRef: number;
  pitch: number;
  offset: number;
  turns: number;
}

function channelRadiusOf(wireDiameter: number, tolerance: number): number {
  return wireDiameter / 2 + tolerance;
}

function arcRadiusFloor(bendRadius: number): number {
  return bendRadius / CABLE_BEND_BUDGET;
}

export function crossingActive(layers: number, topCap: boolean): boolean {
  return !topCap && layers >= CROSSING_MIN_LAYERS;
}

export function crossingReserve(wireDiameter: number, tolerance: number): number {
  const groove = grooveShape(wireDiameter);
  const over = wireDiameter + tolerance;
  const clear = grooveCrest(groove) - TAPER_TURNS * groove.pitch + FACE_WEB + channelRadiusOf(wireDiameter, tolerance);
  return Math.max(over, clear);
}

export function nominalOuterStart(layers: number, wireDiameter: number, quality: number, height: number, reserve: number): OuterStart | undefined {
  if (layers < CROSSING_MIN_LAYERS) return undefined;
  const groove = grooveShape(wireDiameter);
  const zStart = grooveStartHeight(groove, MARGIN_BOTTOM);
  const span = Math.max(0, windingSpan(height, wireDiameter) - reserve);
  const turns = (layer: number) => turnsForLayer(span, groove.pitch, layer, quality);
  const step = radialPitch(wireDiameter, quality);
  const first = wireDiameter / 2 - groove.depth;
  const ascends = layers % 2 === 1;
  let t = 0;
  let stackTop = 0;
  for (let layer = 1; layer <= layers; layer++) {
    t += turns(layer);
    if (layer < layers || !ascends) stackTop = Math.max(stackTop, zStart + groove.pitch * (phaseShiftTurns(layer, quality) + turns(layer)));
  }
  const offset = first + (layers - 1) * step;
  const end = { t: t - RAMP_TURNS_MIN, offset, stackTop, neighbourTurns: [] };
  if (!ascends) return { ...end, z: zStart + groove.pitch * phaseShiftTurns(layers, quality), slope: -groove.pitch, neighbourOffset: offset, neighbourSlope: -groove.pitch };
  return { ...end, z: zStart + groove.pitch * turns(layers), slope: groove.pitch, neighbourOffset: first + (layers - 2) * step, neighbourSlope: -groove.pitch };
}

function windingFacts(wireDiameter: number, tolerance: number, height: number, reserve: number, outerStart: OuterStart | undefined): WindingFacts {
  const groove = grooveShape(wireDiameter);
  const zStart = grooveStartHeight(groove, MARGIN_BOTTOM);
  const turns = Math.max(0, Math.floor(Math.max(0, windingSpan(height, wireDiameter) - reserve) / groove.pitch));
  const zEnd = zStart + groove.pitch * turns;
  const topRef = outerStart ? crossingLevel(wireDiameter, tolerance, outerStart, zEnd) : zEnd;
  return { zStart, zEnd, topRef, pitch: groove.pitch, offset: wireDiameter / 2 - groove.depth, turns };
}

function crossingLevel(wireDiameter: number, tolerance: number, start: OuterStart, zEnd: number): number {
  const groove = grooveShape(wireDiameter);
  const clearOfGroove = zEnd - TAPER_TURNS * groove.pitch + grooveCrest(groove) + FACE_WEB + channelRadiusOf(wireDiameter, tolerance);
  return Math.max(start.stackTop + wireDiameter + tolerance, clearOfGroove);
}

function isCircular(outline: ShapeOutline): boolean {
  return outline.cornerRadius === outline.apothem || sideLength(outline) < 1e-6;
}

function headingAt(outline: ShapeOutline, t: number, offset: number, forward: boolean): Heading {
  const p = pointAt(outline, t, offset);
  const sign = forward ? 1 : -1;
  return { x: p.x, y: p.y, nx: p.nx, ny: p.ny, tx: -p.ny * sign, ty: p.nx * sign };
}

function planSpeed(outline: ShapeOutline, t: number, offset: number): number {
  const EPS = 1e-6;
  const a = pointAt(outline, t, offset);
  const b = pointAt(outline, t + EPS, offset);
  return Math.hypot(b.x - a.x, b.y - a.y) / EPS;
}

function forwardLocalRadius(outline: ShapeOutline, t: number, offset: number): number {
  if (isCircular(outline)) return outline.apothem + offset;
  return paramAt(outline, 0, t).seg % 2 === 0 ? outline.cornerRadius + offset : Infinity;
}

function arcPoint(arc: FaceCutArc, s: number): XY {
  const a = arc.from + (Math.sign(arc.sweep) * s) / arc.radius;
  return { x: arc.centre.x + arc.radius * Math.cos(a), y: arc.centre.y + arc.radius * Math.sin(a) };
}

function arcHeading(arc: FaceCutArc, s: number): XY {
  const sign = Math.sign(arc.sweep);
  const a = arc.from + (sign * s) / arc.radius;
  return { x: -sign * Math.sin(a), y: sign * Math.cos(a) };
}

function arcLength(arc: FaceCutArc): number {
  return Math.abs(arc.sweep) * arc.radius;
}

function holeOutlineOf(boreOutline: ShapeOutline, width: number): ShapeOutline {
  const apothem = boreOutline.apothem - width;
  if (isCircular(boreOutline)) return { n: boreOutline.n, apothem, cornerRadius: apothem };
  return { n: boreOutline.n, apothem, cornerRadius: Math.max(FACE_HOLE_CORNER_MIN, boreOutline.cornerRadius - width) };
}

function holeDistance(hole: ShapeOutline, p: XY): number {
  return isCircular(hole) ? Math.hypot(p.x, p.y) - hole.apothem : outlineOffsetAt(hole, p.x, p.y).offset;
}

function freeArc(h: Heading, radius: number, hole: ShapeOutline, inset: number, straight: number): { arc: FaceCutArc; end: XY; heading: XY } | undefined {
  const centre = { x: h.x - radius * h.nx, y: h.y - radius * h.ny };
  const sigma = h.tx * -h.ny + h.ty * h.nx >= 0 ? 1 : -1;
  const probe: FaceCutArc = { centre, radius, from: Math.atan2(h.ny, h.nx), sweep: sigma * Math.PI };
  const distanceAt = (s: number) => holeDistance(hole, arcPoint(probe, s));
  if (distanceAt(0) <= 0) return undefined;
  const limit = Math.PI * radius;
  const reach = (past: (distance: number) => boolean): number | undefined => {
    let lo = 0;
    let hi = FACE_ARC_STEP;
    while (hi < limit && !past(distanceAt(hi))) {
      lo = hi;
      hi += FACE_ARC_STEP;
    }
    if (!past(distanceAt(hi))) return undefined;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (past(distanceAt(mid))) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  const crossing = reach((distance) => distance <= 0);
  if (crossing === undefined) return undefined;
  const where = arcPoint(probe, crossing);
  const normal = isCircular(hole) ? { nx: where.x / Math.hypot(where.x, where.y), ny: where.y / Math.hypot(where.x, where.y) } : outlineOffsetAt(hole, where.x, where.y);
  const there = arcHeading(probe, crossing);
  if (-(there.x * normal.nx + there.y * normal.ny) < FACE_MIN_CROSSING) return undefined;
  const inside = reach((distance) => distance <= -inset);
  if (inside === undefined) return undefined;
  const room = (s: number) => {
    const at = arcPoint(probe, s);
    const to = arcHeading(probe, s);
    return holeDistance(hole, at) <= -inset && holeDistance(hole, { x: at.x + to.x * straight, y: at.y + to.y * straight }) <= -inset;
  };
  let along = inside;
  while (along < limit && !room(along)) along += FACE_MARCH_STEP;
  if (!room(along)) return undefined;
  const arc: FaceCutArc = { ...probe, sweep: (sigma * along) / radius };
  return { arc, end: arcPoint(arc, along), heading: arcHeading(arc, along) };
}

function followArc(outline: ShapeOutline, t: number, offset: number): { arc: FaceCutArc; nextT: number } | undefined {
  const p = pointAt(outline, t, offset);
  const remaining = 1 - paramAt(outline, 0, t).u;
  const radius = outline.cornerRadius + offset;
  const sweep = ((2 * Math.PI) / outline.n) * remaining;
  if (sweep * radius < FACE_MARCH_STEP) return undefined;
  const centre = { x: p.x - radius * p.nx, y: p.y - radius * p.ny };
  const corner = ((2 * Math.PI) / outline.n) * outline.cornerRadius;
  const perimeter = outline.n * (corner + sideLength(outline));
  return { arc: { centre, radius, from: Math.atan2(p.ny, p.nx), sweep }, nextT: t + (corner * remaining) / perimeter + 1e-9 };
}

interface SeatRange {
  near: number;
  far: number;
}

function seatRange(end: XY, heading: XY, hole: ShapeOutline, channelRadius: number, bendRadius: number): SeatRange | undefined {
  const room = -(channelRadius + FACE_SEAT_CLEARANCE);
  const inside = (s: number) => holeDistance(hole, { x: end.x + heading.x * s, y: end.y + heading.y * s }) <= room;
  if (!inside(bendRadius)) return undefined;
  let far = bendRadius;
  while (far < bendRadius + FACE_SEAT_SPAN * bendRadius && inside(far + FACE_MARCH_STEP)) far += FACE_MARCH_STEP;
  return { near: bendRadius, far };
}

interface EndPlan {
  arcs: FaceCutArc[];
  end: XY;
  heading: XY;
  length: number;
}

function radialRadius(h: Heading, holeRadius: number): number {
  return (h.x * h.x + h.y * h.y - holeRadius * holeRadius) / (2 * (h.x * h.nx + h.y * h.ny));
}

const ARC_RADIUS_STEPS = [1, 1.5, 2, 3, 4];

const END_CACHE_LIMIT = 20000;
const endCache = new Map<string, EndPlan | undefined>();

function planEndCached(outline: ShapeOutline, t: number, offset: number, forward: boolean, radiusFloor: number, hole: ShapeOutline, inset: number): EndPlan | undefined {
  const phase = Math.round((((t % 1) + 1) % 1) * 1e9);
  const key = [outline.n, outline.apothem, outline.cornerRadius, hole.apothem, hole.cornerRadius, phase, offset, forward, radiusFloor, inset].join(",");
  if (endCache.has(key)) return endCache.get(key);
  if (endCache.size >= END_CACHE_LIMIT) endCache.clear();
  const plan = planEnd(outline, t, offset, forward, radiusFloor, hole, inset);
  endCache.set(key, plan);
  return plan;
}

function planEnd(outline: ShapeOutline, t: number, offset: number, forward: boolean, radiusFloor: number, hole: ShapeOutline, inset: number): EndPlan | undefined {
  const arcs: FaceCutArc[] = [];
  const radiusFrom = (h: Heading) => Math.max(radiusFloor, isCircular(hole) ? radialRadius(h, hole.apothem) : outline.apothem + offset - hole.apothem);
  const local = forward ? forwardLocalRadius(outline, t, offset) : isCircular(outline) ? outline.apothem + offset : Infinity;
  let leave = headingAt(outline, t, offset, forward);
  if (local < Infinity && !isCircular(outline)) {
    const follow = followArc(outline, t, offset);
    if (follow) {
      arcs.push(follow.arc);
      leave = headingAt(outline, follow.nextT, offset, true);
    }
  }
  for (const step of ARC_RADIUS_STEPS) {
    const free = freeArc(leave, step * radiusFrom(leave), hole, inset, radiusFloor);
    if (!free) continue;
    const all = [...arcs, free.arc];
    return { arcs: all, end: free.end, heading: free.heading, length: all.reduce((sum, a) => sum + arcLength(a), 0) };
  }
  return undefined;
}

interface RingDims {
  channelRadius: number;
  bottomThickness: number;
  topThickness: number | undefined;
  width: number;
  funnelDepth: number;
  holeOutline: ShapeOutline;
}

function funnelDepthOf(boreOutline: ShapeOutline, hole: ShapeOutline, width: number): number {
  if (isCircular(boreOutline)) return width;
  let deepest = width;
  for (let corner = 0; corner < boreOutline.n; corner++) {
    const tip = evalOutline(boreOutline, { seg: 2 * corner, u: 0.5 }, 0);
    deepest = Math.max(deepest, holeDistance(hole, tip));
  }
  return deepest;
}

function ringDims(spec: FaceChannelSpec, facts: WindingFacts, topFace: boolean, step: number): RingDims | undefined {
  const { wireDiameter: d, tolerance: c, height } = spec;
  const channelRadius = channelRadiusOf(d, c);
  const bottomThickness = Math.max(FACE_MIN_THICKNESS, facts.zStart + channelRadius + FACE_ROOF);
  const topThickness = topFace ? Math.max(FACE_MIN_THICKNESS, height - facts.topRef + channelRadius + FACE_WEB) : undefined;
  const bendRadius = arcRadiusFloor(spec.bendRadius);
  const passage = Math.max(CENTRE_CONNECTOR_PASSAGE / 2 + c, (bendRadius + channelRadius + FACE_SEAT_CLEARANCE) / 2 + FACE_BEND_MARGIN);
  const bore = inscribedRadius(spec.boreOutline, 0);
  const narrowest = 2 * channelRadius + 2 * FACE_WEB;
  const thinnest = 2 * FACE_WEB;
  const reference = spec.outline.apothem + facts.offset;
  if (spec.outline.apothem < passage + narrowest) return undefined;
  const radial = reference > 2 * bendRadius ? Math.sqrt(reference * (reference - 2 * bendRadius)) : 0;
  const open = Math.max(passage, Math.min(bore - narrowest, radial));
  const room = height - bottomThickness - (topThickness ?? 0);
  const preferred = bore - open;
  let width = preferred - (Math.max(0, preferred - thinnest) * step) / FACE_WIDTH_STEPS;
  let hole = holeOutlineOf(spec.boreOutline, width);
  let funnelDepth = funnelDepthOf(spec.boreOutline, hole, width);
  for (let i = 0; i < FACE_FUNNEL_FIT_STEPS && topThickness !== undefined && funnelDepth > room; i++) {
    width *= room / funnelDepth;
    hole = holeOutlineOf(spec.boreOutline, width);
    funnelDepth = funnelDepthOf(spec.boreOutline, hole, width);
  }
  if (topThickness !== undefined && funnelDepth > room + 1e-6) return undefined;
  if (width < thinnest - 1e-9 || bore - width < passage - 1e-9) return undefined;
  return { channelRadius, bottomThickness, topThickness, width, funnelDepth, holeOutline: hole };
}

function easeRise(slope: number): number {
  return (slope * FACE_EASE_LENGTH) / 2;
}

interface Crossing {
  level: number;
  ramp: XYZ[];
  length: number;
}

function buildEnd(spec: FaceChannelSpec, facts: WindingFacts, face: FaceName, plan: EndPlan, slope: number, range: SeatRange, placement: number, crossing?: Crossing): FaceEnd | undefined {
  const bendRadius = arcRadiusFloor(spec.bendRadius);
  const distance = range.near + (range.far - range.near) * placement;
  const bottom = face === "bottom";
  const windingZ = crossing ? crossing.level : bottom ? facts.zStart : facts.zEnd;
  const rise = easeRise(crossing ? 0 : slope);
  const level = windingZ + ((bottom ? -1 : 1) * rise) / 2;
  const endZ = windingZ + (bottom ? -1 : 1) * rise;
  if (bottom && spec.bottomFace && spec.height < endZ + bendRadius + 1) return undefined;
  const run = distance - bendRadius;
  const climb = bottom ? spec.height - endZ - bendRadius : 0;
  return {
    face,
    level,
    arcs: plan.arcs,
    hole: plan.end,
    seat: { x: plan.end.x + plan.heading.x * distance, y: plan.end.y + plan.heading.y * distance },
    run,
    heading: plan.heading,
    bendRadius,
    windingZ,
    slope: crossing ? 0 : slope,
    tailEnd: bottom ? spec.height : endZ - bendRadius - FACE_TAIL_HANG,
    length: plan.length + run + (Math.PI / 2) * bendRadius + climb + (crossing?.length ?? 0),
    ramp: crossing?.ramp,
  };
}

interface OuterOption {
  plan: EndPlan;
  range: SeatRange;
  slope: number;
  crossing?: Crossing;
}

function rampBulge(spec: FaceChannelSpec, start: OuterStart): number {
  return Math.max(0, spec.wireDiameter + spec.tolerance - (start.offset - start.neighbourOffset));
}

function rampClears(spec: FaceChannelSpec, start: OuterStart, points: Float32Array, turns: number): boolean {
  const need = spec.wireDiameter + spec.tolerance;
  const last = points.length / 3 - 1;
  const gap = (i: number) =>
    start.neighbourTurns.map((z) => {
      const delta = (turns * i) / last;
      const offset = outlineOffsetAt(spec.outline, points[i * 3], points[i * 3 + 1]).offset;
      return Math.hypot(offset - start.neighbourOffset, points[i * 3 + 2] - (z + start.neighbourSlope * delta));
    });
  const floor = gap(0).map((g) => Math.min(need, g) - RAMP_CLEAR_SLACK);
  for (let i = 1; i <= last; i++) {
    const here = gap(i);
    if (here.some((g, k) => g < floor[k])) return false;
  }
  return true;
}

function* crossingOptions(spec: FaceChannelSpec, start: OuterStart, level: number, inset: number, hole: ShapeOutline): Generator<OuterOption> {
  const bendRadius = arcRadiusFloor(spec.bendRadius);
  const limit = CABLE_BEND_CHECK / spec.bendRadius;
  const bulge = rampBulge(spec, start);
  const startOffset = start.offset + bulge;
  const back = CABLE_BRIDGE_STEP / offsetPerimeter(spec.outline, start.offset);
  const bp = pointAt(spec.outline, start.t - back, start.offset);
  const before: [number, number, number] = [bp.x, bp.y, start.z - start.slope * back];
  const failed = new Set<number>();
  const climbs = climbsOutside(start);
  const spans = climbs ? CLIMB_BULGE_SPANS : RAMP_BULGE_SPANS;
  const turnsMax = climbs ? LEAD_OUT_TURNS_MAX : RAMP_TURNS_MAX;
  for (let turns = RAMP_TURNS_MIN; turns <= turnsMax + 1e-9; turns += climbs ? CLIMB_TURNS_STEP : RAMP_TURNS_STEP) {
    const phase = isCircular(spec.outline) ? 0 : Math.round((((start.t + turns) * spec.outline.n) % 1) * 1e6);
    if (failed.has(phase)) continue;
    const plan = planEndCached(spec.outline, start.t + turns, startOffset, true, bendRadius, hole, inset);
    const range = plan && seatRange(plan.end, plan.heading, hole, channelRadiusOf(spec.wireDiameter, spec.tolerance), bendRadius);
    if (!plan || !range) {
      failed.add(phase);
      continue;
    }
    for (const span of spans) {
      const points = outlineBlend(spec.outline, start.t, turns, (sigma) => start.offset + bulge * unitRamp(Math.min(1, sigma / span)), start.z, start.slope, level, 0);
      const bent = maxCurvature(withNeighbours(before, points)) > limit;
      if (bent && climbs) break;
      if (bent || !rampClears(spec, start, points, turns)) continue;
      const ramp: XYZ[] = Array.from({ length: points.length / 3 }, (_, i) => ({ x: points[i * 3], y: points[i * 3 + 1], z: points[i * 3 + 2] }));
      let length = 0;
      for (let i = 1; i < ramp.length; i++) length += Math.hypot(ramp[i].x - ramp[i - 1].x, ramp[i].y - ramp[i - 1].y, ramp[i].z - ramp[i - 1].z);
      yield { plan, range, slope: 0, crossing: { level, ramp, length } };
      break;
    }
  }
}

const PLACEMENTS = [0, 0.25, 0.5, 0.75, 1];
const PLACEMENT_PAIRS: Array<[number, number]> = PLACEMENTS.flatMap((a) => PLACEMENTS.map((b): [number, number] => [a, b])).sort((p, q) => p[0] + p[1] - (q[0] + q[1]) || Math.max(...p) - Math.max(...q));

function planUncached(spec: FaceChannelSpec): FaceChannelLayout | undefined {
  if (!spec.bottomFace && !spec.topFace) return undefined;
  const facts = windingFacts(spec.wireDiameter, spec.tolerance, spec.height, spec.reserve ?? 0, spec.topFace ? spec.outerStart : undefined);
  if (facts.turns < 1) return undefined;
  if (spec.topFace && spec.outerStart && facts.topRef + spec.wireDiameter / 2 > spec.height - MARGIN_TOP_FACTOR * (spec.wireDiameter / 2) + 1e-6) return undefined;
  for (let step = 0; step <= FACE_WIDTH_STEPS; step++) {
    const dims = ringDims(spec, facts, spec.topFace, step);
    const layout = dims && planWithRings(spec, facts, dims);
    if (layout) return layout;
  }
  return undefined;
}

function planWithRings(spec: FaceChannelSpec, facts: WindingFacts, dims: RingDims): FaceChannelLayout | undefined {
  const { channelRadius, holeOutline } = dims;
  const bendRadius = arcRadiusFloor(spec.bendRadius);
  const inset = channelRadius + FACE_SEAT_CLEARANCE;
  const innerPlan = planEnd(spec.outline, 0, facts.offset, false, bendRadius, holeOutline, inset);
  if (!innerPlan) return undefined;
  const innerRange = seatRange(innerPlan.end, innerPlan.heading, holeOutline, channelRadius, bendRadius);
  if (!innerRange) return undefined;
  const slopeIn = facts.pitch / planSpeed(spec.outline, 0, facts.offset);
  const layout = { holeOutline, ringWidth: dims.width, funnelDepth: dims.funnelDepth, channelRadius, bottomThickness: dims.bottomThickness, topThickness: dims.topThickness, height: spec.height };
  if (!spec.topFace) {
    const inner = buildEnd(spec, facts, "bottom", innerPlan, slopeIn, innerRange, 0);
    return inner && { ...layout, inner };
  }
  for (const option of outerOptions(spec, facts, holeOutline, inset, bendRadius, channelRadius)) {
    for (const [a, b] of PLACEMENT_PAIRS) {
      const inner = buildEnd(spec, facts, "bottom", innerPlan, slopeIn, innerRange, a);
      const outer = buildEnd(spec, facts, "top", option.plan, option.slope, option.range, b, option.crossing);
      const apart = spec.wireDiameter + 2 * FACE_SEAT_CLEARANCE;
      if (inner && outer && Math.hypot(inner.seat.x - outer.seat.x, inner.seat.y - outer.seat.y) >= apart && (!option.crossing || (pathDistance(outer, inner.seat) >= apart && pathDistance(inner, outer.seat) >= apart))) {
        return { ...layout, inner: spec.bottomFace ? inner : undefined, outer };
      }
    }
  }
  return undefined;
}

function pathDistance(end: FaceEnd, p: XY): number {
  let nearest = Infinity;
  const visit = (q: XY) => {
    nearest = Math.min(nearest, Math.hypot(q.x - p.x, q.y - p.y));
  };
  for (const arc of end.arcs) {
    const steps = Math.max(1, Math.ceil(arcLength(arc) / FACE_ARC_STEP));
    for (let i = 0; i <= steps; i++) visit(arcPoint(arc, (arcLength(arc) * i) / steps));
  }
  const reach = end.run + end.bendRadius;
  const runSteps = Math.max(1, Math.ceil(reach / FACE_ARC_STEP));
  for (let i = 0; i <= runSteps; i++) visit({ x: end.hole.x + end.heading.x * ((reach * i) / runSteps), y: end.hole.y + end.heading.y * ((reach * i) / runSteps) });
  return nearest;
}

function* outerOptions(spec: FaceChannelSpec, facts: WindingFacts, hole: ShapeOutline, inset: number, bendRadius: number, channelRadius: number): Generator<OuterOption> {
  if (spec.outerStart) {
    yield* crossingOptions(spec, spec.outerStart, facts.topRef, inset, hole);
    return;
  }
  const plan = planEnd(spec.outline, facts.turns, facts.offset, true, bendRadius, hole, inset);
  const range = plan && seatRange(plan.end, plan.heading, hole, channelRadius, bendRadius);
  if (plan && range) yield { plan, range, slope: facts.pitch / planSpeed(spec.outline, facts.turns, facts.offset) };
}

const PLAN_CACHE_LIMIT = 4096;
const planCache = new Map<string, FaceChannelLayout | undefined>();

export function planFaceChannels(spec: FaceChannelSpec): FaceChannelLayout | undefined {
  const { outline, boreOutline } = spec;
  const key = [outline.n, outline.apothem, outline.cornerRadius, boreOutline.apothem, boreOutline.cornerRadius, spec.height, spec.wireDiameter, spec.tolerance, spec.bendRadius, spec.topFace, spec.bottomFace, spec.reserve ?? 0, JSON.stringify(spec.outerStart ?? null)].join(",");
  if (planCache.has(key)) return planCache.get(key);
  if (planCache.size >= PLAN_CACHE_LIMIT) planCache.clear();
  const layout = planUncached(spec);
  planCache.set(key, layout);
  return layout;
}

export function faceCutArcs(end: FaceEnd): FaceCutArc[] {
  return end.arcs.map((arc, k) => {
    const sign = Math.sign(arc.sweep);
    const back = k === 0 ? (sign * FACE_ARC_JOINT_OVERLAP) / arc.radius : 0;
    const ahead = k < end.arcs.length - 1 ? (sign * FACE_ARC_JOINT_OVERLAP) / arc.radius : 0;
    return { ...arc, from: arc.from - back, sweep: arc.sweep + back + ahead };
  });
}

function easeAt(s: number): number {
  const L = FACE_EASE_LENGTH;
  if (s >= L) return L / 2;
  const x = s / L;
  return s - L * (x * x * x - (x * x * x * x) / 2);
}

export function faceEndPath(end: FaceEnd): XYZ[] {
  const sign = end.face === "bottom" ? -1 : 1;
  const points: XYZ[] = [];
  const zAt = (s: number) => end.windingZ + sign * end.slope * easeAt(s);
  let travelled = 0;
  if (end.ramp) points.push(...end.ramp);
  end.arcs.forEach((arc, k) => {
    const length = arcLength(arc);
    const steps = Math.max(1, Math.ceil(length / CABLE_BRIDGE_STEP));
    for (let i = k === 0 && !end.ramp ? 0 : 1; i <= steps; i++) {
      const s = (length * i) / steps;
      const p = arcPoint(arc, s);
      points.push({ x: p.x, y: p.y, z: zAt(travelled + s) });
    }
    travelled += length;
  });
  const arcEnd = points.at(-1)!;
  const runSteps = Math.max(1, Math.ceil(end.run / CABLE_BRIDGE_STEP));
  for (let i = 1; i <= runSteps; i++) {
    const along = (end.run * i) / runSteps;
    points.push({ x: arcEnd.x + end.heading.x * along, y: arcEnd.y + end.heading.y * along, z: arcEnd.z });
  }
  const last = points.at(-1)!;
  const bendSteps = Math.max(2, Math.ceil(((Math.PI / 2) * end.bendRadius) / CABLE_BRIDGE_STEP));
  const lift = end.face === "top" ? -1 : 1;
  for (let i = 1; i <= bendSteps; i++) {
    const phi = ((Math.PI / 2) * i) / bendSteps;
    const along = end.bendRadius * Math.sin(phi);
    points.push({ x: last.x + end.heading.x * along, y: last.y + end.heading.y * along, z: last.z + lift * end.bendRadius * (1 - Math.cos(phi)) });
  }
  const top = points.at(-1)!;
  const tailLength = Math.abs(end.tailEnd - top.z);
  const tailSteps = Math.max(1, Math.ceil(tailLength / CABLE_BRIDGE_STEP));
  for (let i = 1; i <= tailSteps; i++) points.push({ x: top.x, y: top.y, z: top.z + ((end.tailEnd - top.z) * i) / tailSteps });
  return points;
}

export function faceTopFloor(layout: FaceChannelLayout): number {
  return layout.topThickness === undefined ? layout.height : layout.height - layout.topThickness - layout.funnelDepth;
}

export function faceEndsLength(spec: FaceChannelSpec): number {
  const layout = planFaceChannels(spec);
  if (layout) return (layout.inner?.length ?? 0) + (layout.outer?.length ?? 0);
  return spec.bottomFace ? spec.height + (Math.PI / 2) * arcRadiusFloor(spec.bendRadius) + spec.outline.apothem : 0;
}

export function minFaceChannelOuterSize(outlineOf: (outerSize: number) => ShapeOutline, boreOf: (outline: ShapeOutline) => ShapeOutline, wireDiameter: number, tolerance: number, bendRadius: number, stack?: { layers: number; quality: number }): number {
  const wanted = stack && crossingReserve(wireDiameter, tolerance);
  const outerStart = stack && nominalOuterStart(stack.layers, wireDiameter, stack.quality, HEIGHT_HI, wanted ?? 0);
  const reserve = outerStart ? wanted! : 0;
  const fits = (outerSize: number) => {
    const outline = outlineOf(outerSize);
    return planFaceChannels({ outline, boreOutline: boreOf(outline), height: HEIGHT_HI, wireDiameter, tolerance, bendRadius, topFace: true, bottomFace: true, reserve, outerStart }) !== undefined;
  };
  if (!fits(SIZE_HI)) return SIZE_HI;
  let tooSmall = SIZE_LO_FLOOR;
  let works = SIZE_HI;
  for (let i = 0; i < 40; i++) {
    const middle = (tooSmall + works) / 2;
    if (fits(middle)) works = middle;
    else tooSmall = middle;
  }
  return works;
}

export function minFaceChannelHeight(wireDiameter: number, tolerance: number, bendRadius: number, bottomFace: boolean): number {
  const groove = grooveShape(wireDiameter);
  const channelRadius = channelRadiusOf(wireDiameter, tolerance);
  const zStart = grooveStartHeight(groove, MARGIN_BOTTOM);
  const bottom = zStart + channelRadius + FACE_ROOF;
  const top = 1.3 * (wireDiameter / 2) + groove.pitch + channelRadius + FACE_WEB;
  const narrowest = 4 * FACE_WEB;
  const bend = zStart + arcRadiusFloor(bendRadius) + 1 + groove.pitch;
  return bottomFace ? Math.max(bottom + top + narrowest, bend) : bottom + top + narrowest;
}
