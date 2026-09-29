// Inner-end fixing (issue #8, docs/research.md "Wire ends"; redesigned in
// issue #115): the bottom flange's rim keyhole for the inner cable end, and
// the recessed channel on the flange's inner face that leads the cable from
// it to the groove start. Pure geometry math only -- no manifold-3d, no
// replicad -- shared by the mesh backend (manifold.ts), the STEP backend
// (step/build.ts) AND the drawn cable (wire.ts, design.ts), the same "one
// shared layout, several consumers" principle as mount.ts's
// `layoutKeyholeMount`: all of them must agree on exactly where the hole,
// slit and channel sit.
//
// Issue #115: the cable must never bend tighter than its minimum bend
// radius (MBR). Issue #8's radial channel plus a margin-limited fillet made
// a stiff cable turn back on itself right at the groove start. Instead, the
// cable now leaves the groove start (layer 1's first sample, `J`) along the
// helix's OWN tangent, backwards, as a straight chord across the flange
// margin -- a cable at its MBR can follow a straight line. Two gentle,
// curvature-limited blends ride on that chord:
//   - z: the cable drops from the helix start height (`zStart`, a few mm
//     above the flange face) into the recessed channel (cable top flush
//     with the face, the #43 guarantee), and
//   - sideways (`N`, the outward normal at t=0): the channel sits a skin
//     clear of the wall, so the cable lies in a full-width trench (a
//     square/triangle's t=0 is the end of a flat side, so the chord runs
//     right along the wall there; round's chord leaves the wall on its own).
// Each blend is the lowest-peak-curvature C1 ramp (two parabolas, see
// `bump`), sized so the combined curvature stays within CABLE_BEND_BUDGET /
// MBR. The keyhole sits where the chord meets the flange rim; the flat
// channel runs from there to where the cable rises out of the face.
//
// If the flange margin is too narrow for the chord to hold the keyhole past
// the end of the drop, `requiredInnerEndMargin` says how wide it must be --
// flange.ts grows the margin to that (design.ts warns), so a real design
// never gets an impossible bend.

import {
  CABLE_BEND_BUDGET,
  CABLE_BRIDGE_STEP,
  CLEARANCE,
  GROOVE_DEPTH_FACTOR,
  INNER_CHANNEL_DEPTH_FACTOR,
  INNER_CHANNEL_MIN_SHELF,
  INNER_CHANNEL_WALL_SKIN,
  KEYHOLE_SLIT_FRACTION,
  MARGIN,
  SCREW_MOUNT_RECESS_DEPTH,
  THROUGH_MOUNT_COUNTERBORE_DEPTH,
} from "./constants";
import { outlineOffsetAt, pointAt, sideLength } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { MountKind } from "./types";
import { grooveStartHeight } from "./wall";

/** How much depth a mount's own pocket/counterbore -- cut from the flange's OTHER (outer, wall-facing) face -- reserves against the inner-end channel below (see `resolveChannelDepth`). 0 for "none" and the clip-plate mounts (skadis/opengrid), which don't cut anything into that face at this depth. */
function reservedMountDepth(mount: MountKind): number {
  if (mount === "keyhole") return SCREW_MOUNT_RECESS_DEPTH;
  if (mount === "through") return THROUGH_MOUNT_COUNTERBORE_DEPTH;
  return 0;
}

/** Ideal channel recess depth for the given wire diameter (issue #8): roughly a full cable diameter, so the wound cable's first turn lies flush -- see INNER_CHANNEL_DEPTH_FACTOR's own doc comment. */
export function idealChannelDepth(wireDiameter: number): number {
  return INNER_CHANNEL_DEPTH_FACTOR * wireDiameter;
}

/**
 * The channel's ACTUAL recess depth, given the flange's own (already
 * resolved) thickness: the ideal depth, capped to whatever the flange's
 * thickness leaves below a small shelf -- and, when there's also a mount's
 * own pocket/counterbore cut into the OTHER face (issue #13's screw-keyhole
 * mount, or issue #70's through-hole mount -- `reservedMountDepth`, a fixed
 * depth reserved from the flange's outer/z=-thickness side), below THAT cut
 * too, so the two never meet in the middle. design.ts warns when this caps
 * the channel (flange.ts normally provisions enough thickness).
 */
export function resolveChannelDepth(wireDiameter: number, flangeThickness: number, mount: MountKind): number {
  const ideal = idealChannelDepth(wireDiameter);
  const reserved = INNER_CHANNEL_MIN_SHELF + reservedMountDepth(mount);
  return Math.min(ideal, Math.max(0, flangeThickness - reserved));
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

export interface InnerEndLayout {
  /** Keyhole hole centre, in the flange's local XY (mm): on the cable's tangent chord, inset from the flange rim by holeRadius + a mm of skin. */
  hole: XY;
  /** The flange's outer edge point nearest the hole, where the retaining slit opens (mm). */
  edge: XY;
  holeRadius: number;
  slitWidth: number;
  /** Width of the recessed channel trench, mm. */
  channelWidth: number;
  /** The channel's straight centreline, from the keyhole (`channelPath[0]`, always `hole`) to where the cable rises out of the flange face. */
  channelPath: XY[];
  /** The channel trench's closed 2D outline (a `channelWidth`-wide rectangle around `channelPath`), extruded once by each backend. */
  channelRibbon: XY[];
  /** The drawn cable from the keyhole (z at the channel's cable centre) to layer 1's first sample (`J`, the groove start), dense xyz samples. */
  leadIn: XYZ[];
  /** The narrowest flange margin that fits this lead-in within the bend radius, mm (flange.ts grows the margin to at least this). */
  requiredMargin: number;
  /** Set only when `margin` is narrower than `requiredMargin`: the lead-in then bends tighter than the cable allows. */
  warning?: string;
}

/** mm of rim material deliberately left outside the keyhole (mirrors manifold.ts's `buildKeyholeCutter`). */
export const KEYHOLE_SKIN = 1;

/** The cap keyhole at t=0 (the pre-#115 placement), for a cap built without a `Design.capKeyhole`. */
export function defaultCapKeyhole(outline: ShapeOutline, margin: number, holeRadius: number, skin: number): { hole: XY; edge: XY } {
  const edge = pointAt(outline, 0, margin);
  return { hole: { x: edge.x - edge.nx * (holeRadius + skin), y: edge.y - edge.ny * (holeRadius + skin) }, edge: { x: edge.x, y: edge.y } };
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

/** Smallest s in [0, L] where the (monotone) `value` reaches `target`. */
function invert(value: (s: number) => number, target: number, L: number): number {
  let lo = 0;
  let hi = L;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (value(mid) < target) lo = mid;
    else hi = mid;
  }
  return hi;
}

interface LeadInRoute {
  /** The cable's centre at chord distance `s` back from the groove start. */
  at(s: number): XYZ;
  /** Where the drop into the channel ends (the cable is at channel height from here on). */
  dropLength: number;
  /** Where the cable's bottom reaches the flange face (the channel starts here). */
  channelStart: number;
  /** A point on the (fully side-shifted) chord at distance `s` -- for s >= channelStart this IS `at(s)`'s xy. */
  chordAt(s: number): XY;
  /** The chord's own xy direction at `s` (unit, pointing away from the groove start). */
  directionAt(s: number): XY;
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
    const channelStart = dropToFace <= 0 ? 0 : invert(z.value, dropToFace, L);
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
    channelStart,
    chordAt,
    directionAt: (s) => {
      const dx = -tx + curve * s * nx;
      const dy = -ty + curve * s * ny;
      const len = Math.hypot(dx, dy);
      return { x: dx / len, y: dy / len };
    },
    at: (s) => {
      const shift = (side > 0 ? lateral.value(Math.min(s, channelStart)) : 0) + bend(s);
      return { x: j.x - s * tx + shift * nx, y: j.y - s * ty + shift * ny, z: zStart - z.value(s) };
    },
  };
}

/**
 * The lead-in bent (planLeadIn's `curve`) just enough that the keyhole
 * reaches the rim (`limit`, the hole centre's largest allowed offset) at
 * distance `target` along it -- or at the end of the drop, if the bend's
 * own share of the curvature budget pushes that further. Undefined when
 * that never settles (the caller keeps the straight chord).
 */
function bendToRim(outline: ShapeOutline, wireDiameter: number, tolerance: number, bendRadius: number, channelDepth: number, limit: number, target: number): { route: LeadInRoute; holeAt: number } | undefined {
  const maxCurve = (0.8 * CABLE_BEND_BUDGET) / bendRadius;
  let at = target;
  for (let pass = 0; pass < 8; pass++) {
    // The smallest bend that puts the rim at `at`.
    // (A wide flange -- a through-hole mount's -- can be out of reach by
    // then even at the largest bend: the keyhole then stops short of the
    // rim, with a longer slit out to it.)
    let lo = 0;
    let hi = maxCurve;
    if (holeOffset(outline, planLeadIn(outline, wireDiameter, tolerance, bendRadius, channelDepth, { curve: hi }), at) < limit) lo = hi;
    for (let i = 0; i < 40 && lo < hi; i++) {
      const mid = (lo + hi) / 2;
      if (holeOffset(outline, planLeadIn(outline, wireDiameter, tolerance, bendRadius, channelDepth, { curve: mid }), at) < limit) lo = mid;
      else hi = mid;
    }
    const route = planLeadIn(outline, wireDiameter, tolerance, bendRadius, channelDepth, { curve: lo });
    if (route.dropLength <= at + 1e-6) return { route, holeAt: at };
    at = route.dropLength;
  }
  return undefined;
}

function holeRadiusOf(wireDiameter: number, tolerance: number): number {
  return wireDiameter / 2 + tolerance;
}

/** Offset (outside the core's own outline) of the keyhole centre at chord distance `s`. */
function holeOffset(outline: ShapeOutline, route: LeadInRoute, s: number): number {
  const p = route.chordAt(s);
  return outlineOffsetAt(outline, p.x, p.y).offset;
}

/**
 * The narrowest flange margin whose rim can hold the keyhole on the chord
 * past the end of the drop (so the whole lead-in stays within the bend
 * radius). Cheap and margin-independent, so flange.ts (and through it the
 * solver's search) can call it for every candidate.
 */
export function requiredInnerEndMargin(outline: ShapeOutline, wireDiameter: number, tolerance: number, bendRadius: number, channelDepth = idealChannelDepth(wireDiameter)): number {
  const route = planLeadIn(outline, wireDiameter, tolerance, bendRadius, channelDepth);
  const holeRadius = holeRadiusOf(wireDiameter, tolerance);
  return holeOffset(outline, route, route.dropLength) + holeRadius + KEYHOLE_SKIN;
}

/**
 * Lay out the bottom-flange keyhole + inner channel + the drawn lead-in.
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
  const holeRadius = holeRadiusOf(wireDiameter, tolerance);
  const slitWidth = wireDiameter * KEYHOLE_SLIT_FRACTION + tolerance;
  const channelWidth = wireDiameter + tolerance;

  let route = planLeadIn(outline, wireDiameter, tolerance, bendRadius, channelDepth);
  const minHoleAt = route.dropLength;
  const requiredMargin = holeOffset(outline, route, minHoleAt) + holeRadius + KEYHOLE_SKIN;
  const limit = margin - holeRadius - KEYHOLE_SKIN; // the hole centre's largest allowed offset

  // The keyhole goes as far out along the chord as the rim allows (a short
  // slit), and never before the drop ends. Offset only grows along the
  // chord (it's tangent to a convex outline), so bisection finds it.
  const findHoleAt = (lo: number, hi: number) => {
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (holeOffset(outline, route, mid) <= limit) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  let holeAt: number;
  let warning: string | undefined;
  if (holeOffset(outline, route, minHoleAt) <= limit + 1e-6) {
    let hi = minHoleAt * 2 + 10;
    while (holeOffset(outline, route, hi) <= limit && hi < 1e5) hi *= 2;
    holeAt = findHoleAt(minHoleAt, hi);
    // A square or triangle's straight chord runs along the flat side that
    // ends at the groove start and only meets the rim past the NEXT corner
    // -- right where a through-hole mount puts that corner's screw hole.
    // Bend it gently outward instead, so it reaches the rim by the flat
    // side's middle (or the end of the drop, if that's further).
    const halfFlat = sideLength(outline) / 2;
    if (halfFlat > 1e-6 && holeAt > halfFlat) {
      const bent = bendToRim(outline, wireDiameter, tolerance, bendRadius, channelDepth, limit, halfFlat);
      if (bent) ({ route, holeAt } = bent);
    }
  } else {
    // Too narrow: squeeze the drop into what the rim leaves (bending the
    // cable tighter than it allows) and say so. design() never gets here --
    // flange.ts grows the margin to `requiredMargin` first.
    holeAt = findHoleAt(0, minHoleAt);
    route = planLeadIn(outline, wireDiameter, tolerance, bendRadius, channelDepth, { forcedDrop: Math.max(holeAt - holeRadius, holeAt / 2) });
    warning = `The ${margin.toFixed(1)} mm flange margin is too narrow for the inner cable end to reach the groove within its ${bendRadius.toFixed(1)} mm bend radius; it needs at least ${requiredMargin.toFixed(1)} mm.`;
  }

  const hole = route.chordAt(holeAt);
  const atHole = outlineOffsetAt(outline, hole.x, hole.y);
  const edge: XY = { x: hole.x + atHole.nx * (margin - atHole.offset), y: hole.y + atHole.ny * (margin - atHole.offset) };

  // The channel: from the keyhole along the chord to a little before where
  // the cable's bottom rises above the face (so it never catches the
  // trench's end wall), `channelWidth` wide -- a plain rectangle when the
  // chord is straight, a gentle arc (radius well above half its width) when
  // it's bent toward the rim.
  const channelFrom = Math.max(0, Math.min(route.channelStart - channelWidth / 2, holeAt));
  const span = holeAt - channelFrom;
  const channelSteps = span > 1e-6 ? Math.max(1, Math.ceil(span / (4 * CABLE_BRIDGE_STEP))) : 0;
  const centre = Array.from({ length: channelSteps + 1 }, (_, i) => holeAt - (span * i) / Math.max(channelSteps, 1));
  const rail = (sign: 1 | -1) =>
    centre.map((sAt) => {
      const p = route.chordAt(sAt);
      const t = route.directionAt(sAt);
      return { x: p.x - sign * t.y * (channelWidth / 2), y: p.y + sign * t.x * (channelWidth / 2) };
    });
  const channelPath: XY[] = centre.map((sAt) => route.chordAt(sAt));
  const channelRibbon: XY[] = span > 1e-6 ? [...rail(1), ...rail(-1).reverse()] : [];

  const steps = Math.max(2, Math.ceil(holeAt / CABLE_BRIDGE_STEP));
  const leadIn: XYZ[] = Array.from({ length: steps + 1 }, (_, i) => route.at(holeAt * (1 - i / steps)));

  return { hole, edge, holeRadius, slitWidth, channelWidth, channelPath, channelRibbon, leadIn, requiredMargin, warning };
}
