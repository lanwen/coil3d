// Cable fix points (issues #8, #115, #117, docs/design.md, Cable ends):
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
// opening narrows below the cable's diameter (`baseClipOpeningFraction`)
// for a short length: the cable snaps down into a C-shaped clip that lies
// along its own direction, and leaves the flange sideways through the rim
// along the same chord, with no extra bend (the old vertical rim keyhole
// needed a 90 degree turn). The clip sits where both lips are still inside
// the rim (`CABLE_CLIP_WALL` of flange beyond them), after the drop.
//
// The cap end (`layoutCapClip`) holds the cable the other way up: the cable
// arrives level just under the cap, follows the outline for the clip's
// length, then curves gently out past the rim. The cap is only 3 mm thick,
// too thin to recess a cable into, so its clip is a low rib hanging under the
// plate with the bore through it and the opening facing down (up, in the
// cap's flipped print orientation). Issue #237: the rib is stiff on purpose
// (thick walls all round the bore, a narrow relief, a rounded lower edge, ends
// ramped into the plate at 45 degrees), the throat is only a little narrower
// than the cable so the cable's jacket takes the squeeze, and a 45 degree
// lead-in guides the cable in. The rib sits between the wound cable and the
// rim, as close to the coil as the wound cable allows (issue #121), so the
// flange (and cap) margin grows to fit it (`requiredCapClipMargin`), and the
// same clip repeats every 1/n of the way around the cap.
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
  CABLE_SWEEP_STEP,
  CAP_CABLE_DROP,
  CAP_CLIP_COIL_GAP,
  CAP_CLIP_LENGTH_FACTOR,
  CAP_CLIP_MIN_LENGTH,
  CAP_CLIP_MOUTH,
  CAP_CLIP_OPENING_FRACTION,
  CAP_CLIP_RELIEF,
  CAP_CLIP_RELIEF_WIDTH,
  CAP_CLIP_RIM_INSET,
  CAP_CLIP_WALL_FACTOR,
  CAP_CLIP_WALL_MAX,
  CAP_CLIP_WALL_MIN,
  CLEARANCE,
  EDGE_CHAMFER,
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
  /** For a convex solid: split each quad between two rings along whichever diagonal keeps the surface convex (else always the same one). The cap clip's end ramps need it: there a quad can join a vertex on the rib's side to three on the ramp. */
  convexQuads?: boolean;
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
  const p = (k: number) => rings[Math.floor(k / m)][k % m];
  const centre = rings.map((ring) => ({ x: ring.reduce((t, q) => t + q.x, 0) / m, y: ring.reduce((t, q) => t + q.y, 0) / m, z: ring.reduce((t, q) => t + q.z, 0) / m }));
  /** Whether `q` lies on the same side of the plane through a, b, c as `inside` (or on it). */
  const sameSide = (a: number, b: number, c: number, q: XYZ, inside: XYZ) => {
    const [pa, pb, pc] = [p(a), p(b), p(c)];
    const u = { x: pb.x - pa.x, y: pb.y - pa.y, z: pb.z - pa.z };
    const v = { x: pc.x - pa.x, y: pc.y - pa.y, z: pc.z - pa.z };
    const nx = u.y * v.z - u.z * v.y;
    const ny = u.z * v.x - u.x * v.z;
    const nz = u.x * v.y - u.y * v.x;
    const side = (r: XYZ) => nx * (r.x - pa.x) + ny * (r.y - pa.y) + nz * (r.z - pa.z);
    return side(q) * side(inside) >= -1e-12;
  };
  for (let i = 0; i + 1 < n; i++) {
    const inside = { x: (centre[i].x + centre[i + 1].x) / 2, y: (centre[i].y + centre[i + 1].y) / 2, z: (centre[i].z + centre[i + 1].z) / 2 };
    for (let j = 0; j < m; j++) {
      const a = i * m + j;
      const b = i * m + ((j + 1) % m);
      const c = a + m;
      const d = b + m;
      if (sweep.convexQuads && !sameSide(a, b, d, p(c), inside)) tris.push(a, b, c, b, d, c);
      else tris.push(a, b, d, a, d, c);
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
  // the cut begins at zero depth), and ends with the whole bore past the rim.
  const sStart = bottom(0) <= 0.3 ? 0 : invert((s) => -bottom(s), -0.3, 0, route.dropLength);
  const stations = stationsOver(sStart, sEnd, CABLE_SWEEP_STEP, [clipFrom, clipFrom + CABLE_CLIP_ENTRY, clipEnd - CABLE_CLIP_ENTRY, clipEnd]);
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


// --- The top cap's clips (the cable's outer end) ----------------------------

/** How many facets round each lower edge of a cap clip's rib, and across its bottom. */
const CAP_RIB_EDGE_SEGMENTS = 6;
const CAP_RIB_BOTTOM_SEGMENTS = 8;
/** Spacing of a cap clip rib's cross-sections along its full-depth part, mm: close, so its vertical sides stay smooth round a corner of the outline (at CABLE_SWEEP_STEP each facet seam showed as a line). */
const CAP_RIB_STEP = 0.5; // mm

/**
 * A cap clip's cross-section across the cable (issue #237), in the cap's
 * local frame (plate underside at z = 0, the cable below it): a rib with
 * vertical sides `outer` out from the cable's centre, a rounded lower edge
 * (an arc about the cable's centre, so the wall round the bore is one
 * thickness everywhere) and a flat bottom flush with the bore's. The bore
 * opens downward through a `throat` a little narrower than the cable, with a
 * 45 degree lead-in `lead` high under it.
 */
interface CapClipSection {
  /** The bore's radius, (d + tolerance) / 2. */
  R: number;
  /** The cable's centre height (`capCableZ`). */
  zc: number;
  /** The rib's half-width: the bore plus its wall. */
  outer: number;
  /** The throat's half-width. */
  throat: number;
  /** The rib's flat bottom, z. */
  bottom: number;
  /** The lead-in's height (and width, at 45 degrees). */
  lead: number;
}

function capClipSection(wireDiameter: number, tolerance: number): CapClipSection {
  const R = clipRadius(wireDiameter, tolerance);
  const zc = capCableZ(wireDiameter);
  const throat = CAP_CLIP_OPENING_FRACTION * R;
  const bottom = zc - R;
  const zThroat = zc - Math.sqrt(R * R - throat * throat);
  return {
    R,
    zc,
    outer: R + Math.min(CAP_CLIP_WALL_MAX, Math.max(CAP_CLIP_WALL_MIN, CAP_CLIP_WALL_FACTOR * wireDiameter)),
    throat,
    bottom,
    lead: Math.min(R + CAP_CLIP_MOUTH - throat, (zThroat - bottom) / 2),
  };
}

/** How long a cap clip's full-depth section is, along the cable (mm). Its ends ramp into the plate beyond it. */
export function capClipLength(wireDiameter: number): number {
  return Math.max(CAP_CLIP_MIN_LENGTH, CAP_CLIP_LENGTH_FACTOR * wireDiameter);
}

/** A cap clip's half-width (its rib's vertical sides, from the cable's centre), mm. */
export function capClipHalfWidth(wireDiameter: number, tolerance: number): number {
  return capClipSection(wireDiameter, tolerance).outer;
}

/** The cap clip's throat width (narrower than the cable), mm. */
export function capClipThroat(wireDiameter: number, tolerance: number): number {
  return 2 * capClipSection(wireDiameter, tolerance).throat;
}

/**
 * The cap clips' centre offset (outside the core's outline). Issue #121: as
 * close to the coil as the wound cable allows -- the rib's inner side
 * CAP_CLIP_COIL_GAP clear of the outermost layer's outer surface
 * (`envelopeOffset`) -- instead of pressed against the rim; the flange (and
 * cap) margin keeps room for the rest (`requiredCapClipMargin`).
 */
export function capClipOffset(envelopeOffset: number, wireDiameter: number, tolerance: number): number {
  return envelopeOffset + CAP_CLIP_COIL_GAP + capClipHalfWidth(wireDiameter, tolerance);
}

/** The cable's centre height at the cap end, relative to the cap plate's underside: its top a hair (CAP_CABLE_DROP) below it. */
export function capCableZ(wireDiameter: number): number {
  return -wireDiameter / 2 - CAP_CABLE_DROP;
}

/**
 * The narrowest margin that fits the cap clip between the wound cable's
 * outer surface (`envelopeOffset`, outside the core's outline) and the rim:
 * the clip at `capClipOffset`, its rib still CAP_CLIP_RIM_INSET inside the
 * foot of the cap underside's rim chamfer (issue #237: the cap is chamfered
 * on both faces).
 */
export function requiredCapClipMargin(envelopeOffset: number, wireDiameter: number, tolerance: number): number {
  return capClipOffset(envelopeOffset, wireDiameter, tolerance) + capClipHalfWidth(wireDiameter, tolerance) + EDGE_CHAMFER + CAP_CLIP_RIM_INSET;
}

/** One clip under the top cap, in the cap's LOCAL frame (plate underside at z = 0). */
export interface CapClip {
  /** The clip's rib (the lips' body), its ends ramped into the plate at 45 degrees; its top reaches 1 mm into the plate so the two weld. */
  block: SweepSolid;
  /** The bore, its downward throat and lead-in, cut through the rib (and CAP_CLIP_RELIEF up into the plate). */
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
  const sec = capClipSection(wireDiameter, tolerance);
  const o = capClipOffset(envelopeOffset, wireDiameter, tolerance);
  const len = capClipLength(wireDiameter);
  // The ends ramp at 45 degrees from the full depth up to the plate.
  const ramp = -sec.bottom;
  const reachBack = ramp + 1;

  const one = (uStart: number): { clip: CapClip; spine: XY[] } => {
    // Along the outline at offset `o`, by arc length (pointAt's own parameter
    // is only proportional to arc length at offset 0).
    const fine: { s: number; t: number }[] = [{ s: 0, t: uStart }];
    const dt = 0.05 / Math.max(1, Math.hypot(pointAt(outline, uStart + 1e-4, o).x - pointAt(outline, uStart, o).x, pointAt(outline, uStart + 1e-4, o).y - pointAt(outline, uStart, o).y) / 1e-4);
    while (fine[fine.length - 1].s < len + reachBack) {
      const prev = fine[fine.length - 1];
      const a = pointAt(outline, prev.t, o);
      const b = pointAt(outline, prev.t + dt, o);
      fine.push({ s: prev.s + Math.hypot(b.x - a.x, b.y - a.y), t: prev.t + dt });
    }
    // ...and back past the start, where the rib's ramp and the bore reach.
    while (fine[0].s > -reachBack) {
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

    // The rib: the full section over the clip's length; past each end a 45
    // degree ramp cuts it off, rising to the plate. A station exactly where
    // the ramp passes each of the section's vertices, and none in between: so
    // each quad of the ramp lies on it or on the rib's side, and each edge of
    // the rib runs cleanly into it. (A station whose cut fell between two
    // vertices left a folded quad there, drawn as a stray line.) It runs on
    // END into the plate, so it crosses the plate's underside cleanly (a rib
    // end stopping just short of it left a sliver step, and long tilted
    // triangles across the underside).
    const depthAt = (s: number) => (s >= 0 && s <= len ? ramp : ramp - Math.max(-s, s - len));
    const END = 0.2;
    const cuts = [...new Set(capRibRing({ x: 0, y: 0 }, { x: 1, y: 0 }, sec, ramp).map((q) => q.z).filter((z) => z < 0 && z > -ramp + 1e-6))];
    const rampAt = cuts.map((z) => ramp + z);
    const blockStations = [-ramp - END, ...rampAt.map((e) => -e).sort((a, b) => a - b), ...stationsOver(0, len, CAP_RIB_STEP, []), ...rampAt.map((e) => len + e).sort((a, b) => a - b), len + ramp + END];
    const block: SweepSolid = {
      rings: blockStations.map((s) => {
        const { c, u } = along(s);
        return capRibRing(c, u, sec, depthAt(s));
      }),
      start: { ...along(-ramp - END).c, z: 0.6 },
      end: { ...along(len + ramp + END).c, z: 0.6 },
      convexQuads: true,
    };
    // The bore runs a little past each end of the rib, so the rib is open.
    const boreFrom = -ramp - END - 0.3;
    const boreTo = len + ramp + END + 0.3;
    const bore: SweepSolid = {
      rings: stationsOver(boreFrom, boreTo, CABLE_SWEEP_STEP, [0, len]).map((s) => {
        const { c, u } = along(s);
        return capBoreRing(c, u, sec);
      }),
      start: { ...along(boreFrom).c, z: sec.zc },
      end: { ...along(boreTo).c, z: sec.zc },
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

    const spineSteps = Math.ceil((len + 2 * ramp) / CABLE_BRIDGE_STEP);
    const spine = Array.from({ length: spineSteps + 1 }, (_, i) => along(-ramp + ((len + 2 * ramp) * i) / spineSteps).c);
    return { clip: { block, bore, path }, spine };
  };

  // Whether a cable (centre samples `points`, local frame) would run into a
  // clip's rib: within its half-width (plus the cable's own radius and the
  // coil gap) of its spine, and not wholly below it.
  const reachHalf = sec.outer + wireDiameter / 2 + CAP_CLIP_COIL_GAP;
  const blocks = (spine: XY[], points: XYZ[]) =>
    points.some((q) => q.z + wireDiameter / 2 > sec.bottom - CAP_CLIP_COIL_GAP && spine.some((c) => Math.hypot(q.x - c.x, q.y - c.y) < reachHalf));
  const onPath = (clip: CapClip) => clip.path.map((p) => ({ ...p, z: sec.zc }));

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
 * A cap clip rib's cross-section across the cable at `c` (`u` the unit
 * vector across it): straight up from where the rounded lower edge begins
 * (level with the cable's centre) to 1 mm into the plate, where the two
 * weld, round the edge and across the bottom (the bore cuts the middle).
 * Cut off `depth` under the plate (the full depth is the bottom, less on the
 * end ramps): a vertex below the cut moves straight up onto it, so the
 * section keeps its vertex count and order and the sweep never folds.
 */
function capRibRing(c: XY, u: XY, sec: CapClipSection, depth: number): XYZ[] {
  const at = (p: number, z: number): XYZ => ({ x: c.x + u.x * p, y: c.y + u.y * p, z: Math.max(z, -depth) });
  const { R, zc, outer } = sec;
  // From the vertical side, round the edge to where it meets the bottom (zc - R).
  const end = Math.asin(R / outer);
  const edge = Array.from({ length: CAP_RIB_EDGE_SEGMENTS + 1 }, (_, i) => {
    const phi = (end * i) / CAP_RIB_EDGE_SEGMENTS;
    return { p: outer * Math.cos(phi), z: zc - outer * Math.sin(phi) };
  });
  // Across the bottom in short steps: on a curving outline the end ramp is
  // slightly twisted, and one wide quad across it would fold along its
  // diagonal (a stray line in the drawing).
  const across = Array.from({ length: CAP_RIB_BOTTOM_SEGMENTS - 1 }, (_, i) => edge[CAP_RIB_EDGE_SEGMENTS].p * (1 - (2 * (i + 1)) / CAP_RIB_BOTTOM_SEGMENTS));
  return [at(outer, 1), ...edge.map((e) => at(e.p, e.z)), ...across.map((p) => at(p, zc - R)), ...edge.reverse().map((e) => at(-e.p, e.z)), at(-outer, 1)];
}

/**
 * A cap clip bore's cross-section across the cable at `c`: the round bore
 * about the cable's centre, a narrow relief slot CAP_CLIP_RELIEF up into the
 * plate, and below the bore the throat, straight down, widening at 45
 * degrees into the lead-in and on past the rib's bottom. Star-shaped about
 * the cable's centre, so a fan from it caps the sweep.
 */
function capBoreRing(c: XY, u: XY, sec: CapClipSection): XYZ[] {
  const at = (p: number, z: number): XYZ => ({ x: c.x + u.x * p, y: c.y + u.y * p, z });
  const { R, zc, throat, bottom, lead } = sec;
  const relief = CAP_CLIP_RELIEF_WIDTH * R;
  const a0 = Math.asin(relief / R);
  const a1 = Math.PI - Math.asin(throat / R);
  const arc = Array.from({ length: CABLE_SWEEP_ARC_SEGMENTS + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / CABLE_SWEEP_ARC_SEGMENTS;
    return { p: R * Math.sin(a), z: zc + R * Math.cos(a) };
  });
  const right = [{ p: relief, z: CAP_CLIP_RELIEF }, ...arc, { p: throat, z: bottom + lead }, { p: throat + lead + 1, z: bottom - 1 }];
  return [...right.map((q) => at(q.p, q.z)), ...right.reverse().map((q) => at(-q.p, q.z))];
}
