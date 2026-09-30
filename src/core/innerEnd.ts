// Cable fix points (issues #8, #115, #117, docs/research.md "Wire ends"):
// the bottom flange's recessed channel + clip for the inner cable end, and
// the top cap's clip for the outer end. Pure geometry math only -- no
// manifold-3d, no replicad -- shared by the mesh backend (manifold.ts), the
// STEP backend (step/build.ts) AND the drawn cable (wire.ts, design.ts), the
// same "one shared layout, several consumers" principle as mount.ts's
// `layoutKeyholeMount`: all of them build from the SAME cross-section rings.
//
// Issue #115: the cable must never bend tighter than its minimum bend
// radius (MBR). The cable leaves the groove start (layer 1's first sample,
// `J`) along the helix's OWN tangent, backwards, as a straight chord across
// the flange margin -- a cable at its MBR can follow a straight line. Two
// gentle, curvature-limited blends ride on that chord:
//   - z: the cable drops from the helix start height (`zStart`, a few mm
//     above the flange face) into the recessed channel (cable top flush
//     with the face, the #43 guarantee), and
//   - sideways (`N`, the outward normal at t=0): the channel sits a skin
//     clear of the wall, so the cable lies in a full-width trench.
// Each blend is the lowest-peak-curvature C1 ramp (two parabolas, see
// `bump`), sized so the combined curvature stays within CABLE_BEND_BUDGET /
// MBR.
//
// Issue #117: the channel is no longer a flat-bottomed box cut to one depth.
// It is SWEPT along that same drawn cable: every cross-section is a round
// bore of diameter d + tolerance around the cable's own centre, opening
// straight up to the face (a "U"). So its depth follows the cable's drop --
// zero where the cable's bottom reaches the face, full depth once it lies in
// the channel -- with no step and no square corners. Near the rim the
// opening narrows below the cable's diameter (CABLE_CLIP_OPENING_FRACTION)
// for a short length: the cable snaps down into a C-shaped clip that lies
// along its own direction, and leaves the flange sideways through the rim
// along the same chord, with no extra bend (the old vertical rim keyhole
// needed a 90 degree turn). The clip sits where both lips are still inside
// the rim (`CABLE_CLIP_WALL` of flange beyond them), after the drop.
//
// The cap end (`layoutCapClip`) is the same clip turned upside down: the
// cable arrives level just under the cap, follows the outline for the
// clip's length, then curves gently out past the rim. The cap is only 3 mm
// thick, too thin to recess a cable into, so its clip is a short block
// hanging under the plate with the bore through it and the opening facing
// down (up, in the cap's flipped print orientation). The block sits between
// the wound cable and the rim, so the flange (and cap) margin grows to fit
// it (`requiredCapClipMargin`). Issue #121: the block's root is chamfered at
// 45 degrees on all sides (a pyramid-like base, strong across the layer
// lines), it sits as close to the coil as the wound cable allows, and the
// same clip repeats every 1/n of the way around the cap.
//
// If the flange margin is too narrow for the chord to hold the clip past
// the end of the drop, `requiredInnerEndMargin` says how wide it must be --
// flange.ts grows the margin to that (design.ts warns), so a real design
// never gets an impossible bend.

import {
  CABLE_BEND_BUDGET,
  CABLE_BRIDGE_STEP,
  CABLE_CLIP_DEPTH_SLACK,
  CABLE_CLIP_ENTRY,
  CABLE_CLIP_LENGTH_FACTOR,
  CABLE_CLIP_MIN_LENGTH,
  CABLE_CLIP_OPENING_FRACTION,
  CABLE_CLIP_WALL,
  CABLE_CLIPPED_TAIL_FACTOR,
  CABLE_CLIPPED_TAIL_MIN,
  CABLE_SWEEP_ARC_SEGMENTS,
  CABLE_SWEEP_STEP,
  CAP_CABLE_DROP,
  CAP_CLIP_CHAMFER,
  CAP_CLIP_COIL_GAP,
  CAP_CLIP_LIP,
  CAP_CLIP_RELIEF,
  CAP_CLIP_RIM_INSET,
  CLEARANCE,
  GROOVE_DEPTH_FACTOR,
  INNER_CHANNEL_DEPTH_FACTOR,
  INNER_CHANNEL_MIN_SHELF,
  INNER_CHANNEL_WALL_SKIN,
  MARGIN,
} from "./constants";
import { outlineOffsetAt, pointAt, sideLength } from "./shapes";
import type { ShapeOutline } from "./shapes";
import { grooveStartHeight } from "./wall";

/** Ideal channel recess depth for the given wire diameter (issue #8): roughly a full cable diameter, so the wound cable's first turn lies flush -- see INNER_CHANNEL_DEPTH_FACTOR's own doc comment. */
export function idealChannelDepth(wireDiameter: number): number {
  return INNER_CHANNEL_DEPTH_FACTOR * wireDiameter;
}

/**
 * The channel's ACTUAL recess depth (to the cable's bottom), given the
 * flange's own (already resolved) thickness: the ideal depth, capped to
 * whatever the flange's thickness leaves below a small shelf. design.ts
 * warns when this caps the channel (flange.ts normally provisions enough
 * thickness). Issue #122: a mount's pocket/counterbore on the OTHER face sits
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
 * The lips' half-opening at distance `s` along a clip spanning [from, to]:
 * the bore's full radius outside it (no lips), CABLE_CLIP_OPENING_FRACTION
 * of it inside, tapering over CABLE_CLIP_ENTRY at each end. `open` is the
 * value used outside the clip (the flange channel's plain "U" uses the full
 * radius; the cap bore keeps a sliver of lip, see `layoutCapClip`).
 */
function lipHalf(s: number, from: number, to: number, R: number, open = R): number {
  const closed = CABLE_CLIP_OPENING_FRACTION * R;
  const entry = Math.min(CABLE_CLIP_ENTRY, (to - from) / 2);
  if (s <= from || s >= to) return open;
  const k = Math.min(1, (s - from) / entry, (to - s) / entry);
  return open + (closed - open) * k;
}

/**
 * One cross-section of a round bore: a circle of radius `R` about `c`
 * (stretched vertically by `stretch`, so a sloped cable's bore is still
 * round perpendicular to the cable), with a slot of half-width `up.half`
 * straight up to z = `up.to`, and optionally one of `down.half` straight
 * down to z = `down.to`. `u` is the unit horizontal vector across the cable.
 * Star-shaped about `c`, so a fan from it caps it.
 */
function boreRing(c: XYZ, u: XY, R: number, stretch: number, up: { half: number; to: number }, down?: { half: number; to: number }): XYZ[] {
  const at = (p: number, z: number): XYZ => ({ x: c.x + u.x * p, y: c.y + u.y * p, z });
  const circle = (phi: number) => at(R * Math.sin(phi), c.z + R * Math.cos(phi) * stretch);
  const arc = (a: number, b: number) => Array.from({ length: CABLE_SWEEP_ARC_SEGMENTS + 1 }, (_, i) => circle(a + ((b - a) * i) / CABLE_SWEEP_ARC_SEGMENTS));
  const phiUp = Math.asin(Math.min(1, up.half / R));
  const ring: XYZ[] = [at(up.half, up.to)];
  if (down) {
    const phiDown = Math.PI - Math.asin(Math.min(1, down.half / R));
    ring.push(...arc(phiUp, phiDown), at(down.half, down.to), at(-down.half, down.to), ...arc(2 * Math.PI - phiDown, 2 * Math.PI - phiUp));
  } else {
    ring.push(...arc(phiUp, 2 * Math.PI - phiUp));
  }
  ring.push(at(-up.half, up.to));
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
  const grooveDepth = GROOVE_DEPTH_FACTOR * d;
  const o1 = d / 2 - grooveDepth; // layer 1's radial offset (capacity.ts)
  const pitch = d + CLEARANCE;
  const zStart = grooveStartHeight(d, CLEARANCE, grooveDepth, MARGIN);

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
  const dropToFace = zStart - d / 2; // how far it falls until its bottom reaches the face
  const needSide = (d + tolerance) / 2 + INNER_CHANNEL_WALL_SKIN;
  const lineOffset = (s: number) => outlineOffsetAt(outline, j.x - s * tx, j.y - s * ty).offset;
  const budget = CABLE_BEND_BUDGET / bendRadius;

  const shape = (L: number) => {
    const z = bump(drop, helixSlope, L);
    const channelStart = dropToFace <= 0 ? 0 : invert(z.value, dropToFace, 0, L);
    const side = channelStart > 1e-6 ? Math.max(0, needSide - lineOffset(channelStart) - (curve * channelStart * channelStart) / 2) : 0;
    const lateral = bump(side, 0, channelStart);
    return { z, channelStart, side, lateral, peak: Math.hypot(z.A, (side > 0 ? lateral.A : 0) + curve) };
  };

  let L: number;
  if (forcedDrop !== undefined) {
    L = Math.max(forcedDrop, 1e-3);
  } else {
    let lo = 0.5;
    let hi = 1;
    while (shape(hi).peak > budget && hi < 1e5) hi *= 2;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (shape(mid).peak > budget) lo = mid;
      else hi = mid;
    }
    L = hi;
  }
  const { z, channelStart, side, lateral } = shape(L);

  const bend = (s: number) => (curve * s * s) / 2;
  const chordAt = (s: number): XY => ({ x: j.x - s * tx + (side + bend(s)) * nx, y: j.y - s * ty + (side + bend(s)) * ny });
  return {
    dropLength: L,
    curve,
    settled: drop <= CABLE_CLIP_DEPTH_SLACK ? 0 : invert(z.value, drop - CABLE_CLIP_DEPTH_SLACK, 0, L),
    chordAt,
    at: (s) => {
      const shift = (side > 0 ? lateral.value(Math.min(s, channelStart)) : 0) + bend(s);
      return { x: j.x - s * tx + shift * nx, y: j.y - s * ty + shift * ny, z: zStart - z.value(s) };
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
  // the cut begins at zero depth), and ends with the whole bore past the rim.
  const sStart = bottom(0) <= 0.3 ? 0 : invert((s) => -bottom(s), -0.3, 0, route.dropLength);
  const stations = stationsOver(sStart, sEnd, CABLE_SWEEP_STEP, [clipFrom, clipFrom + CABLE_CLIP_ENTRY, clipEnd - CABLE_CLIP_ENTRY, clipEnd]);
  const rings = stations.map((s) => {
    const { c, u, stretch } = frame(s);
    return boreRing(c, u, R, stretch, { half: lipHalf(s, clipFrom, clipEnd, R), to: Math.max(c.z + R * stretch, 0) + 1 });
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
    clipOpening: 2 * CABLE_CLIP_OPENING_FRACTION * R,
    channel,
    clip: { from: route.at(clipFrom), to: route.at(clipEnd) },
    rimExit: { x: atRim.x, y: atRim.y },
    channelRibbon,
    leadIn,
    requiredMargin,
    warning,
  };
}

// --- The top cap's clips (the cable's outer end) ----------------------------

/** The cap clip block's half-width where it meets the plate: its bore, the bore's wall and the 45 degree chamfer (issue #121). */
function capClipRootHalf(wireDiameter: number, tolerance: number): number {
  return clipRadius(wireDiameter, tolerance) + CABLE_CLIP_WALL + CAP_CLIP_CHAMFER;
}

/**
 * The cap clips' centre offset (outside the core's outline). Issue #121: as
 * close to the coil as the wound cable allows -- the chamfer's inner foot
 * CAP_CLIP_COIL_GAP clear of the outermost layer's outer surface
 * (`envelopeOffset`) -- instead of pressed against the rim; the flange (and
 * cap) margin keeps room for the rest (`requiredCapClipMargin`).
 */
export function capClipOffset(envelopeOffset: number, wireDiameter: number, tolerance: number): number {
  return envelopeOffset + CAP_CLIP_COIL_GAP + capClipRootHalf(wireDiameter, tolerance);
}

/** The cable's centre height at the cap end, relative to the cap plate's underside: its top a hair (CAP_CABLE_DROP) below it. */
export function capCableZ(wireDiameter: number): number {
  return -wireDiameter / 2 - CAP_CABLE_DROP;
}

/**
 * The narrowest margin that fits the cap clip between the wound cable's
 * outer surface (`envelopeOffset`, outside the core's outline) and the rim:
 * the clip at `capClipOffset`, its chamfered root still CAP_CLIP_RIM_INSET
 * inside the rim.
 */
export function requiredCapClipMargin(envelopeOffset: number, wireDiameter: number, tolerance: number): number {
  return capClipOffset(envelopeOffset, wireDiameter, tolerance) + capClipRootHalf(wireDiameter, tolerance) + CAP_CLIP_RIM_INSET;
}

/** One clip under the top cap, in the cap's LOCAL frame (plate underside at z = 0). */
export interface CapClip {
  /** The clip block (the lips' body), with its chamfered, pyramid-like root; its top reaches 1 mm into the plate so the two weld. */
  block: SweepSolid;
  /** The bore and its downward opening, cut through the block (and CAP_CLIP_RELIEF up into the plate). */
  bore: SweepSolid;
  /** The cable's plan-view path from the clip's start, through the clip and out past the rim to its free end. Its height is level, at `capCableZ`. */
  path: XY[];
}

export interface CapClipLayout {
  /** Every clip around the cap (issue #121). The drawn cable runs through `clips[0]`; the others are the same clip at other positions, for a cable end unwound a little further. */
  clips: CapClip[];
}

/**
 * Lay out the top cap's clips. The first starts where the cable's cap
 * lead-out ends (outline parameter `u0`, at `capClipOffset`, level, running
 * along the outline): the cable follows the outline through the clip, then
 * curves gently (a fraction of its bend budget) outward and leaves past the
 * rim. `outline`/`margin` mirror the cap's own (the flange's) exactly.
 *
 * Issue #121: the same clip is repeated at `outline.n` evenly spaced
 * positions around the cap (every 90 degrees on round and square, every 120
 * on a triangle), all at the same offset and height and all along the
 * outline in the winding direction, so each one is exactly the first clip's
 * layout moved along the outline: a cable end arriving at any of them level
 * along the outline (as the drawn one arrives at the first) goes through it
 * and out past the rim within the same bend budget. A repeated clip is left
 * out where it would stand in the drawn cable's way (`avoid`, the lead-out's
 * samples in this local frame, or another clip's cable path) -- e.g. just
 * behind the first clip, where the lead-out runs up under the cap.
 */
export function layoutCapClip(
  outline: ShapeOutline,
  margin: number,
  envelopeOffset: number,
  wireDiameter: number,
  tolerance: number,
  bendRadius: number,
  u0: number,
  avoid: XYZ[] = [],
): CapClipLayout {
  const R = clipRadius(wireDiameter, tolerance);
  const o = capClipOffset(envelopeOffset, wireDiameter, tolerance);
  const len = clipLength(wireDiameter);
  const zc = capCableZ(wireDiameter);
  const W = R + CABLE_CLIP_WALL;
  const C = CAP_CLIP_CHAMFER;
  // The lips hang CAP_CLIP_LIP below where the opening meets the bore.
  const closed = CABLE_CLIP_OPENING_FRACTION * R;
  const zLo = zc - Math.sqrt(R * R - closed * closed) - CAP_CLIP_LIP;

  const one = (uStart: number): { clip: CapClip; spine: XY[] } => {
    // Along the outline at offset `o`, by arc length (pointAt's own parameter
    // is only proportional to arc length at offset 0).
    const fine: { s: number; t: number }[] = [{ s: 0, t: uStart }];
    const dt = 0.05 / Math.max(1, Math.hypot(pointAt(outline, uStart + 1e-4, o).x - pointAt(outline, uStart, o).x, pointAt(outline, uStart + 1e-4, o).y - pointAt(outline, uStart, o).y) / 1e-4);
    while (fine[fine.length - 1].s < len + C + 2) {
      const prev = fine[fine.length - 1];
      const a = pointAt(outline, prev.t, o);
      const b = pointAt(outline, prev.t + dt, o);
      fine.push({ s: prev.s + Math.hypot(b.x - a.x, b.y - a.y), t: prev.t + dt });
    }
    // ...and back past the start, where the block's end chamfer and the bore reach.
    while (fine[0].s > -(C + 2)) {
      const next = fine[0];
      const a = pointAt(outline, next.t - dt, o);
      const b = pointAt(outline, next.t, o);
      fine.unshift({ s: next.s - Math.hypot(b.x - a.x, b.y - a.y), t: next.t - dt });
    }
    const tAt = (s: number) => {
      const i = Math.max(1, fine.findIndex((f) => f.s >= s));
      const [a, b] = [fine[i - 1], fine[i]];
      return a.t + ((b.t - a.t) * (s - a.s)) / Math.max(1e-12, b.s - a.s);
    };
    const along = (s: number) => {
      const t = tAt(s);
      const p = pointAt(outline, t, o);
      const q = pointAt(outline, t + 1e-6, o);
      const l = Math.hypot(q.x - p.x, q.y - p.y);
      return { c: { x: p.x, y: p.y }, u: { x: -(q.y - p.y) / l, y: (q.x - p.x) / l }, n: { x: p.nx, y: p.ny }, tan: { x: (q.x - p.x) / l, y: (q.y - p.y) / l } };
    };

    // The block: the lips' body down to zLo over the clip's length, on a
    // 45 degree chamfer C wide at the plate on both sides AND past both
    // ends (the end chamfer ramps from C deep at the block's end face to
    // nothing C further on), so its root is a pyramid-like frustum.
    const depthAt = (s: number) => (s >= 0 && s <= len ? -zLo : C - Math.max(-s, s - len));
    const END = 0.05; // the end chamfer stops this short of the plate, never a face lying on it
    // Close stations along the end chamfers, so their slopes follow a
    // curving outline closely.
    const ramp = Array.from({ length: 6 }, (_, i) => (C * (i + 1)) / 7);
    const blockStations = stationsOver(-C + END, len + C - END, CABLE_SWEEP_STEP, [...ramp.map((e) => -e), ...ramp.map((e) => len + e), -0.01, 0, CABLE_CLIP_ENTRY, len - CABLE_CLIP_ENTRY, len, len + 0.01]);
    const block: SweepSolid = {
      rings: blockStations.map((s) => {
        const { c, u } = along(s);
        return chamferedBlockRing(c, u, W, C, depthAt(s));
      }),
      start: { ...along(-C + END).c, z: (1 - END) / 2 },
      end: { ...along(len + C - END).c, z: (1 - END) / 2 },
    };
    // The bore runs a mm past each end of the block (chamfer included), so
    // the block is open. Outside the lips it keeps a sliver of lip (0.9 R,
    // not R): a full-width opening under a full-width relief would leave the
    // circle no arc at all.
    const boreStations = stationsOver(-C - 1, len + C + 1, CABLE_SWEEP_STEP, [0, CABLE_CLIP_ENTRY, len - CABLE_CLIP_ENTRY, len]);
    const bore: SweepSolid = {
      rings: boreStations.map((s) => {
        const { c, u } = along(s);
        return boreRing({ ...c, z: zc }, u, R, 1, { half: R, to: CAP_CLIP_RELIEF }, { half: lipHalf(s, 0, len, R, 0.9 * R), to: zLo - 1 });
      }),
      start: { ...along(-C - 1).c, z: zc },
      end: { ...along(len + C + 1).c, z: zc },
    };

    // The cable: through the clip along the outline, then out along the
    // clip end's tangent, bending gently outward, past the rim.
    const path: XY[] = [];
    const clipSteps = Math.max(2, Math.ceil(len / CABLE_BRIDGE_STEP));
    for (let i = 0; i <= clipSteps; i++) path.push(along((len * i) / clipSteps).c);
    const end = along(len);
    const curve = (0.8 * CABLE_BEND_BUDGET) / bendRadius;
    const exit = (s: number): XY => ({
      x: end.c.x + end.tan.x * s + end.n.x * ((curve * s * s) / 2),
      y: end.c.y + end.tan.y * s + end.n.y * ((curve * s * s) / 2),
    });
    const sRim = reach((s) => {
      const p = exit(s);
      return outlineOffsetAt(outline, p.x, p.y).offset;
    }, margin, 0);
    const sOut = sRim + clippedTailLength(wireDiameter);
    const exitSteps = Math.max(2, Math.ceil(sOut / CABLE_BRIDGE_STEP));
    for (let i = 1; i <= exitSteps; i++) path.push(exit((sOut * i) / exitSteps));

    const spineSteps = Math.ceil((len + 2 * C) / CABLE_BRIDGE_STEP);
    const spine = Array.from({ length: spineSteps + 1 }, (_, i) => along(-C + ((len + 2 * C) * i) / spineSteps).c);
    return { clip: { block, bore, path }, spine };
  };

  // Whether a cable (centre samples `points`, local frame) would run into a
  // clip's block: within the block's root half-width (plus the cable's own
  // radius and the coil gap) of its spine, and not wholly below its lips.
  const reachHalf = W + C + wireDiameter / 2 + CAP_CLIP_COIL_GAP;
  const blocks = (spine: XY[], points: XYZ[]) =>
    points.some((q) => q.z + wireDiameter / 2 > zLo - CAP_CLIP_COIL_GAP && spine.some((c) => Math.hypot(q.x - c.x, q.y - c.y) < reachHalf));
  const onPath = (clip: CapClip) => clip.path.map((p) => ({ ...p, z: zc }));

  const all = Array.from({ length: outline.n }, (_, i) => one(u0 + i / outline.n));
  const kept = [all[0]];
  for (const candidate of all.slice(1)) {
    if (blocks(candidate.spine, avoid)) continue;
    if (all.some((other) => other !== candidate && (blocks(candidate.spine, onPath(other.clip)) || blocks(other.spine, onPath(candidate.clip))))) continue;
    kept.push(candidate);
  }
  return { clips: kept.map((k) => k.clip) };
}

/**
 * A cap clip block's cross-section across the cable at `c` (issue #121): a
 * half-width of `W` down to `depth` below the plate, widening on a 45 degree
 * chamfer to W + C at the plate. The chamfer runs on 0.1 mm into the plate
 * (never an edge lying exactly on its underside), then straight up to 1 mm
 * into it, where the two weld -- so nothing reaches past W + C + 0.1, inside
 * the rim. Where `depth` is under C (the end chamfer) the whole section lies
 * on the chamfer's slope. Always eight vertices, so every ring of the sweep
 * matches: on the slope-only sections the one between the weld and the
 * bottom is a collinear midpoint.
 */
function chamferedBlockRing(c: XY, u: XY, W: number, C: number, depth: number): XYZ[] {
  const at = (p: number, z: number): XYZ => ({ x: c.x + u.x * p, y: c.y + u.y * p, z });
  const E = 0.1;
  const weld = W + C + E;
  const lo = depth > C ? W : W + C - depth;
  const [bp, bz] = depth > C ? [W, -C] : [(weld + lo) / 2, (E - depth) / 2];
  return [at(weld, 1), at(weld, E), at(bp, bz), at(lo, -depth), at(-lo, -depth), at(-bp, bz), at(-weld, E), at(-weld, 1)];
}
