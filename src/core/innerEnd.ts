// Cable fix points (issues #8, #115, #117, #241, docs/design.md, Cable ends):
// the bottom flange's recessed channel + clip for the inner cable end, and
// the rim slots in the base and the cap. Pure geometry math only -- no
// manifold-3d, no replicad -- shared by the mesh backend (manifold.ts), the
// STEP backend (step/build.ts) AND the drawn cable (wire.ts, design.ts), the
// same "one shared layout, several consumers" principle as mount.ts's
// `layoutKeyholeMount`: all of them build from the SAME cross-section rings.
//
// Issue #115: the cable must never bend tighter than its minimum bend
// radius (MBR). The cable leaves the groove start (layer 1's first sample,
// `J`) along the helix's OWN tangent, backwards, as a straight chord across
// the flange margin -- a cable at its MBR can follow a straight line. Two
// gentle, curvature-limited blends ride on that chord, one after the other
// (the first turn starts on the flange face, so the cable can't drop while
// it is still beside the wall):
//   - sideways (`N`, the outward normal at t=0): the channel sits a skin
//     clear of the wall, so the cable lies in a full-width trench; meanwhile
//     the helix's own slope eases off, with the cable's bottom on the face;
//   - z: then the cable drops into the recessed channel (cable top flush
//     with the face, the #43 guarantee).
// Each blend is the lowest-peak-curvature C1 ramp (two parabolas, see
// `bump`), sized so the curvature stays within CABLE_BEND_BUDGET / MBR.
//
// Issue #117: the channel is no longer a flat-bottomed box cut to one depth.
// It is SWEPT along that same drawn cable: every cross-section is a round
// bore of diameter d + tolerance around the cable's own centre, opening
// straight up to the face (a "U"). So its depth follows the cable's drop --
// zero where the cable's bottom reaches the face, full depth once it lies in
// the channel -- with no step and no square corners. Near the rim the
// opening narrows below the cable's diameter (`baseClipOpeningFraction`)
// for a short length: the cable snaps down into a C-shaped clip that lies
// along its own direction, and leaves the flange sideways through the rim
// along the same chord, with no extra bend (the old vertical rim keyhole
// needed a 90 degree turn). The clip sits where both lips are still inside
// the rim (`CABLE_CLIP_WALL` of flange beyond them), after the drop.
//
// The outer end (issue #241): the top cap's clips are gone (any clip beside
// the coil needed 6 to 8 mm of margin). Instead the cap and the base each
// get a rim slot (`layoutRimSlot`): a keyhole cut straight through the plate
// at the rim, which the cable is pressed into from the edge and passes
// through. The cap's sits where the cable's lead-out arrives under the cap,
// the base's right below it. The drawn cable doesn't go through the cap's
// slot: the top turn sits flush under the cap, so a cable pressed up into a
// slot right above its end bends tighter than its bend radius there (rising
// through the plate within it takes 10 to 20 mm along the cable). It runs
// level under the cap instead and curves gently out past the rim, right
// under the slot (`capTailPath`).
//
// If the flange margin is too narrow for the chord to hold the clip past
// the end of the drop, `requiredInnerEndMargin` says how wide it must be --
// flange.ts grows the margin to that (design.ts warns), so a real design
// never gets an impossible bend.

import {
  CABLE_BEND_BUDGET,
  CABLE_BRIDGE_STEP,
  CABLE_BASE_CLIP_INTERFERENCE,
  CABLE_BASE_CLIP_LAND,
  CABLE_BASE_CLIP_OPENING_MIN,
  CABLE_CLIP_DEPTH_SLACK,
  CABLE_CLIP_ENTRY,
  CABLE_CLIP_LENGTH_FACTOR,
  CABLE_CLIP_MIN_LENGTH,
  CABLE_CLIP_WALL,
  CABLE_CLIPPED_TAIL_FACTOR,
  CABLE_CLIPPED_TAIL_MIN,
  CABLE_SWEEP_ARC_SEGMENTS,
  CABLE_SWEEP_MAX_SAG,
  CABLE_SWEEP_STEP,
  CAP_CABLE_DROP,
  EDGE_CHAMFER,
  INNER_CHANNEL_DEPTH_FACTOR,
  INNER_CHANNEL_MIN_SHELF,
  INNER_CHANNEL_WALL_SKIN,
  MARGIN_BOTTOM,
  RIM_SLOT_NECK,
  RIM_SLOT_WALL_GAP,
  RIM_SLOT_SEAT_SEGMENTS,
} from "./constants";
import { offsetPerimeter, outlineOffsetAt, pointAt, sideLength } from "./shapes";
import type { ShapeOutline } from "./shapes";
import { grooveShape, grooveStartHeight } from "./wall";

/** Ideal channel recess depth for the given wire diameter (issue #8): roughly a full cable diameter, so the wound cable's first turn lies flush -- see INNER_CHANNEL_DEPTH_FACTOR's own doc comment. */
export function idealChannelDepth(wireDiameter: number): number {
  return INNER_CHANNEL_DEPTH_FACTOR * wireDiameter;
}

/**
 * The channel's ACTUAL recess depth (to the cable's bottom), given the
 * flange's own (already resolved) thickness: the ideal depth, capped to
 * whatever the flange's thickness leaves below a small shelf. design.ts
 * warns when this caps the channel (flange.ts normally provisions enough
 * thickness). Issue #122: the keyhole mount's pocket, on the OTHER face, sits
 * on its own pad, clear of the channel, so it reserves nothing here
 * (design.ts stacks the two depths into the thickness if their footprints
 * ever overlap). The round bore around the cable reaches tolerance/2 deeper
 * than this.
 */
export function resolveChannelDepth(wireDiameter: number, flangeThickness: number): number {
  return Math.min(idealChannelDepth(wireDiameter), Math.max(0, flangeThickness - INNER_CHANNEL_MIN_SHELF));
}

export interface XY {
  x: number;
  y: number;
}

export interface XYZ {
  x: number;
  y: number;
  z: number;
}

/**
 * A solid swept along the cable: one closed cross-section polygon (`rings`)
 * per station, all with the same vertex count and order, each in the
 * vertical plane across the cable at that station. Consecutive rings join
 * with straight edges; `start`/`end` are interior points of the first and
 * last ring, each end is capped by a fan from them. manifold.ts meshes it
 * (`sweepMesh`), step/build.ts lofts the same rings.
 */
export interface SweepSolid {
  rings: XYZ[][];
  start: XYZ;
  end: XYZ;
}

export interface InnerEndLayout {
  /** The channel/clip bore radius, (d + tolerance) / 2, mm. */
  channelRadius: number;
  /** The clip's opening width (narrower than the cable), mm. */
  clipOpening: number;
  /** The recessed channel + clip cutter, swept along the cable from where it first touches the flange face to past the rim. */
  channel: SweepSolid;
  /** The cable centre where the gripping lips start and end (the clip end nearer the rim is `to`). */
  clip: { from: XYZ; to: XYZ };
  /** Where the cable's centreline crosses the flange rim. */
  rimExit: XY;
  /** The channel's footprint on the flange face (a closed polygon, the bore's full width), which mount features must keep clear of. */
  channelRibbon: XY[];
  /** The drawn cable, from its free tail end past the rim, through the clip and the channel, to layer 1's first sample (`J`, the groove start): dense xyz samples. */
  leadIn: XYZ[];
  /** The narrowest flange margin that fits this lead-in within the bend radius, mm (flange.ts grows the margin to at least this). */
  requiredMargin: number;
  /** Set only when `margin` is narrower than `requiredMargin`: the lead-in then bends tighter than the cable allows. */
  warning?: string;
}

/** The clip bore's radius: the cable's own plus half the print tolerance. */
export function clipRadius(wireDiameter: number, tolerance: number): number {
  return (wireDiameter + tolerance) / 2;
}

/** How long the gripping lips are, along the cable (mm). */
export function clipLength(wireDiameter: number): number {
  return Math.max(CABLE_CLIP_MIN_LENGTH, CABLE_CLIP_LENGTH_FACTOR * wireDiameter);
}

/** A clipped cable end's free tail past the rim (mm). */
export function clippedTailLength(wireDiameter: number): number {
  return Math.max(CABLE_CLIPPED_TAIL_MIN, CABLE_CLIPPED_TAIL_FACTOR * wireDiameter);
}

/**
 * The base clip's opening, as a fraction of its bore diameter (d +
 * tolerance). The lips are rigid (stubs on a thick wall; PLA has no flex),
 * so all of the interference is taken by the cable pressing in: the cable's
 * own diameter less CABLE_BASE_CLIP_INTERFERENCE of it, but never under
 * CABLE_BASE_CLIP_OPENING_MIN of the bore (the 45 degree overhang limit).
 */
export function baseClipOpeningFraction(wireDiameter: number, tolerance: number): number {
  const opening = wireDiameter * (1 - CABLE_BASE_CLIP_INTERFERENCE);
  return Math.max(CABLE_BASE_CLIP_OPENING_MIN, opening / (wireDiameter + tolerance));
}

/**
 * The lips' half-opening at distance `s` along a clip spanning [from, to]:
 * `closed` inside it, `open` outside (the flange channel's plain "U" uses
 * the bore's full radius), tapering over CABLE_CLIP_ENTRY at each end.
 */
function lipHalf(s: number, from: number, to: number, closed: number, open: number): number {
  const entry = Math.min(CABLE_CLIP_ENTRY, (to - from) / 2);
  if (s <= from || s >= to) return open;
  const k = Math.min(1, (s - from) / entry, (to - s) / entry);
  return open + (closed - open) * k;
}

/** A bore slot: its half-width here, how far it runs, and the narrowest and widest half-widths it takes anywhere along its sweep. */
interface BoreSlot {
  half: number;
  to: number;
  range: [number, number];
  /** A lead-in funnel on each side: the slot's wall (`half` wide) turns outward at 45 degrees from height `z`, `rise` high up to half-width `reach`, then runs straight up to `to` at half-width `top`. */
  funnel?: { z: number; rise: number; reach: number; top: number };
}

/**
 * One cross-section of a round bore: a circle of radius `R` about `c`
 * (stretched vertically by `stretch`, so a sloped cable's bore is still
 * round perpendicular to the cable), with a slot of half-width `up.half`
 * straight up to z = `up.to`, and optionally one of `down.half` straight
 * down to z = `down.to`. `u` is the unit horizontal vector across the cable.
 * Star-shaped about `c`, so a fan from it caps it.
 *
 * Issue #219: every ring of a sweep puts its vertices at the same angles
 * around the circle, whatever its slots' widths: from where the narrowest
 * up slot meets the circle to where the narrowest down slot does (or the
 * bottom), with a break at each slot's widest foot too. A vertex inside a
 * slot sits on the slot's wall, level with its angle. So where a lip starts
 * (its two rings CABLE_CLIP_ENTRY apart), each vertex only moves straight
 * across, and the strips between the rings tile the lip's end face. (With
 * the angles spread over each ring's own arc, the vertices slid round the
 * circle there, and the strips folded back over themselves.)
 */
function boreRing(c: XYZ, u: XY, R: number, stretch: number, up: BoreSlot, down?: BoreSlot): XYZ[] {
  const at = (p: number, z: number): XYZ => ({ x: c.x + u.x * p, y: c.y + u.y * p, z });
  const foot = (half: number) => Math.asin(Math.min(1, half / R));
  /** The angles after `a` up to `b`, `n` equal steps (none if they meet), or ~11 degree steps if `n` is omitted. */
  const steps = (a: number, b: number, n = Math.ceil((b - a) / (Math.PI / CABLE_SWEEP_ARC_SEGMENTS) - 1e-9)) =>
    b - a > 1e-9 ? Array.from({ length: n }, (_, i) => a + ((b - a) * (i + 1)) / n) : [];
  const upTop = foot(up.range[0]);
  const upOpen = foot(up.range[1]);
  const downOpen = down ? Math.PI - foot(down.range[1]) : Math.PI;
  // One side, from the top down: the same counts as before #219 between the widest feet.
  const side = [upTop, ...steps(upTop, upOpen), ...steps(upOpen, downOpen, down ? CABLE_SWEEP_ARC_SEGMENTS : CABLE_SWEEP_ARC_SEGMENTS / 2), ...(down ? steps(downOpen, Math.PI - foot(down.range[0])) : [])];
  const point = (phi: number, sign: 1 | -1): XYZ => {
    const slot = Math.cos(phi) >= 0 ? up.half : (down?.half ?? 0);
    return at(sign * Math.max(R * Math.sin(phi), slot), c.z + R * Math.cos(phi) * stretch);
  };
  const f = up.funnel;
  const ring: XYZ[] = [at(f ? f.top : up.half, up.to), ...(f ? [at(f.reach, f.z + f.rise), at(up.half, f.z)] : []), ...side.map((phi) => point(phi, 1))];
  if (down) ring.push(at(down.half, down.to), at(-down.half, down.to));
  // The other side, back up (without the bottom twice when there's no down slot).
  ring.push(...(down ? side : side.slice(0, -1)).reverse().map((phi) => point(phi, -1)));
  if (f) ring.push(at(-up.half, f.z), at(-f.reach, f.z + f.rise));
  ring.push(at(-(f ? f.top : up.half), up.to));
  return ring;
}

/**
 * A closed, outward-facing triangle mesh of a sweep: quads between
 * consecutive rings (two triangles each), fans at both ends. Valid as long
 * as consecutive rings don't cross, which holds for any path bending far
 * more gently than the bore is wide (the cable's own bend radius is several
 * diameters).
 */
export function sweepMesh(sweep: SweepSolid): { positions: Float32Array; indices: Uint32Array } {
  const { rings, start, end } = sweep;
  const m = rings[0].length;
  const n = rings.length;
  const positions = new Float32Array((n * m + 2) * 3);
  rings.forEach((ring, i) => ring.forEach((p, j) => positions.set([p.x, p.y, p.z], (i * m + j) * 3)));
  const s = n * m;
  const e = n * m + 1;
  positions.set([start.x, start.y, start.z], s * 3);
  positions.set([end.x, end.y, end.z], e * 3);
  const tris: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    for (let j = 0; j < m; j++) {
      const a = i * m + j;
      const b = i * m + ((j + 1) % m);
      const c = a + m;
      const d = b + m;
      tris.push(a, b, d, a, d, c);
    }
  }
  for (let j = 0; j < m; j++) {
    tris.push(s, (j + 1) % m, j);
    tris.push(e, (n - 1) * m + j, (n - 1) * m + ((j + 1) % m));
  }
  // Orientation depends on the ring order and the sweep direction: flip to
  // outward-facing (positive signed volume) if needed.
  let volume = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t] * 3, tris[t + 1] * 3, tris[t + 2] * 3];
    const p = positions;
    volume += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  if (volume < 0) {
    for (let t = 0; t < tris.length; t += 3) [tris[t + 1], tris[t + 2]] = [tris[t + 2], tris[t + 1]];
  }
  return { positions, indices: new Uint32Array(tris) };
}

/**
 * The lowest-peak-curvature C1 ramp from 0 to `H` over [0, L] (two
 * parabolas: second derivative +A then -A), starting with slope `v0` and
 * ending flat. Solving value(L) = H with slope(L) = 0 for A gives
 * A^2 L^2 + (2 v0 L - 4H) A - v0^2 = 0 (positive root); with v0 = 0 this is
 * the familiar A = 4H/L^2.
 */
export function bump(H: number, v0: number, L: number): { A: number; value(s: number): number } {
  if (H < 0) {
    const m = bump(-H, -v0, L);
    return { A: m.A, value: (s) => -m.value(s) };
  }
  if (L <= 1e-9) return { A: Infinity, value: () => H };
  const b = 2 * v0 * L - 4 * H;
  const A = Math.max(1e-12, (-b + Math.sqrt(b * b + 4 * L * L * v0 * v0)) / (2 * L * L));
  const u = Math.max(0, Math.min(L, (L - v0 / A) / 2));
  const gu = v0 * u + (A * u * u) / 2;
  const vu = v0 + A * u;
  return {
    A,
    value: (s) => {
      if (s <= 0) return 0;
      if (s >= L) return H;
      if (s <= u) return v0 * s + (A * s * s) / 2;
      const w = s - u;
      return gu + vu * w - (A * w * w) / 2;
    },
  };
}

/** Smallest s in [lo, hi] where the (monotone increasing) `value` reaches `target`. */
function invert(value: (s: number) => number, target: number, lo: number, hi: number): number {
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (value(mid) < target) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Smallest s >= `from` where the (increasing) `value` reaches `target`, growing the search range as needed. */
function reach(value: (s: number) => number, target: number, from: number): number {
  let hi = from + 1;
  while (value(hi) < target && hi < 1e5) hi = from + (hi - from) * 2;
  return invert(value, target, from, hi);
}

interface LeadInRoute {
  /** The cable's centre at chord distance `s` back from the groove start. */
  at(s: number): XYZ;
  /** Where the drop into the channel starts: before it, the cable shifts clear of the wall on the face. */
  dropStart: number;
  /** Where the drop into the channel ends (the cable is at channel height from here on). */
  dropLength: number;
  /** The chord's own gentle outward bend (planLeadIn's `curve`), 1/mm. */
  curve: number;
  /** Where the cable is within CABLE_CLIP_DEPTH_SLACK of channel height -- the clip's lips may start here. */
  settled: number;
  /** A point on the (fully side-shifted) chord at distance `s` -- for s >= the end of the side shift this IS `at(s)`'s xy. */
  chordAt(s: number): XY;
}

/**
 * The lead-in's shape, independent of the flange margin: the chord from the
 * groove start J backwards along the helix tangent, with the drop and the
 * side shift blended in (see the file header). `curve` (1/mm) bends the
 * whole chord gently outward, `curve * s^2 / 2` at distance s, so on a
 * square or triangle it can reach the rim part-way along the flat side
 * instead of running on into the next corner (see `layoutInnerEnd`); it
 * spends that much of the curvature budget. `forcedDrop` squeezes the drop
 * into a shorter length (only for a margin too narrow to fit it -- the
 * curvature budget is then exceeded, and `layoutInnerEnd` warns).
 */
function planLeadIn(
  outline: ShapeOutline,
  wireDiameter: number,
  tolerance: number,
  bendRadius: number,
  channelDepth: number,
  { forcedDrop, curve = 0 }: { forcedDrop?: number; curve?: number } = {},
): LeadInRoute {
  const d = wireDiameter;
  const groove = grooveShape(d);
  const o1 = d / 2 - groove.depth; // layer 1's radial offset (capacity.ts)
  const { pitch } = groove;
  const zStart = grooveStartHeight(groove, MARGIN_BOTTOM);

  const j = pointAt(outline, 0, o1);
  const EPS = 1e-6;
  const ahead = pointAt(outline, EPS, o1);
  const txRaw = ahead.x - j.x;
  const tyRaw = ahead.y - j.y;
  const speed = Math.hypot(txRaw, tyRaw) / EPS; // xy mm per unit of phi, at J
  const tx = txRaw / (speed * EPS);
  const ty = tyRaw / (speed * EPS);
  const nx = j.nx;
  const ny = j.ny;
  // Layer 1 climbs `pitch` per unit of phi (wire.ts), so going BACK along
  // the chord its z falls at this slope per mm.
  const helixSlope = pitch / speed;

  const zChannel = -channelDepth + d / 2; // cable resting on the channel floor
  const drop = zStart - zChannel;
  const needSide = (d + tolerance) / 2 + INNER_CHANNEL_WALL_SKIN;
  const lineOffset = (s: number) => outlineOffsetAt(outline, j.x - s * tx, j.y - s * ty).offset;
  // The first turn starts on the face (its bottom just above it), so the cable
  // can't drop while it is still beside the wall. While it shifts sideways
  // until the channel sits a skin clear of the wall, its drop eases off from
  // the helix's slope (at most to level with the channel's bore on the face); only
  // then does it drop into the channel. `b` is the curvature each part may
  // use (with the chord's own bend, `curve`).
  const plan = (b: number) => {
    const ease = zStart - (d + tolerance) / 2; // until the channel's bore just touches the face
    const easeA = Math.min(ease > 1e-9 ? (helixSlope * helixSlope) / (2 * ease) : Infinity, b / 2);
    const easeLength = helixSlope / easeA;
    const lateralA = Math.sqrt(Math.max(0, b * b - easeA * easeA)) - curve;
    const dropA = Math.sqrt(Math.max(0, b * b - curve * curve));
    if (lateralA <= 0 || dropA <= 0) return undefined;
    // The shortest shift that is long enough for its own side step (the
    // chord drifts outward on its own, so a longer shift needs less step).
    const sideAt = (s: number) => Math.max(0, needSide - lineOffset(s) - (curve * s * s) / 2);
    const longEnough = (s: number) => Math.sqrt((4 * sideAt(s)) / lateralA) <= s;
    const shiftEnd = longEnough(0) ? 0 : invert((s) => (longEnough(s) ? 1 : 0), 1, 0, Math.sqrt((4 * needSide) / lateralA));
    const side = sideAt(shiftEnd);
    const lateralLength = shiftEnd;
    const easing = Math.min(shiftEnd, easeLength);
    const eased = helixSlope * easing - (easeA * easing * easing) / 2;
    const slope = helixSlope - easeA * easing;
    const rest = Math.max(0, drop - eased);
    let dropLength = 1;
    while (bump(rest, slope, dropLength).A > dropA && dropLength < 1e5) dropLength *= 2;
    let lo = 0;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + dropLength) / 2;
      if (bump(rest, slope, mid).A > dropA) lo = mid;
      else dropLength = mid;
    }
    const tail = bump(rest, slope, dropLength);
    const fall = (s: number) => (s <= easing ? helixSlope * s - (easeA * s * s) / 2 : s <= shiftEnd ? eased : eased + tail.value(s - shiftEnd));
    return { fall, side, lateral: bump(side, 0, lateralLength), lateralLength, shiftEnd, length: shiftEnd + dropLength };
  };

  const budget = CABLE_BEND_BUDGET / bendRadius;
  let route = plan(budget);
  if (forcedDrop !== undefined || !route) {
    // Squeezed into `forcedDrop` (a margin too narrow for it), or a chord bent
    // past what the budget allows: spend more curvature until it fits.
    const target = forcedDrop ?? Infinity;
    let lo = budget;
    let hi = budget * 2;
    const fits = (b: number) => {
      const r = plan(b);
      return r !== undefined && r.length <= target;
    };
    while (!fits(hi) && hi < 1e3) hi *= 2;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    route = plan(hi)!;
  }
  const { fall, side, lateral, lateralLength, shiftEnd, length } = route;

  const bend = (s: number) => (curve * s * s) / 2;
  const chordAt = (s: number): XY => ({ x: j.x - s * tx + (side + bend(s)) * nx, y: j.y - s * ty + (side + bend(s)) * ny });
  return {
    dropStart: shiftEnd,
    dropLength: length,
    curve,
    // The lips start no later than this, and no earlier than a clip's length before the drop ends, so the clip's
    // rim end is always level.
    settled: Math.max(drop <= CABLE_CLIP_DEPTH_SLACK ? 0 : invert(fall, drop - CABLE_CLIP_DEPTH_SLACK, 0, length), length - clipLength(d)),
    chordAt,
    at: (s) => {
      const shift = (side > 0 ? lateral.value(Math.min(s, lateralLength)) : 0) + bend(s);
      return { x: j.x - s * tx + shift * nx, y: j.y - s * ty + shift * ny, z: zStart - fall(Math.min(s, length)) };
    },
  };
}

/** Offset (outside the core's own outline) of the chord at distance `s`. */
function chordOffset(outline: ShapeOutline, route: LeadInRoute, s: number): number {
  const p = route.chordAt(s);
  return outlineOffsetAt(outline, p.x, p.y).offset;
}

/**
 * The lead-in bent (planLeadIn's `curve`) just enough that the clip's rim
 * end reaches its limit (`limit`, the largest centre offset that still keeps
 * the outer lip inside the rim) at distance `target` along it -- or at the
 * end of the drop plus the clip, if the bend's own share of the curvature
 * budget pushes that further. Undefined when that never settles (the caller
 * keeps the straight chord).
 */
function bendToRim(
  outline: ShapeOutline,
  wireDiameter: number,
  tolerance: number,
  bendRadius: number,
  channelDepth: number,
  limit: number,
  target: number,
  clipLen: number,
): { route: LeadInRoute; clipEnd: number } | undefined {
  const maxCurve = (0.8 * CABLE_BEND_BUDGET) / bendRadius;
  let at = target;
  for (let pass = 0; pass < 8; pass++) {
    // The smallest bend that puts the rim at `at`.
    // (A wide flange -- a through-hole mount's -- can be out of reach by
    // then even at the largest bend: the clip then stops short of the
    // rim, with a longer plain channel out to it.)
    let lo = 0;
    let hi = maxCurve;
    if (chordOffset(outline, planLeadIn(outline, wireDiameter, tolerance, bendRadius, channelDepth, { curve: hi }), at) < limit) lo = hi;
    for (let i = 0; i < 40 && lo < hi; i++) {
      const mid = (lo + hi) / 2;
      if (chordOffset(outline, planLeadIn(outline, wireDiameter, tolerance, bendRadius, channelDepth, { curve: mid }), at) < limit) lo = mid;
      else hi = mid;
    }
    const route = planLeadIn(outline, wireDiameter, tolerance, bendRadius, channelDepth, { curve: lo });
    if (route.settled + clipLen <= at + 1e-6) return { route, clipEnd: at };
    at = route.settled + clipLen;
  }
  return undefined;
}

/** The largest offset of the clip's centre that still leaves CABLE_CLIP_WALL of flange outside its outer lip. */
function clipLimit(margin: number, R: number): number {
  return margin - R - CABLE_CLIP_WALL;
}

/**
 * The narrowest flange margin whose rim can hold the clip on the chord past
 * the end of the drop (so the whole lead-in stays within the bend radius).
 * Cheap and margin-independent, so flange.ts (and through it the solver's
 * search) can call it for every candidate.
 */
export function requiredInnerEndMargin(outline: ShapeOutline, wireDiameter: number, tolerance: number, bendRadius: number, channelDepth = idealChannelDepth(wireDiameter)): number {
  const route = planLeadIn(outline, wireDiameter, tolerance, bendRadius, channelDepth);
  return chordOffset(outline, route, route.settled + clipLength(wireDiameter)) + clipRadius(wireDiameter, tolerance) + CABLE_CLIP_WALL;
}

/** Stations `step` apart over [from, to], plus every `extra` point inside it, sorted. */
function stationsOver(from: number, to: number, step: number, extra: number[]): number[] {
  const count = Math.max(1, Math.ceil((to - from) / step));
  const all = [...Array.from({ length: count + 1 }, (_, i) => from + ((to - from) * i) / count), ...extra.filter((s) => s > from + 1e-3 && s < to - 1e-3)];
  all.sort((a, b) => a - b);
  return all.filter((s, i) => i === 0 || s - all[i - 1] > 1e-3);
}

/**
 * Lay out the bottom-flange channel + clip and the drawn lead-in.
 * `outline`/`margin` mirror manifold.ts's `FlangeSpec.outline`/`.margin`
 * exactly, so every backend derives the identical layout from identical
 * inputs -- same convention as mount.ts's `layoutKeyholeMount`.
 */
export function layoutInnerEnd(
  outline: ShapeOutline,
  margin: number,
  wireDiameter: number,
  tolerance: number,
  bendRadius: number,
  channelDepth = idealChannelDepth(wireDiameter),
): InnerEndLayout {
  const R = clipRadius(wireDiameter, tolerance);
  const clipLen = clipLength(wireDiameter);
  const closed = baseClipOpeningFraction(wireDiameter, tolerance) * R;

  let route = planLeadIn(outline, wireDiameter, tolerance, bendRadius, channelDepth);
  const minClipEnd = route.settled + clipLen;
  const limit = clipLimit(margin, R);
  const requiredMargin = chordOffset(outline, route, minClipEnd) + R + CABLE_CLIP_WALL;

  // The clip goes as far out along the chord as the rim allows, and never
  // starts before the drop has (all but CABLE_CLIP_DEPTH_SLACK) ended. Offset only grows along the chord (it's
  // tangent to a convex outline), so bisection finds it.
  const findClipEnd = (lo: number, hi: number) => {
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (chordOffset(outline, route, mid) <= limit) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  let clipEnd: number;
  let clipFrom: number;
  let warning: string | undefined;
  if (chordOffset(outline, route, minClipEnd) <= limit + 1e-6) {
    let hi = minClipEnd * 2 + 10;
    while (chordOffset(outline, route, hi) <= limit && hi < 1e5) hi *= 2;
    clipEnd = findClipEnd(minClipEnd, hi);
    // A square or triangle's straight chord runs along the flat side that
    // ends at the groove start and only meets the rim past the NEXT corner
    // -- right where a through-hole mount puts that corner's screw hole.
    // Bend it gently outward instead, so it reaches the rim by the flat
    // side's middle (or the end of the drop and clip, if that's further).
    const halfFlat = sideLength(outline) / 2;
    if (halfFlat > 1e-6 && clipEnd > halfFlat) {
      const bent = bendToRim(outline, wireDiameter, tolerance, bendRadius, channelDepth, limit, halfFlat, clipLen);
      if (bent) ({ route, clipEnd } = bent);
    }
    clipFrom = clipEnd - clipLen;
  } else {
    // Too narrow: squeeze the drop into what the rim leaves (bending the
    // cable tighter than it allows) and say so. design() never gets here --
    // flange.ts grows the margin to `requiredMargin` first.
    clipEnd = findClipEnd(0, minClipEnd);
    clipFrom = Math.max(clipEnd - clipLen, clipEnd / 2);
    route = planLeadIn(outline, wireDiameter, tolerance, bendRadius, channelDepth, { forcedDrop: clipFrom });
    warning = `The ${margin.toFixed(1)} mm flange margin is too narrow for the inner cable end to reach the groove within its ${bendRadius.toFixed(1)} mm bend radius; it needs at least ${requiredMargin.toFixed(1)} mm.`;
  }

  // Past the clip the cable bends gently outward with what's left of its
  // bend budget (a chord along a square's or triangle's flat side would
  // otherwise meet the rim at a grazing angle, leaving a long knife-edge
  // sliver of rim beside the channel), and past the rim it goes straight on.
  const H = 0.01;
  const clipEndAt = route.at(clipEnd);
  const outward = outlineOffsetAt(outline, clipEndAt.x, clipEndAt.y);
  const exitCurve = Math.max(0, (0.8 * CABLE_BEND_BUDGET) / bendRadius - route.curve);
  const bent = (s: number): XYZ => {
    const p = route.at(s);
    const k = s <= clipEnd ? 0 : (exitCurve * (s - clipEnd) ** 2) / 2;
    return { x: p.x + outward.nx * k, y: p.y + outward.ny * k, z: p.z };
  };
  const sRim = reach((s) => {
    const p = bent(s);
    return outlineOffsetAt(outline, p.x, p.y).offset;
  }, margin, clipEnd);
  const atRim = bent(sRim);
  const beforeRim = bent(sRim - H);
  const out = { x: (atRim.x - beforeRim.x) / Math.hypot(atRim.x - beforeRim.x, atRim.y - beforeRim.y), y: (atRim.y - beforeRim.y) / Math.hypot(atRim.x - beforeRim.x, atRim.y - beforeRim.y) };
  const path = (s: number): XYZ => (s <= sRim ? bent(s) : { x: atRim.x + out.x * (s - sRim), y: atRim.y + out.y * (s - sRim), z: atRim.z });
  const sEnd = reach((s) => {
    const p = path(s);
    return outlineOffsetAt(outline, p.x, p.y).offset;
  }, margin + R + 0.5, sRim); // the whole bore is past the rim

  // The bore's cross-section at chord distance s: round about the cable,
  // stretched by the local slope, open straight up (a "U") except where the
  // lips grip.
  const frame = (s: number) => {
    const a = path(Math.max(0, s - H));
    const b = path(s + H);
    const plan = Math.hypot(b.x - a.x, b.y - a.y);
    return { c: path(s), u: { x: -(b.y - a.y) / plan, y: (b.x - a.x) / plan }, stretch: Math.hypot(1, (b.z - a.z) / plan) };
  };
  const bottom = (s: number) => {
    const f = frame(s);
    return f.c.z - R * f.stretch;
  };
  // It starts where the bore's bottom is still a little above the face (so
  // the cut begins at zero depth), but not beside the wall: while the cable
  // shifts clear of it, the bore only touches the face. It ends with the
  // whole bore past the rim.
  const from = route.dropStart;
  const sStart = bottom(from) <= 0.3 ? from : invert((s) => -bottom(s), -0.3, from, route.dropLength);
  const sweepStep = Math.min(CABLE_SWEEP_STEP, Math.sqrt(8 * CABLE_SWEEP_MAX_SAG * bendRadius));
  const stations = stationsOver(sStart, sEnd, sweepStep, [clipFrom, clipFrom + CABLE_CLIP_ENTRY, clipEnd - CABLE_CLIP_ENTRY, clipEnd]);
  // The lips' mouth is a 45 degree funnel: from CABLE_BASE_CLIP_LAND above
  // the edge where the opening meets the bore, the wall flares out until it
  // meets the plain channel's wall (half-width R), and runs up from there.
  // Outside the clip the flare is a hairline on that wall (so no two
  // vertices of a ring coincide).
  const rings = stations.map((s) => {
    const { c, u, stretch } = frame(s);
    const half = lipHalf(s, clipFrom, clipEnd, closed, R);
    const to = Math.max(c.z + R * stretch, 0) + 1;
    const z = c.z + Math.sqrt(R * R - closed * closed) * stretch + CABLE_BASE_CLIP_LAND;
    const rise = Math.max(R - half, CABLE_CLIP_ENTRY);
    return boreRing(c, u, R, stretch, { half, to, range: [closed, R], funnel: { z, rise, reach: Math.min(R, half + rise), top: R } });
  });
  const channel: SweepSolid = { rings, start: path(sStart), end: path(sEnd) };

  // Its footprint on the face: the bore's full width, wherever it cuts.
  const cutting = stations.filter((s) => bottom(s) < 0);
  const rail = (sign: 1 | -1) =>
    cutting.map((s) => {
      const { c, u } = frame(s);
      return { x: c.x + sign * u.x * R, y: c.y + sign * u.y * R };
    });
  const channelRibbon: XY[] = cutting.length >= 2 ? [...rail(1), ...rail(-1).reverse()] : [];

  const sTail = sRim + clippedTailLength(wireDiameter);
  const steps = Math.max(2, Math.ceil(sTail / CABLE_BRIDGE_STEP));
  const leadIn: XYZ[] = Array.from({ length: steps + 1 }, (_, i) => path(sTail * (1 - i / steps)));

  return {
    channelRadius: R,
    clipOpening: 2 * closed,
    channel,
    clip: { from: route.at(clipFrom), to: route.at(clipEnd) },
    rimExit: { x: atRim.x, y: atRim.y },
    channelRibbon,
    leadIn,
    requiredMargin,
    warning,
  };
}


// --- The top cap's cable end, and the rim cable slots (issue #241) ----------

/** The cable's centre height at the cap end, relative to the cap plate's underside: its top a hair (CAP_CABLE_DROP) below it. */
export function capCableZ(wireDiameter: number): number {
  return -wireDiameter / 2 - CAP_CABLE_DROP;
}

/**
 * The cap end's plan-view path (issue #241): from where the cable's lead-out
 * arrives level under the cap (outline parameter `u0`, offset `offset`,
 * running along the outline), it curves gently (a fraction of its bend
 * budget) outward and leaves past the rim, with a free tail beyond it. It
 * runs under the cap's rim slot; pressing it up into the slot is the user's
 * last step (see the file header).
 */
export function capTailPath(outline: ShapeOutline, margin: number, offset: number, wireDiameter: number, bendRadius: number, u0: number): XY[] {
  const p = pointAt(outline, u0, offset);
  const q = pointAt(outline, u0 + 1e-6, offset);
  const l = Math.hypot(q.x - p.x, q.y - p.y);
  const tan = { x: (q.x - p.x) / l, y: (q.y - p.y) / l };
  const curve = (0.8 * CABLE_BEND_BUDGET) / bendRadius;
  const exit = (s: number): XY => ({
    x: p.x + tan.x * s + p.nx * ((curve * s * s) / 2),
    y: p.y + tan.y * s + p.ny * ((curve * s * s) / 2),
  });
  const sRim = reach((s) => {
    const e = exit(s);
    return outlineOffsetAt(outline, e.x, e.y).offset;
  }, margin, 0);
  const sOut = sRim + clippedTailLength(wireDiameter);
  const steps = Math.max(2, Math.ceil(sOut / CABLE_BRIDGE_STEP));
  // Past the rim the free tail runs straight on (the curve never keeps turning
  // until the tail points back round the axis, which a small bend radius allows).
  const atRim = exit(sRim);
  const heading = { x: tan.x + p.nx * curve * sRim, y: tan.y + p.ny * curve * sRim };
  const along = Math.hypot(heading.x, heading.y);
  const tailPoint = (s: number): XY =>
    s <= sRim ? exit(s) : { x: atRim.x + (heading.x / along) * (s - sRim), y: atRim.y + (heading.y / along) * (s - sRim) };
  return Array.from({ length: steps + 1 }, (_, i) => tailPoint((sOut * i) / steps));
}

/**
 * A rim cable slot (issue #241): a keyhole cut straight through the plate (the
 * base flange or the top cap) at its rim. A round seat the cable passes
 * through, a straight neck out to the rim a little narrower than the cable,
 * and a 45 degree lead-in at the mouth, so the cable is pressed in from the
 * edge. The plate beside the neck is rigid (PLA doesn't flex), so the cable's
 * jacket takes the squeeze: the same CABLE_BASE_CLIP_INTERFERENCE as the base
 * clip. The seat is a print tolerance wider than the cable, so it holds the
 * cable without clamping it; a connector behind it stops it pulling through.
 * Its walls are vertical, so it needs no support either way up. The slot runs
 * straight in along the rim's normal: the coil lies inboard of the seat, so
 * its pull on the cable draws it away from the neck.
 */
export interface RimSlot {
  /** The cut in plan: a closed, counter-clockwise polygon reaching past the rim. */
  outline: XY[];
  /** The seat's centre, where the cable passes through the plate. */
  seat: XY;
  /** The unit vector along the slot, from the seat out through the mouth. */
  axis: XY;
}

/** The seat's radius, the neck's half-width, and where (along the slot, from the seat's centre) the neck starts and ends. */
function rimSlotSection(wireDiameter: number, tolerance: number) {
  const R = clipRadius(wireDiameter, tolerance);
  const neck = (wireDiameter * (1 - CABLE_BASE_CLIP_INTERFERENCE)) / 2;
  const neckStart = Math.sqrt(R * R - neck * neck);
  return { R, neck, neckStart, neckEnd: neckStart + RIM_SLOT_NECK };
}

/** The rim slot's seat width and neck width, mm (narrower than the cable). */
export function rimSlotWidths(wireDiameter: number, tolerance: number): { seat: number; neck: number } {
  const { R, neck } = rimSlotSection(wireDiameter, tolerance);
  return { seat: 2 * R, neck: 2 * neck };
}

/** The seat centre's offset outside the core's outline: as far out as the rim allows, the neck ending at the foot of the rim chamfer (so it keeps the plate's full thickness). */
export function rimSlotSeatOffset(margin: number, wireDiameter: number, tolerance: number): number {
  return margin - EDGE_CHAMFER - rimSlotSection(wireDiameter, tolerance).neckEnd;
}

/** The narrowest margin whose base slot keeps RIM_SLOT_WALL_GAP of flange between its seat and the wall. */
export function requiredRimSlotMargin(wireDiameter: number, tolerance: number): number {
  const { R, neckEnd } = rimSlotSection(wireDiameter, tolerance);
  return RIM_SLOT_WALL_GAP + R + neckEnd + EDGE_CHAMFER;
}

/** The slot with its seat at outline parameter `u`. */
function rimSlotAt(outline: ShapeOutline, margin: number, wireDiameter: number, tolerance: number, u: number): RimSlot {
  const { R, neck, neckStart, neckEnd } = rimSlotSection(wireDiameter, tolerance);
  const c = pointAt(outline, u, rimSlotSeatOffset(margin, wireDiameter, tolerance));
  const a = { x: c.nx, y: c.ny };
  // Past the rim, with the lead-in's 45 degree walls well out of the plate too.
  const far = reach((s) => outlineOffsetAt(outline, c.x + a.x * s, c.y + a.y * s).offset, margin, 0) + 1;
  const at = (along: number, across: number): XY => ({ x: c.x + a.x * along - a.y * across, y: c.y + a.y * along + a.x * across });
  const start = Math.atan2(neck, neckStart);
  const arcSteps = Math.ceil(((2 * Math.PI - 2 * start) / (2 * Math.PI)) * RIM_SLOT_SEAT_SEGMENTS);
  const arc = Array.from({ length: arcSteps + 1 }, (_, i) => {
    const phi = start + ((2 * Math.PI - 2 * start) * i) / arcSteps;
    return at(R * Math.cos(phi), R * Math.sin(phi));
  });
  const flare = neck + far - neckEnd;
  return { outline: [at(far, flare), at(neckEnd, neck), ...arc, at(neckEnd, -neck), at(far, -flare)], seat: { x: c.x, y: c.y }, axis: a };
}

/** Whether `p` lies inside the closed polygon `poly`. */
function inside(p: XY, poly: XY[]): boolean {
  let odd = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, b] = [poly[i], poly[j]];
    if (a.y > p.y !== b.y > p.y && p.x < a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y)) odd = !odd;
  }
  return odd;
}

/** Distance from `p` to the closed polygon `poly`'s edges. */
function edgeDistance(p: XY, poly: XY[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, b] = [poly[j], poly[i]];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

/**
 * Lay out a rim slot as near outline parameter `u0` as it fits: half a
 * millimetre at a time either way round the rim, the first position whose
 * cut (inside the rim) keeps `clearance` from every `keepOut` polygon and
 * has none of them inside it. Undefined when no position around the rim
 * fits. `outline`/`margin` are the plate's (the flange's) own, so every
 * backend cuts the same slot.
 */
export function layoutRimSlot(outline: ShapeOutline, margin: number, wireDiameter: number, tolerance: number, u0: number, keepOut: XY[][] = [], clearance = 0): RimSlot | undefined {
  const du = 0.5 / offsetPerimeter(outline, Math.max(0, rimSlotSeatOffset(margin, wireDiameter, tolerance)));
  const fits = (slot: RimSlot) => {
    // The cut's edges, sampled finely, where they're inside the plate.
    const samples = slot.outline.flatMap((a, i) => {
      const b = slot.outline[(i + 1) % slot.outline.length];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.25));
      return Array.from({ length: n }, (_, k) => ({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n }));
    });
    const cut = samples.filter((p) => outlineOffsetAt(outline, p.x, p.y).offset <= margin);
    return keepOut.every((poly) => cut.every((p) => !inside(p, poly) && edgeDistance(p, poly) >= clearance) && poly.every((q) => outlineOffsetAt(outline, q.x, q.y).offset > margin || !inside(q, slot.outline)));
  };
  for (let k = 0; k * du <= 0.5; k++) {
    for (const u of k === 0 ? [u0] : [u0 + k * du, u0 - k * du]) {
      const slot = rimSlotAt(outline, margin, wireDiameter, tolerance, u);
      if (fits(slot)) return slot;
    }
  }
  return undefined;
}
