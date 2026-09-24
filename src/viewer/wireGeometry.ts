// Builds the schematic wound-cable geometry for the viewer (issue #4,
// docs/research.md §5 "Wire schematic" & §10b "Risk for our wire"). Consumes
// only `Design.wirePaths` (the core's public output) and the wire's radius --
// no core internals.
//
// Legibility (docs/research.md §10b): a full tube with one silhouette ring
// per turn reads fine up to a few dozen turns, but at hundreds of turns the
// per-turn occlusion lines the line-art edge pass draws between adjacent
// windings sit closer together than the dilated line weight and merge into a
// solid black band -- the "black mass" the ticket warns about. Past
// TURNS_FOR_ENVELOPE, this switches to the doc's other option: a smooth
// envelope (one plain cylindrical shell spanning the layer's occupied
// radius/height, contributing exactly one pair of silhouette lines no matter
// how many turns it represents) plus a handful of short full-fidelity "hint"
// tubes sampled from the real path, so the winding direction still reads.
//
// Either way the result is ONE merged BufferGeometry per layer (never
// per-turn), per the ticket's "merged tube geometry" wording, and it keeps
// TubeGeometry's own smooth (non-creased) normals -- S3's spike found that
// creasing a tube's radial facets draws a spurious line at every facet
// ridge, hatching the whole coil.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { WireLayerPath } from "../core";

/** Above this many turns, a layer switches from a full tube to envelope + hints. */
const TURNS_FOR_ENVELOPE = 60;
// Radial segments for the wire's circular cross-section (tube and hints).
// The wire is thick relative to the core (a few mm on a few-cm core), so a
// low-poly cross-section shows up as an actual faceted silhouette -- not a
// shading artifact toCreasedNormals would fix, since the edge shader's
// silhouette test reads real geometry, not normals. Round enough that the
// facets read as a smooth pen line, matching the IKEA reference.
const TUBE_RADIAL_SEGMENTS = 24;
/** Segments around the envelope's circumference. */
const ENVELOPE_RADIAL_SEGMENTS = 64;
// Hint turns (docs/research.md §10b "a few helical hint lines"): each hint
// is a real, multi-turn slice of the actual centerline -- not a flat ring --
// so it visibly spirals (the review's "reads like bamboo" complaint was a
// single-turn hint, which for a fat pitch relative to diameter is nearly
// indistinguishable from a flat ring at a glance). Two turns is enough that
// the wire visibly crosses over itself in projection from most angles.
const HINT_SPAN_TURNS = 2;
/**
 * Roughly one hint center every this many real turns of winding. Kept short
 * on purpose: hints are widely separated clusters of at most HINT_SPAN_TURNS
 * adjacent turns each, so raising their overall count doesn't reintroduce
 * the black-mass risk (that came from EVERY turn touching its neighbour;
 * these are isolated islands with plenty of smooth envelope between them) --
 * but too few of them reads as a smooth pole with a handful of decorative
 * rings ("bamboo joints") rather than a continuously wound cable.
 */
const HINT_SPACING_TURNS = 6;
const MIN_HINTS = 3;
const MAX_HINTS = 40;
/**
 * A hint must protrude past the envelope by enough world-space distance to
 * clear the line-art edge pass's depth-step threshold (a few pixels' worth
 * of the model's on-screen size, docs/research.md §10b) -- otherwise it's
 * geometrically real but never actually detected as an edge. The real wire
 * radius is often far too thin for this at typical framing (a fine 0.5 mm
 * cable on a coil filling most of the canvas), so the protrusion is a
 * fraction of the layer's own radius (scale-invariant under reframing)
 * rather than the true wire radius, floored at the true radius so a
 * genuinely thick wire is never shrunk.
 */
const HINT_RADIUS_FRACTION = 0.12;

function pointAt(points: Float32Array, i: number): THREE.Vector3 {
  return new THREE.Vector3(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
}

function curveFromRange(points: Float32Array, fromSample: number, toSample: number): THREE.CatmullRomCurve3 {
  const vecs: THREE.Vector3[] = [];
  for (let i = fromSample; i <= toSample; i++) vecs.push(pointAt(points, i));
  return new THREE.CatmullRomCurve3(vecs, false, "catmullrom", 0);
}

function fullTube(path: WireLayerPath, wireRadius: number): THREE.BufferGeometry {
  const sampleCount = path.points.length / 3;
  const curve = curveFromRange(path.points, 0, sampleCount - 1);
  const tubularSegments = Math.max(sampleCount - 1, 8);
  return new THREE.TubeGeometry(curve, tubularSegments, wireRadius, TUBE_RADIAL_SEGMENTS, false);
}

/**
 * A plain cylindrical shell spanning the layer's occupied radius and height.
 * Sits at the wire's CENTERLINE radius, not its outer surface: the hint
 * tubes below reach centerline + hintRadius, so this leaves them visibly
 * proud of the smooth shell (a flush shell would make them coincide with
 * its own surface and disappear).
 */
function envelopeShell(path: WireLayerPath): THREE.BufferGeometry {
  const sampleCount = path.points.length / 3;
  const first = pointAt(path.points, 0);
  const last = pointAt(path.points, sampleCount - 1);
  const radius = Math.hypot(first.x, first.y);
  const zLo = Math.min(first.z, last.z);
  const zHi = Math.max(first.z, last.z);
  const height = Math.max(1e-3, zHi - zLo);

  const cyl = new THREE.CylinderGeometry(radius, radius, height, ENVELOPE_RADIAL_SEGMENTS, 1, true);
  // CylinderGeometry is Y-up around its own axis; the coil's axis is Z.
  cyl.rotateX(Math.PI / 2);
  cyl.translate(0, 0, (zLo + zHi) / 2);
  return cyl;
}

/**
 * How many hint turns to place, and where (in real turn-count units, `phi`)
 * their centers sit. The first and last hints are pinned so their span
 * reaches exactly `phi=0` and `phi=turns` -- the cable's start and end, per
 * the ticket review -- and the rest are evenly spaced between them (which,
 * since z is linear in phi, is also evenly spaced along the height).
 */
function hintCenters(turns: number): number[] {
  const span = Math.min(HINT_SPAN_TURNS, turns);
  if (turns <= span) return [turns / 2];

  const usableRun = turns - span; // distance between the first and last hint's centers
  const count = Math.min(MAX_HINTS, Math.max(MIN_HINTS, Math.round(usableRun / HINT_SPACING_TURNS) + 1));
  if (count === 1) return [turns / 2];

  return Array.from({ length: count }, (_, i) => span / 2 + (i * usableRun) / (count - 1));
}

/** A handful of short, full-fidelity helical tube segments sampled across the run, each a real multi-turn spiral (see HINT_SPAN_TURNS). */
function hintTubes(path: WireLayerPath, hintRadius: number): THREE.BufferGeometry[] {
  const sampleCount = path.points.length / 3;
  if (sampleCount < 2 || path.turns <= 0) return [];

  const samplesPerTurn = (sampleCount - 1) / path.turns;
  const halfSpanSamples = Math.max(1, Math.round((Math.min(HINT_SPAN_TURNS, path.turns) / 2) * samplesPerTurn));

  const tubes: THREE.BufferGeometry[] = [];
  for (const centerPhi of hintCenters(path.turns)) {
    const center = Math.round((centerPhi / path.turns) * (sampleCount - 1));
    const from = Math.max(0, center - halfSpanSamples);
    const to = Math.min(sampleCount - 1, center + halfSpanSamples);
    if (to <= from) continue;
    const curve = curveFromRange(path.points, from, to);
    tubes.push(new THREE.TubeGeometry(curve, Math.max(to - from, 4), hintRadius, TUBE_RADIAL_SEGMENTS, false));
  }
  return tubes;
}

/**
 * Build one merged BufferGeometry per layer. Below TURNS_FOR_ENVELOPE turns
 * this is the full wound tube; above it, an envelope shell plus a few hint
 * tubes (see file header).
 */
export function buildWireGeometries(wirePaths: WireLayerPath[], wireRadius: number): THREE.BufferGeometry[] {
  return wirePaths.map((path) => {
    if (path.turns <= TURNS_FOR_ENVELOPE) return fullTube(path, wireRadius);

    const layerRadius = Math.hypot(path.points[0], path.points[1]);
    const hintRadius = Math.max(wireRadius, layerRadius * HINT_RADIUS_FRACTION);

    const parts = [envelopeShell(path), ...hintTubes(path, hintRadius)];
    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    return merged ?? envelopeShell(path);
  });
}
