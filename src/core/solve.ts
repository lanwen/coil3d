import { computeCapacity, envelopeDiameter, turnsForLayer } from "./capacity";
import type { CapacityResult } from "./capacity";
import { crossingActive, crossingReserve, faceEndsLength, minFaceChannelHeight, minFaceChannelOuterSize, nominalOuterStart, planFaceChannels } from "./faceChannel";
import { baseEnabled, flangeExtentOf, overallHeightOf, resolveBoreOutline, resolveFlangeSizing } from "./flange";
import { jointGeometry, resolveCapJoint } from "./joints";
import { isHeavyCable } from "./skadisClips";
import { layoutSkadisTclips } from "./skadisTclips";
import {
  CENTRE_CONNECTOR_PASSAGE,
  DEFAULT_PILL_RADIUS,
  FLANGE_MARGIN,
  HEIGHT_HI,
  LAYERS_HI,
  MAX_WIRE_LENGTH,
  MIN_FLANGE_THICKNESS_FOR_TCLIP,
  MIN_TURNS_PER_LAYER,
  SHAPE_ROUNDING_EPS,
  SIZE_HI,
  SIZE_LO_FLOOR,
} from "./constants";
import { makeOutline, offsetArea, shapePlugin } from "./shapes";
import type { ShapeOutline } from "./shapes";
import { bendMultiplierOf, noticeCollector } from "./types";
import { grooveShape, wallThickness, windingSpan } from "./wall";
import type { CoilSpec, CoreSizeLock, Diagnosis, Notice, Objective, ShapeSpec, Solution } from "./types";

function bendCornerRadiusFloor(wire: CoilSpec["wire"]): number {
  const mbr = bendMultiplierOf(wire) * wire.diameter;
  const o1 = wire.diameter / 2 - grooveShape(wire.diameter).depth;
  return Math.max(0, mbr - o1);
}

function resolveOutline(shape: ShapeSpec, outerSize: number, rcMin: number, wire: CoilSpec["wire"]): ShapeOutline {
  if (shape.kind === "round") return makeOutline("round", outerSize, outerSize / 2);
  if (shape.kind === "pill") return makeOutline("pill", outerSize, Math.max(shape.cornerRadius, rcMin));
  const rcMax = usefulMaxCornerRadius(shape.kind, outerSize, wire);
  const rc = Math.min(Math.max(shape.cornerRadius, rcMin), Math.max(0, rcMax));
  return makeOutline(shape.kind, outerSize, rc);
}

const MIN_FLAT_PERIMETER_FRACTION = 0.15;
const MIN_FLAT_WIRE_DIAMETERS = 2;
const PILL_LENGTH_TO_RADIUS = 4;

function minOuterSizeForShapeFlats(kind: Extract<ShapeSpec["kind"], "sq" | "tri">, wire: CoilSpec["wire"]): number {
  const n = shapePlugin(kind).corners;
  const k = Math.tan(Math.PI / n);
  const rcMin = bendCornerRadiusFloor(wire);
  const sizeForDiameterFloor = 2 * rcMin + (MIN_FLAT_WIRE_DIAMETERS * wire.diameter) / k;
  const perimeterMargin = 1 - MIN_FLAT_PERIMETER_FRACTION * n;
  const sideLengthForPerimeterFloor = (MIN_FLAT_PERIMETER_FRACTION * 2 * Math.PI * rcMin) / perimeterMargin;
  const sizeForPerimeterFloor = 2 * rcMin + sideLengthForPerimeterFloor / k;
  return Math.max(sizeForDiameterFloor, sizeForPerimeterFloor);
}

function pillEndRadiusFloor(spec: CoilSpec): number {
  return Math.max(bendCornerRadiusFloor(spec.wire), centreFloors(spec).size / 2);
}

function minOuterSizeForShape(shape: ShapeSpec, wire: CoilSpec["wire"], minOuterSizeForBend: number): number {
  return shape.kind === "round" || shape.kind === "pill" ? minOuterSizeForBend : minOuterSizeForShapeFlats(shape.kind, wire);
}

function usefulMaxCornerRadius(kind: Extract<ShapeSpec["kind"], "sq" | "tri">, outerSize: number, wire: CoilSpec["wire"]): number {
  const n = shapePlugin(kind).corners;
  const k = Math.tan(Math.PI / n);
  const apothem = outerSize / 2;

  const diameterFloorCr = apothem - (MIN_FLAT_WIRE_DIAMETERS * wire.diameter) / (2 * k);

  const minFlatFraction = MIN_FLAT_PERIMETER_FRACTION;
  const flatSlope = 2 * k * (1 - minFlatFraction * n);
  const perimeterFloorCr = (flatSlope * apothem) / (flatSlope + 2 * Math.PI * minFlatFraction);
  const hardCeiling = Math.max(0, apothem - SHAPE_ROUNDING_EPS);
  return Math.min(diameterFloorCr, perimeterFloorCr, hardCeiling);
}

const CAPACITY_EPS = 1e-6;
const AT_FLOOR_TOLERANCE = 1e-6;
const FLOOR_CEILING_TOLERANCE = 1e-9;
const ENVELOPE_BED_WARNING_MM = 500;
const BISECTION_ITERATIONS = 60;
const FIT_SEARCH_ITERATIONS = 40;
const SIZE_HEIGHT_SAMPLES_TWO_FREE = 48;
const SIZE_HEIGHT_SAMPLES_THREE_FREE = 32;
const CAPACITY_SHORTFALL_NOTE_PCT = 10;
const OVERSHOOT_NOTE_PCT = 10;
const PRACTICAL_LAYERS_HI = 6;

function bisect(f: (x: number) => number, lo: number, hi: number, target: number, iters = BISECTION_ITERATIONS): number {
  let a = lo;
  let b = hi;
  if (f(a) >= target) return a;
  if (f(b) <= target) return b;
  for (let i = 0; i < iters; i++) {
    const m = (a + b) / 2;
    if (f(m) < target) a = m;
    else b = m;
  }
  return b;
}

function solveIntegerUpTo(f: (n: number) => number, lo: number, hi: number, target: number): number {
  let best = lo;
  for (let n = lo; n <= hi; n++) {
    best = n;
    if (f(n) >= target) return n;
  }
  return best;
}

function coversTarget(length: number, target: number): boolean {
  return length >= target * (1 - CAPACITY_EPS);
}

type FullCoreHeight = number;

interface Resolved {
  outerSize: number;
  height: FullCoreHeight;
  layers: number;
}

function toOuterSize(lock: Extract<CoilSpec["coreSize"], { locked: true }>, wireDiameter: number): number {
  return lock.dimension === "outer" ? lock.value : lock.value + 2 * wallThickness(wireDiameter);
}

function reserveFor(spec: CoilSpec, layers: number): number {
  return crossingActive(layers, resolveTopCap(spec)) ? crossingReserve(spec.wire.diameter, spec.tolerance) : 0;
}

function lowestHeightWithTurn(height: number, wireDiameter: number, reserve: number): number {
  const { pitch } = grooveShape(wireDiameter);
  let lowest = height;
  while (turnsForLayer(Math.max(0, windingSpan(lowest, wireDiameter) - reserve), pitch, 1, 0) < 1) lowest += Math.abs(lowest) * Number.EPSILON;
  return lowest;
}

function capacityOf(spec: CoilSpec, quality: number, g: Resolved) {
  const wire = spec.wire;
  const groove = grooveShape(wire.diameter);
  const usableHeight = Math.max(0, windingSpan(g.height, wire.diameter) - reserveFor(spec, g.layers));
  const outline = resolveOutline(spec.shape, g.outerSize, bendCornerRadiusFloor(wire), wire);
  return computeCapacity({
    outline,
    usableHeight,
    layers: g.layers,
    wireDiameter: wire.diameter,
    grooveDepth: groove.depth,
    pitch: groove.pitch,
    quality,
  });
}

function endsLengthFor(spec: CoilSpec, g: Resolved, cap: CapacityResult): number {
  const woundLayers = cap.layerResults.filter((r) => r.turns > 0).length;
  const topFace = woundLayers > 0 && !resolveTopCap(spec);
  const bottomFace = !baseEnabled(spec);
  if (!bottomFace && !topFace) return 0;
  const outline = resolveOutline(spec.shape, g.outerSize, bendCornerRadiusFloor(spec.wire), spec.wire);
  const reserve = reserveFor(spec, g.layers);
  return faceEndsLength({
    outline,
    boreOutline: resolveBoreOutline(outline, spec.wire.diameter).boreOutline,
    height: g.height,
    wireDiameter: spec.wire.diameter,
    tolerance: spec.tolerance,
    bendRadius: bendMultiplierOf(spec.wire) * spec.wire.diameter,
    topFace,
    bottomFace,
    reserve,
    outerStart: topFace ? nominalOuterStart(woundLayers, spec.wire.diameter, spec.windingQuality, g.height, reserve) : undefined,
  });
}

function lengthFor(spec: CoilSpec, g: Resolved): number {
  const cap = capacityOf(spec, spec.windingQuality, g);
  return cap.totalWoundLength + endsLengthFor(spec, g, cap);
}

function resolveTopCap(spec: CoilSpec): boolean {
  return spec.topCap === "on";
}

function centreFloors(spec: CoilSpec): { size: number; height: number } {
  const bottomFace = !baseEnabled(spec);
  if (!bottomFace && resolveTopCap(spec)) return { size: 0, height: 0 };
  const d = spec.wire.diameter;
  const mbr = bendMultiplierOf(spec.wire) * d;
  const rcMin = bendCornerRadiusFloor(spec.wire);
  const stack = spec.layers.locked ? { layers: spec.layers.value, quality: spec.windingQuality } : undefined;
  const outlineAt =
    spec.shape.kind === "pill"
      ? (outerSize: number) => makeOutline("round", outerSize, outerSize / 2)
      : (outerSize: number) => resolveOutline(spec.shape, outerSize, rcMin, spec.wire);
  return {
    size: minFaceChannelOuterSize(outlineAt, (outline) => resolveBoreOutline(outline, d).boreOutline, d, spec.tolerance, mbr, stack),
    height: minFaceChannelHeight(d, spec.tolerance, mbr, bottomFace),
  };
}

interface FitFloors {
  size: number;
  jointSize: number;
  height: number;
  sizeFor?: string;
  heightFor?: string;
}

const NO_FIT_FLOORS: FitFloors = { size: 0, jointSize: 0, height: 0 };

function smallestThat(fits: (value: number) => boolean, lo: number, hi: number): number | undefined {
  if (fits(lo)) return lo;
  if (!fits(hi)) return undefined;
  let tooSmall = lo;
  let works = hi;
  for (let i = 0; i < FIT_SEARCH_ITERATIONS; i++) {
    const middle = (tooSmall + works) / 2;
    if (fits(middle)) works = middle;
    else tooSmall = middle;
  }
  return works;
}

function coreAt(spec: CoilSpec, outerSize: number, height: number) {
  const outline = resolveOutline(spec.shape, outerSize, bendCornerRadiusFloor(spec.wire), spec.wire);
  const boreOutline = resolveBoreOutline(outline, spec.wire.diameter).boreOutline;
  return { outline, boreOutline, height, grooveDepth: grooveShape(spec.wire.diameter).depth };
}

function capJointFits(spec: CoilSpec, outerSize: number, height: number): boolean {
  return resolveCapJoint(spec, coreAt(spec, outerSize, height)).warning === undefined;
}

function tclipsFit(spec: CoilSpec, outerSize: number): boolean {
  const core = coreAt(spec, outerSize, HEIGHT_HI);
  const d = spec.wire.diameter;
  const capOn = resolveTopCap(spec);
  const mayHaveTopRing = !capOn;
  const reserve = spec.layers.locked ? reserveFor(spec, spec.layers.value) : 0;
  const outerStart = spec.layers.locked && reserve > 0 ? nominalOuterStart(spec.layers.value, d, spec.windingQuality, HEIGHT_HI, reserve) : undefined;
  const faceChannels = mayHaveTopRing
    ? planFaceChannels({ outline: core.outline, boreOutline: core.boreOutline, height: HEIGHT_HI, wireDiameter: d, tolerance: spec.tolerance, bendRadius: bendMultiplierOf(spec.wire) * d, topFace: true, bottomFace: false, reserve, outerStart })
    : undefined;
  return (
    layoutSkadisTclips({
      boreOutline: core.boreOutline,
      capHole: capOn ? jointGeometry(core.boreOutline, resolveCapJoint(spec, core).joint, spec.tolerance).holeOutline : undefined,
      ring: faceChannels?.topThickness !== undefined ? { holeOutline: faceChannels.holeOutline, funnelFloor: HEIGHT_HI } : undefined,
      wallTop: HEIGHT_HI,
      thickness: MIN_FLANGE_THICKNESS_FOR_TCLIP,
      tolerance: spec.tolerance,
    }).clips.length > 0
  );
}

const JOINT_LABELS = { bayonet: "the twist lock", snap: "the snap clips" } as const;

function fitFloors(spec: CoilSpec): FitFloors {
  const wantsJoint = resolveTopCap(spec) && (spec.joint === "snap" || (spec.joint === "bayonet" && spec.shape.kind === "round"));
  const wantsTclips = spec.mount === "skadis-tclip";
  if (!wantsJoint && !wantsTclips) return NO_FIT_FLOORS;
  const jointSize = wantsJoint ? smallestThat((s) => capJointFits(spec, s, HEIGHT_HI), SIZE_LO_FLOOR, SIZE_HI) ?? 0 : 0;
  const jointHeight = wantsJoint ? smallestThat((h) => capJointFits(spec, SIZE_HI, h), 0, HEIGHT_HI) ?? 0 : 0;
  const tclipSize = wantsTclips ? smallestThat((s) => (!wantsJoint || capJointFits(spec, s, HEIGHT_HI)) && tclipsFit(spec, s), SIZE_LO_FLOOR, SIZE_HI) ?? 0 : 0;
  const size = Math.max(jointSize, tclipSize);
  const jointLabel = wantsJoint ? JOINT_LABELS[spec.joint as keyof typeof JOINT_LABELS] : undefined;
  return { size, jointSize, height: jointHeight, sizeFor: tclipSize > jointSize ? "the SKÅDIS T-clips" : jointLabel, heightFor: jointLabel };
}

function turnsPerLayerPenalty(cap: CapacityResult): number {
  const minTurns = cap.layerResults.reduce((m, l) => Math.min(m, l.turns), Infinity);
  const shortfall = Math.max(0, MIN_TURNS_PER_LAYER - minTurns);
  return 1 + shortfall * shortfall;
}

function realExtentsFor(spec: CoilSpec, g: Resolved, outline: ShapeOutline, cap: CapacityResult): { margin: number; overallHeight: number } {
  const { boreOutline } = resolveBoreOutline(outline, spec.wire.diameter);
  const env = envelopeDiameter(outline, cap.outermostOffset, spec.wire.diameter);
  const flangeSizeEnvelope = env + 2 * FLANGE_MARGIN;
  const topCapEnabled = resolveTopCap(spec);
  const baseOn = baseEnabled(spec);
  const { margin, thickness } = resolveFlangeSizing(
    outline,
    boreOutline,
    flangeSizeEnvelope,
    spec.wire.diameter,
    baseOn ? spec.mount : "none",
    { tolerance: spec.tolerance, bendRadius: bendMultiplierOf(spec.wire) * spec.wire.diameter, heavyCable: isHeavyCable(spec.wire.diameter, spec.wire.length), woundLayers: cap.layerResults.filter((r) => r.turns > 0).length, topCap: topCapEnabled },
    spec.keyholeRotation,
    spec.throughHoleDiameter,
    baseOn,
  );
  return { margin, overallHeight: overallHeightOf(thickness, g.height, topCapEnabled) };
}

function envelopeVolumeFor(spec: CoilSpec, g: Resolved): number {
  const cap = capacityOf(spec, spec.windingQuality, g);
  const outline = resolveOutline(spec.shape, g.outerSize, bendCornerRadiusFloor(spec.wire), spec.wire);
  const { margin, overallHeight } = realExtentsFor(spec, g, outline, cap);
  const trueVolume = offsetArea(outline, margin) * overallHeight;
  return trueVolume * turnsPerLayerPenalty(cap);
}

function aspectScoreFor(spec: CoilSpec, g: Resolved): number {
  const cap = capacityOf(spec, spec.windingQuality, g);
  const outline = resolveOutline(spec.shape, g.outerSize, bendCornerRadiusFloor(spec.wire), spec.wire);
  const { margin, overallHeight } = realExtentsFor(spec, g, outline, cap);
  const flangeWidth = flangeExtentOf(outline, margin).acrossFlats;
  return Math.abs(overallHeight - flangeWidth);
}

function scoreOf(objective: Objective): (spec: CoilSpec, g: Resolved) => number {
  return objective === "minVolume" ? envelopeVolumeFor : aspectScoreFor;
}

function finishSolution(
  spec: CoilSpec,
  resolved: Resolved,
  diagnosis: Diagnosis,
  objectiveUsed: Objective | undefined,
  minOuterSizeForBend: number,
  minOuterSizeForShapeVal: number,
  minHeight: number,
  radiusFloor: number,
): { solution: Solution; notices: Notice[] } {
  const { notices, problem, note } = noticeCollector();
  const target = spec.wire.length;

  const cap = capacityOf(spec, spec.windingQuality, resolved);
  const capLo = capacityOf(spec, 0, resolved);
  const capHi = capacityOf(spec, 1, resolved);
  const ends = endsLengthFor(spec, resolved, cap);
  const totalWireLength = cap.totalWoundLength + ends;
  const lengthLo = capLo.totalWoundLength + ends;
  const lengthHi = capHi.totalWoundLength + ends;

  const rcMin = bendCornerRadiusFloor(spec.wire);
  const rcMaxHard = resolved.outerSize / 2;
  const rcMax = spec.shape.kind === "round" || spec.shape.kind === "pill" ? rcMaxHard : usefulMaxCornerRadius(spec.shape.kind, resolved.outerSize, spec.wire);
  const outline = resolveOutline(spec.shape, resolved.outerSize, rcMin, spec.wire);
  const rcFloor = spec.shape.kind === "pill" ? radiusFloor : rcMin;
  const cornerRadius = outline.cornerRadius;

  const wall = wallThickness(spec.wire.diameter);
  const innerBore = resolved.outerSize - 2 * wall;
  const env = envelopeDiameter(outline, cap.outermostOffset, spec.wire.diameter);
  const flangeSize = env + 2 * FLANGE_MARGIN;
  const topCapEnabled = resolveTopCap(spec);
  const deltaPct = ((totalWireLength - target) / target) * 100;

  if (innerBore <= 0) {
    problem(`Wall thickness (${Number(wall.toFixed(1))} mm) leaves no bore at outer size ${resolved.outerSize.toFixed(1)} mm. Increase outer size.`);
  }
  if (env > ENVELOPE_BED_WARNING_MM) {
    note(`Envelope footprint is ${env.toFixed(0)} mm. Check this fits your print bed.`);
  }
  if (deltaPct < -CAPACITY_SHORTFALL_NOTE_PCT) {
    note(`Resulting capacity is ${deltaPct.toFixed(0)}% vs. the target cable length.`);
  }
  const capacityMin = Math.min(lengthLo, lengthHi);
  const capacityMinWinding = lengthHi < lengthLo ? "nested" : "stacked";
  const qualityMatters = Math.abs(lengthLo - lengthHi) > target * CAPACITY_EPS;
  if (qualityMatters && capacityMin < target * (1 - CAPACITY_EPS)) {
    const pctOfTarget = (capacityMin / target) * 100;
    const shortfall = `capacity is only ${capacityMin.toFixed(0)} mm (${pctOfTarget.toFixed(0)}% of the ${target.toFixed(0)} mm target)`;
    note(
      capacityMinWinding === "nested"
        ? `At the tightest winding quality (nested layers), ${shortfall}: a tight winding may not fit the full length; wind looser for more.`
        : `At the loosest winding quality (stacked layers), ${shortfall}: a loose winding may not fit the full length; wind snugly for more.`,
    );
  }
  if (spec.shape.kind === "pill") {
    if (rcFloor >= rcMaxHard - FLOOR_CEILING_TOLERANCE) {
      note(`The pill core is round at this size: the ${rcFloor.toFixed(1)} mm end radius it needs is half its ${resolved.outerSize.toFixed(1)} mm length.`);
    } else if (spec.shape.cornerRadius > rcMax + FLOOR_CEILING_TOLERANCE) {
      note(`End radius clamped down to ${rcMax.toFixed(1)} mm: at half the core length the pill is round.`);
    }
  } else if (spec.shape.kind !== "round") {
    const label = shapePlugin(spec.shape.kind).label.toLowerCase();
    const requested = spec.shape.cornerRadius;
    if (rcMin >= rcMaxHard) {
      problem(
        `The bend limit needs at least a ${rcMin.toFixed(1)} mm corner radius, but the core is only ${resolved.outerSize.toFixed(1)} mm across. The ${label} core is effectively round.`,
      );
    } else if (requested < rcMin - FLOOR_CEILING_TOLERANCE) {
      note(`Corner radius clamped up to ${rcMin.toFixed(1)} mm (requested ${requested.toFixed(1)} mm) to respect the bend limit.`);
    } else if (requested > rcMax + FLOOR_CEILING_TOLERANCE) {
      note(`Corner radius clamped down to ${rcMax.toFixed(1)} mm (the largest that still reads as a ${label}, not a circle).`);
    }
  }

  const solution: Solution = {
    diagnosis,
    objectiveUsed,
    outerSize: resolved.outerSize,
    cornerRadius,
    cornerRadiusRange: [Math.min(rcFloor, rcMax), rcMax],
    innerBore,
    height: resolved.height,
    layers: resolved.layers,
    layerResults: cap.layerResults,
    totalWoundLength: cap.totalWoundLength,
    totalWireLength,
    targetWireLength: target,
    lengthDeltaPct: deltaPct,
    capacityRange: [Math.min(lengthLo, lengthHi), Math.max(lengthLo, lengthHi)],
    capacityMinWinding,
    windingQualityUsed: cap.windingQualityUsed,
    envelopeDiameter: env,
    flangeSize,
    topCapEnabled,
    minOuterSizeForBend,
    minOuterSizeForShape: minOuterSizeForShapeVal,
    minHeight,
    alternates: [],
  };
  return { solution, notices };
}

interface SizeHeightSearchResult {
  feasible?: { g: Resolved; length: number; score: number };
  closest: { g: Resolved; length: number };
}

function sizeThenHeight(spec: CoilSpec, height: number, layers: number, sizeLo: number, sizeHi: number, heightLo: number, target: number): Resolved {
  const outerSize = bisect((s) => lengthFor(spec, { outerSize: s, height, layers }), sizeLo, sizeHi, target);
  if (outerSize > sizeLo) return { outerSize, height, layers };
  return { outerSize, height: bisect((h) => lengthFor(spec, { outerSize, height: h, layers }), heightLo, height, target), layers };
}

function needsEveryLayer(spec: CoilSpec, g: Resolved, target: number): boolean {
  return g.layers <= 1 || !coversTarget(lengthFor(spec, { ...g, layers: g.layers - 1 }), target);
}

function searchSizeAndHeight(
  spec: CoilSpec,
  layers: number,
  sizeLo: number,
  sizeHi: number,
  heightLo: number,
  heightHi: number,
  target: number,
  objective: Objective,
  samples: number,
): SizeHeightSearchResult {
  const score = scoreOf(objective);
  let feasible: { g: Resolved; length: number; score: number } | undefined;
  let closest: { g: Resolved; length: number } | undefined;
  for (let i = 0; i <= samples; i++) {
    const height = heightLo + ((heightHi - heightLo) * i) / samples;
    const g = sizeThenHeight(spec, height, layers, sizeLo, sizeHi, heightLo, target);
    const length = lengthFor(spec, g);
    if (!closest || length > closest.length) closest = { g, length };
    if (coversTarget(length, target) && needsEveryLayer(spec, g, target)) {
      const s = score(spec, g);
      if (!feasible || s < feasible.score) feasible = { g, length, score: s };
    }
  }
  return { feasible, closest: closest! };
}

const mm = (v: number) => `${Number(v.toFixed(1))} mm`;

function overshootNote(
  spec: CoilSpec,
  g: Resolved,
  locked: { size: boolean; height: boolean; layers: boolean },
  sizeLo: number,
  heightLo: number,
  deltaPct: number,
  fit: FitFloors,
): string {
  const target = spec.wire.length;
  const current = lengthFor(spec, g);
  const holdsWithLess = (h: Resolved) => {
    const length = lengthFor(spec, h);
    return coversTarget(length, target) && length < current * (1 - CAPACITY_EPS);
  };
  const causes: string[] = [];
  if (locked.size && holdsWithLess({ ...g, outerSize: bisect((s) => lengthFor(spec, { ...g, outerSize: s }), sizeLo, g.outerSize, target) })) {
    causes.push(`core size (${mm(g.outerSize)})`);
  }
  if (locked.height && holdsWithLess({ ...g, height: bisect((h) => lengthFor(spec, { ...g, height: h }), heightLo, g.height, target) })) {
    causes.push(`height (${mm(g.height)})`);
  }
  if (locked.layers && holdsWithLess({ ...g, layers: solveIntegerUpTo((n) => lengthFor(spec, { ...g, layers: n }), 1, g.layers, target) })) {
    causes.push(`${g.layers} layers`);
  }
  const room = `Room for ${deltaPct.toFixed(0)}% more cable than you need`;
  if (causes.length > 0) {
    const list = causes.length === 1 ? causes[0] : `${causes.slice(0, -1).join(", ")} and ${causes.at(-1)}`;
    return `${room}, because of the locked ${list}. Unlock ${causes.length === 1 ? "it" : "them"} to let the coil get smaller.`;
  }
  if (g.outerSize <= sizeLo + AT_FLOOR_TOLERANCE) {
    const floor =
      sizeLo <= SIZE_LO_FLOOR
        ? `the core can't be smaller than ${mm(sizeLo)}`
        : fit.sizeFor && fit.size >= sizeLo - AT_FLOOR_TOLERANCE
          ? `the bore needs room for ${fit.sizeFor}, which takes a core of at least ${mm(sizeLo)}`
        : spec.shape.kind === "pill" && sizeLo >= PILL_LENGTH_TO_RADIUS * spec.shape.cornerRadius - AT_FLOOR_TOLERANCE
          ? `a pill core is kept at least twice as long as it is wide, which takes a core of at least ${mm(sizeLo)} at this ${mm(spec.shape.cornerRadius)} end radius`
        : centreFloors(spec).size >= sizeLo - AT_FLOOR_TOLERANCE
          ? `the cable's ends have to reach the centre hole at its ${mm(bendMultiplierOf(spec.wire) * spec.wire.diameter)} bend radius, which needs a core of at least ${mm(sizeLo)}`
        : spec.shape.kind === "round" || spec.shape.kind === "pill"
          ? `this cable's ${mm(bendMultiplierOf(spec.wire) * spec.wire.diameter)} bend radius needs a core of at least ${mm(sizeLo)}`
          : `this cable's bend limit needs a ${shapePlugin(spec.shape.kind).label.toLowerCase()} core of at least ${mm(sizeLo)}`;
    return `${room}: ${floor}, and the fewest turns around it already hold that much. This is the smallest coil for this cable.`;
  }
  return `${room}: the coil can't lose a whole turn or layer and still hold the cable.`;
}

function withEndRadiusAtLeast(spec: CoilSpec, floor: number): CoilSpec {
  if (spec.shape.kind !== "pill" || spec.shape.cornerRadius >= floor) return spec;
  return { ...spec, shape: { kind: "pill", cornerRadius: floor } };
}

function endRadiusNote(requested: number, floor: number, channelBinds: boolean): string {
  return channelBinds
    ? `End radius raised to ${mm(floor)} so the cable's ends can pass the centre hole.`
    : `End radius clamped up to ${mm(floor)} (requested ${mm(requested)}) to respect the bend limit.`;
}

export function coreSizeForPill(spec: CoilSpec): CoreSizeLock {
  if (!spec.coreSize.locked) return spec.coreSize;
  const pillSpec: CoilSpec = { ...spec, shape: { kind: "pill", cornerRadius: DEFAULT_PILL_RADIUS } };
  const pillLength = PILL_LENGTH_TO_RADIUS * Math.max(DEFAULT_PILL_RADIUS, pillEndRadiusFloor(pillSpec));
  const wallOffset = spec.coreSize.dimension === "inner" ? 2 * wallThickness(spec.wire.diameter) : 0;
  const value = Math.max(spec.coreSize.value, Math.ceil(pillLength - wallOffset - FLOOR_CEILING_TOLERANCE));
  return { ...spec.coreSize, value };
}

export function solve(rawSpec: CoilSpec): { solution: Solution; notices: Notice[] } {
  const { notices, problem, note } = noticeCollector();

  const cappedSpec: CoilSpec =
    rawSpec.wire.length > MAX_WIRE_LENGTH ? { ...rawSpec, wire: { ...rawSpec.wire, length: MAX_WIRE_LENGTH } } : rawSpec;
  if (rawSpec.wire.length > MAX_WIRE_LENGTH) {
    problem(
      `Your cable is ${(rawSpec.wire.length / 10).toFixed(0)} cm long, over the 15 m maximum, so the coil is sized for 15 m.`,
    );
  }

  const bendMultiplier = bendMultiplierOf(cappedSpec.wire);
  const mbr = bendMultiplier * cappedSpec.wire.diameter;
  const groove = grooveShape(cappedSpec.wire.diameter);
  const o1 = cappedSpec.wire.diameter / 2 - groove.depth;
  const rcMin = Math.max(0, mbr - o1);
  const minOuterSizeForBend = 2 * rcMin;
  const endRadiusFloor = cappedSpec.shape.kind === "pill" ? pillEndRadiusFloor(cappedSpec) : rcMin;
  const spec = withEndRadiusAtLeast(cappedSpec, endRadiusFloor);
  if (cappedSpec.shape.kind === "pill" && cappedSpec.shape.cornerRadius < endRadiusFloor - FLOOR_CEILING_TOLERANCE) {
    note(endRadiusNote(cappedSpec.shape.cornerRadius, endRadiusFloor, endRadiusFloor > rcMin + FLOOR_CEILING_TOLERANCE));
  }
  const shapeFloor = minOuterSizeForShape(spec.shape, spec.wire, minOuterSizeForBend);
  const centre = centreFloors(spec);
  const centreBinds = centre.size > shapeFloor + FLOOR_CEILING_TOLERANCE;
  const minOuterSizeForShapeVal = Math.max(shapeFloor, centre.size);
  const sizeFree = !spec.coreSize.locked;
  const heightFree = !spec.height.locked;
  const fit = fitFloors(spec);
  const jointHeightFloor = !spec.coreSize.locked || toOuterSize(spec.coreSize, spec.wire.diameter) >= fit.jointSize ? fit.height : 0;
  const pillLengthFloor = spec.shape.kind === "pill" ? Math.min(SIZE_HI, PILL_LENGTH_TO_RADIUS * spec.shape.cornerRadius) : 0;
  const sizeLo = Math.max(SIZE_LO_FLOOR, minOuterSizeForShapeVal, sizeFree ? Math.max(fit.size, pillLengthFloor) : 0);
  const sizeHi = SIZE_HI;
  const lockedReserve = spec.layers.locked ? reserveFor(spec, spec.layers.value) : 0;
  const oneTurnHeight = groove.pitch - windingSpan(0, spec.wire.diameter) + lockedReserve;
  const baseHeightLo = lowestHeightWithTurn(Math.max(oneTurnHeight, centre.height), spec.wire.diameter, lockedReserve);
  const heightLo = Math.max(baseHeightLo, heightFree ? jointHeightFloor : 0);
  const heightHi = HEIGHT_HI;
  const layersLo = 1;
  const layersHi = LAYERS_HI;

  const layersFree = !spec.layers.locked;
  const freeVars: Array<"coreSize" | "height" | "layers"> = [
    ...(sizeFree ? (["coreSize"] as const) : []),
    ...(heightFree ? (["height"] as const) : []),
    ...(layersFree ? (["layers"] as const) : []),
  ];
  const freeCount = freeVars.length as 0 | 1 | 2 | 3;

  let lockedOuterSize = spec.coreSize.locked ? toOuterSize(spec.coreSize, spec.wire.diameter) : undefined;
  if (lockedOuterSize !== undefined && lockedOuterSize < minOuterSizeForShapeVal - FLOOR_CEILING_TOLERANCE) {
    const why = centreBinds
      ? `the cable's ends have to reach the centre hole at its ${mbr.toFixed(1)} mm bend radius, and the hole has to pass a ${CENTRE_CONNECTOR_PASSAGE} mm connector`
      : spec.shape.kind === "round" || spec.shape.kind === "pill"
        ? `this cable's ${mbr.toFixed(1)} mm bend radius needs at least that much`
        : `this cable's bend limit needs at least that much to keep the ${shapePlugin(spec.shape.kind).label.toLowerCase()} core's straight sides meaningful, or the shape would be indistinguishable from round`;
    note(`Core size raised from ${lockedOuterSize.toFixed(1)} mm to ${minOuterSizeForShapeVal.toFixed(1)} mm: ${why}.`);
    lockedOuterSize = minOuterSizeForShapeVal;
  }
  let lockedHeight = spec.height.locked ? spec.height.value : undefined;
  if (lockedHeight !== undefined && lockedHeight < baseHeightLo - FLOOR_CEILING_TOLERANCE) {
    const why =
      centre.height >= oneTurnHeight
        ? `the end rings at the bottom and top of a bare core take the cable's ends, and the inner end bends up to the top at its ${mbr.toFixed(1)} mm bend radius`
        : `the core needs room for at least one turn of this ${mm(spec.wire.diameter)} cable`;
    note(`Height raised from ${lockedHeight.toFixed(1)} mm to ${baseHeightLo.toFixed(1)} mm: ${why}.`);
    lockedHeight = baseHeightLo;
  }
  const lockedLayers = spec.layers.locked ? spec.layers.value : undefined;

  const target = spec.wire.length;
  let resolved: Resolved;
  let diagnosis: Diagnosis;
  let objectiveUsed: Objective | undefined;
  let alternates: Solution[] = [];

  if (freeCount === 0) {
    resolved = { outerSize: lockedOuterSize!, height: lockedHeight!, layers: lockedLayers! };
    const computed = lengthFor(spec, resolved);
    const deltaPct = ((computed - target) / target) * 100;
    if (coversTarget(computed, target)) {
      diagnosis = { freeCount, freeVariables: freeVars, status: "ok", message: "Fully constrained; the locked geometry holds the target length." };
    } else {
      diagnosis = {
        freeCount,
        freeVariables: freeVars,
        status: "over-constrained",
        message: `Fully constrained geometry falls short of capacity by ${Math.abs(deltaPct).toFixed(0)}%: the cable will not fit. Release the outer size, height, or layers lock to let the solver fix this.`,
      };
    }
  } else if (freeCount === 1) {
    if (sizeFree) {
      const size = bisect((s) => lengthFor(spec, { outerSize: s, height: lockedHeight!, layers: lockedLayers! }), sizeLo, sizeHi, target);
      resolved = { outerSize: size, height: lockedHeight!, layers: lockedLayers! };
    } else if (heightFree) {
      const height = bisect((h) => lengthFor(spec, { outerSize: lockedOuterSize!, height: h, layers: lockedLayers! }), heightLo, heightHi, target);
      resolved = { outerSize: lockedOuterSize!, height, layers: lockedLayers! };
    } else {
      const layers = solveIntegerUpTo((n) => lengthFor(spec, { outerSize: lockedOuterSize!, height: lockedHeight!, layers: n }), layersLo, layersHi, target);
      resolved = { outerSize: lockedOuterSize!, height: lockedHeight!, layers };
    }
    const computed = lengthFor(spec, resolved);
    const deltaPct = ((computed - target) / target) * 100;

    if (!coversTarget(computed, target)) {
      diagnosis = {
        freeCount,
        freeVariables: freeVars,
        status: "infeasible",
        message: `The target cable length is unreachable within practical bounds even with this dimension maxed out (falls short by ${Math.abs(deltaPct).toFixed(0)}%). Lock a shorter target or free another dimension.`,
      };
    } else {
      diagnosis = {
        freeCount,
        freeVariables: freeVars,
        status: "ok",
        message: "Solved directly for the single free dimension; capacity covers the target with the smallest overshoot.",
      };
    }
  } else if (freeCount === 2) {
    const objective = spec.objective;
    objectiveUsed = objective;

    type Candidate = { g: Resolved; length: number };
    const candidates: Candidate[] = [];

    if (layersFree && sizeFree && !heightFree) {
      for (let n = layersLo; n <= layersHi; n++) {
        const size = bisect((s) => lengthFor(spec, { outerSize: s, height: lockedHeight!, layers: n }), sizeLo, sizeHi, target);
        const g = { outerSize: size, height: lockedHeight!, layers: n };
        candidates.push({ g, length: lengthFor(spec, g) });
      }
    } else if (layersFree && heightFree && !sizeFree) {
      for (let n = layersLo; n <= layersHi; n++) {
        const height = bisect((h) => lengthFor(spec, { outerSize: lockedOuterSize!, height: h, layers: n }), heightLo, heightHi, target);
        const g = { outerSize: lockedOuterSize!, height, layers: n };
        candidates.push({ g, length: lengthFor(spec, g) });
      }
    } else {
      const SAMPLES = SIZE_HEIGHT_SAMPLES_TWO_FREE;
      for (let i = 0; i <= SAMPLES; i++) {
        const height = heightLo + ((heightHi - heightLo) * i) / SAMPLES;
        const g = sizeThenHeight(spec, height, lockedLayers!, sizeLo, sizeHi, heightLo, target);
        candidates.push({ g, length: lengthFor(spec, g) });
      }
    }

    const feasible = candidates.filter((c) => coversTarget(c.length, target) && (!layersFree || needsEveryLayer(spec, c.g, target)));

    if (feasible.length === 0) {
      const closest = candidates.reduce((a, b) => (b.length > a.length ? b : a));
      const shortfallPct = ((target - closest.length) / target) * 100;
      resolved = closest.g;
      diagnosis = {
        freeCount,
        freeVariables: freeVars,
        status: "infeasible",
        message: `Two free dimensions: no sampled combination reaches the target length within practical bounds (the best falls short by ${shortfallPct.toFixed(0)}%). Free the third dimension or shorten the target.`,
      };
    } else {
      const pickBest = (o: Objective) => {
        const score = scoreOf(o);
        let best = feasible[0];
        let bestScore = score(spec, best.g);
        for (const c of feasible.slice(1)) {
          const s = score(spec, c.g);
          if (s < bestScore) {
            best = c;
            bestScore = s;
          }
        }
        return best;
      };

      const primary = pickBest(objective);
      resolved = primary.g;
      diagnosis = {
        freeCount,
        freeVariables: freeVars,
        status: "ok",
        message: `Two free dimensions: picked the "${objective}" candidate among solutions that cover the target length with the smallest overshoot. See the alternate candidate for comparison.`,
      };

      const otherObjective: Objective = objective === "minVolume" ? "aspectRatio" : "minVolume";
      const altBest = pickBest(otherObjective);
      const sameGeometry = altBest.g.outerSize === primary.g.outerSize && altBest.g.height === primary.g.height && altBest.g.layers === primary.g.layers;
      if (!sameGeometry) {
        const altDiagnosis: Diagnosis = {
          ...diagnosis,
          message: `Two free dimensions: the "${otherObjective}" objective's pick among the same target-covering candidates.`,
        };
        alternates = [finishSolution(spec, altBest.g, altDiagnosis, otherObjective, minOuterSizeForBend, minOuterSizeForShapeVal, baseHeightLo, endRadiusFloor).solution];
      }
    }
  } else {
    const objective = spec.objective;
    objectiveUsed = objective;
    const SAMPLES = SIZE_HEIGHT_SAMPLES_THREE_FREE;

    const perLayer: Array<{ n: number; result: SizeHeightSearchResult }> = [];
    for (let n = 1; n <= PRACTICAL_LAYERS_HI; n++) {
      perLayer.push({ n, result: searchSizeAndHeight(spec, n, sizeLo, sizeHi, heightLo, heightHi, target, objective, SAMPLES) });
    }

    const feasiblePerLayer = perLayer
      .filter((p) => p.result.feasible)
      .map((p) => ({ n: p.n, g: p.result.feasible!.g, length: p.result.feasible!.length, score: p.result.feasible!.score }));

    if (feasiblePerLayer.length === 0) {
      const closestOverall = perLayer.reduce((a, b) => (b.result.closest.length > a.result.closest.length ? b : a));
      const shortfallPct = ((target - closestOverall.result.closest.length) / target) * 100;
      resolved = closestOverall.result.closest.g;
      diagnosis = {
        freeCount,
        freeVariables: freeVars,
        status: "infeasible",
        message: `All three dimensions are free, but even the best sampled combination (up to ${PRACTICAL_LAYERS_HI} layers) falls short of the target length by ${shortfallPct.toFixed(0)}%. Increase the practical bounds or shorten the target.`,
      };
    } else {
      feasiblePerLayer.sort((a, b) => a.score - b.score);
      const primary = feasiblePerLayer[0];
      resolved = primary.g;
      diagnosis = {
        freeCount,
        freeVariables: freeVars,
        status: "under-constrained",
        message: `All three dimensions are free: picked layers=${primary.n} by the "${objective}" objective among combinations that cover the target length. Lock at least one dimension for a deterministic result.`,
      };

      const chosenNs = new Set([primary.n]);
      const altPicks: typeof feasiblePerLayer = [];
      for (const wantN of [1, 2]) {
        const found = feasiblePerLayer.find((p) => p.n === wantN && !chosenNs.has(p.n));
        if (found) {
          altPicks.push(found);
          chosenNs.add(found.n);
        }
      }
      for (const p of feasiblePerLayer) {
        if (altPicks.length >= 2) break;
        if (chosenNs.has(p.n)) continue;
        altPicks.push(p);
        chosenNs.add(p.n);
      }
      alternates = altPicks.map((p) => {
        const altDiagnosis: Diagnosis = {
          freeCount,
          freeVariables: freeVars,
          status: "under-constrained",
          message: `All three dimensions are free: layers=${p.n} fixed, best outer size/height for the "${objective}" objective among combinations that cover the target length.`,
        };
        return finishSolution(spec, p.g, altDiagnosis, objective, minOuterSizeForBend, minOuterSizeForShapeVal, baseHeightLo, endRadiusFloor).solution;
      });
    }
  }

  const finished = finishSolution(spec, resolved, diagnosis, objectiveUsed, minOuterSizeForBend, minOuterSizeForShapeVal, baseHeightLo, endRadiusFloor);
  finished.solution.alternates = alternates;
  const overshoots = finished.solution.lengthDeltaPct > OVERSHOOT_NOTE_PCT;
  if (overshoots) {
    note(overshootNote(spec, resolved, { size: !sizeFree, height: !heightFree, layers: !layersFree }, sizeLo, heightLo, finished.solution.lengthDeltaPct, fit));
  }
  const sizeGrown = sizeFree && fit.sizeFor !== undefined && fit.size > minOuterSizeForShapeVal + FLOOR_CEILING_TOLERANCE && resolved.outerSize <= sizeLo + AT_FLOOR_TOLERANCE;
  if (sizeGrown && !overshoots) {
    note(`Core size raised to ${mm(sizeLo)}: the bore needs room for ${fit.sizeFor}.`);
  }
  const heightGrown = heightFree && fit.heightFor !== undefined && heightLo > baseHeightLo + FLOOR_CEILING_TOLERANCE && resolved.height <= heightLo + AT_FLOOR_TOLERANCE;
  if (heightGrown) {
    note(`Height raised to ${mm(heightLo)}: the bore needs room for ${fit.heightFor}.`);
  }
  return { solution: finished.solution, notices: [...notices, ...finished.notices] };
}
