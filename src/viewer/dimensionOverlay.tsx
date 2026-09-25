// IKEA-style overall-dimension lines (issue #50): the assembled coil's
// overall width/diameter and height, in cm, drawn technical-drawing style
// OUTSIDE the model's projected silhouette (PR #59 review: lines drawn
// across the model were unreadable).
//
// Each dimension measures along a real 3D direction of the model -- height
// along the coil's own axis, width across the flange plane (the in-plane
// direction that reads most horizontal in the current view) -- so the
// labels stay semantically right in every preset, including the wall-mount
// pose, where the axis points roughly at the camera. The measured span is
// the part meshes' own extreme planes along that direction; on each plane
// the vertex nearest the chosen side is that end's anchor. The dimension
// line runs parallel to the direction's projection, a small gap beyond the
// silhouette, with thin extension lines from the anchors, arrowheads at
// both ends and the value centred on it over a white knockout. Width goes
// below the model (with vertical extension lines when the coil axis reads
// vertical, the classic iso look), height on the right; the other side is
// the fallback when the preferred one would leave the frame, cover a
// control or cross the other dimension. A direction that projects to less
// than `FORESHORTEN_MIN` of its true length is hidden rather than drawn
// misleadingly short.
//
// Values: a round flange's width is its diameter in every direction, so it
// shows design()'s own `flangeSize` as "Ø"; square/triangle widths and the
// overall height are the extents measured off design()'s own part meshes
// (the result panel's `flangeSize` is a solver envelope, not a sq/tri
// width, and its `height` is the winding height, which leaves out the
// bottom flange and the cap).
//
// This is the interactive viewer's own small, independent reimplementation
// of "project a 3D point through the current camera fit", the same idea
// `src/guide/projection.ts`'s `computeGuideFit`/`projectToFigure` use for
// the guide's SVG overlays (see that file's header for why LineArtRenderer's
// `computeFit` and that module are already two independent, deliberately-
// duplicated copies of the same math -- each needs to run against a
// different kind of input at a different time). This third copy runs off
// the SAME already-rotated, already-creased `THREE.BufferGeometry[]`
// CoilViewer builds for rendering (`viewPartGeometries`), at ordinary
// React render time,
// against the viewer's own LIVE pixel size (measured via `ResizeObserver`
// on this component's own wrapper, since -- unlike the guide's fixed-aspect
// printed figures -- the interactive viewer's canvas is a fluid CSS box).
// The SVG's `viewBox` is set to that same measured pixel size (a 1:1
// unit-to-CSS-px mapping), so stroke widths and the label font size can
// just be plain small numbers and stay genuinely thin/legible at any
// viewport size, matching the line-art render's own thin-pen look, rather
// than scaling up with the model the way the guide's fixed-VB-unit figures
// deliberately do.
//
// Deliberately NOT frame-synced with LineArtRenderer's own slerp/scale
// tweens: this recomputes its target fit whenever the geometry/preset/fill
// settle, so a preset switch's dimension lines "snap" to the new pose
// slightly ahead of the model's own eased camera. That's an acceptable
// tradeoff for a supplementary annotation, not the model's own render.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { ShapeKind } from "../core";
import { getPreset, type PresetId } from "./lineArt/presets";

interface Fit {
  center: THREE.Vector3;
  inverse: THREE.Matrix4; // world -> camera-flat (XY), orthonormal (inverse === transpose)
  halfHeight: number;
  halfWidth: number;
}

/** The SAME camera-fit math `LineArtRenderer.tsx`'s `computeFit` uses (bounding-sphere-relative bounds, `halfHeight = extent/(2*fill)`), reimplemented here (see the file header for why) so this component can project ARBITRARY points -- not just the model's own bounding box -- through an equivalent fit. */
function computeFit(geometries: THREE.BufferGeometry[], preset: PresetId, aspect: number, fill: number): Fit | null {
  const direction = getPreset(preset).direction;
  const up = getPreset(preset).upHint;
  const rotation = new THREE.Matrix4().lookAt(direction, new THREE.Vector3(0, 0, 0), up);
  const inverse = rotation.clone().transpose(); // orthonormal: inverse === transpose

  const box = new THREE.Box3();
  for (const geo of geometries) {
    geo.computeBoundingBox();
    if (geo.boundingBox) box.union(geo.boundingBox);
  }
  if (box.isEmpty()) return null;
  const center = box.getCenter(new THREE.Vector3());

  const bounds = new THREE.Box2();
  const v = new THREE.Vector3();
  for (const geo of geometries) {
    const pos = geo.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) continue;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).sub(center).applyMatrix4(inverse);
      bounds.expandByPoint(new THREE.Vector2(v.x, v.y));
    }
  }
  const extent = bounds.getSize(new THREE.Vector2());
  if (extent.x <= 0 && extent.y <= 0) return null;

  const halfHeight = Math.max(extent.y / 2, extent.x / 2 / aspect) / fill;
  return { center, inverse, halfHeight, halfWidth: halfHeight * aspect };
}

/** The wrapper's own live pixel size, via `ResizeObserver` -- the interactive viewer's canvas is a fluid box (unlike the guide's fixed-aspect printed figures), so both the projection's aspect ratio and the SVG's own `viewBox` (a 1:1 unit-to-CSS-px mapping, see the file header) have to be measured, not assumed.
 *
 * Rounded to whole CSS pixels, and only committed to state when that rounded
 * size actually changes: `ResizeObserver`'s own `contentRect` can report
 * sub-pixel float jitter (e.g. 583.99...7 vs 584.00...2) across successive
 * callbacks with NO real layout change, which -- unrounded -- would still
 * shift this component's own SVG output by a hairline and re-render it. This
 * overlay visually sits directly on top of the canvas (see the file
 * header), which is the SAME screen region several existing e2e suites take
 * an EXACT byte-for-byte `canvas.screenshot()` of (e.g. "a drag started on
 * the background must not orbit the camera" -- nothing about the design
 * changes there, so nothing here should re-render either); an unrounded,
 * always-committing version measurably reintroduced flakiness in exactly
 * that kind of check. */
function useSize(ref: React.RefObject<HTMLDivElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      const w = Math.round(width);
      const h = Math.round(height);
      setSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function formatCm(mm: number): string {
  return (mm / 10).toFixed(1);
}

interface Pt {
  x: number;
  y: number;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** One dimension, laid out in CSS px: two extension lines, the dimension line itself, and its label's centre/rotation. */
interface DimensionLayout {
  testId: string;
  label: string;
  extensions: [Pt, Pt][];
  line: [Pt, Pt];
  labelAt: Pt;
  labelAngle: number; // degrees, always kept upright (-90..90]
  labelWidth: number;
}

// A projected dimension whose on-screen length is less than this fraction of
// its own true length reads as a nearly edge-on sliver, not a usable
// dimension line -- hidden rather than drawn misleadingly short (PR #59
// review).
const FORESHORTEN_MIN = 0.25;

const GAP = 18; // px -- clearance between the model's projected silhouette and the dimension line
const EXT_GAP = 3; // px -- extension lines start this far off the model, so they don't touch its outline
const EXT_OVERSHOOT = 5; // px -- extension lines run this far past the dimension line (drafting convention)
const LABEL_HEIGHT = 16; // px
const ARROW_LENGTH = 9; // px -- see the marker in the SVG below
const FRAME_INSET = 4; // px -- everything must stay this far inside the viewer frame
const PLANE_EPS = 0.5; // mm -- how close to an extreme plane a vertex must be to count as "on" it
const RESERVED_SLACK = 6; // px around each overlay control

// Candidate width directions, degrees from local +X in the flange plane; the
// overlay measures along whichever reads most horizontal in the current view.
// A candidate must read at least WIDTH_MIN_LEN of its true length on screen
// (a steeply foreshortened direction reads badly even when it is the most
// horizontal one).
const WIDTH_ANGLES = Array.from({ length: 36 }, (_, i) => i * 5);
const WIDTH_MIN_LEN = 0.5;

/** A quick, deliberately-approximate text width (px) for sizing the label's knockout -- exact glyph metrics aren't worth measuring for a small schematic tag. */
function approxLabelWidth(label: string): number {
  return label.length * 6.5 + 10;
}

// The viewer's own overlay controls (wire/explode toggles, the preset bar,
// the wall-view caption) -- measured live from the DOM, relative to this
// overlay, so dimensions keep clear of them at any viewport width (PR #59
// review).
const RESERVED_SELECTORS = ".wire-toggle, .explode-toggle, .view-controls, .wall-view-caption";

function measureReserved(el: HTMLElement): Rect[] {
  const host = el.closest(".viewer") ?? el.parentElement;
  if (!host) return [];
  const origin = el.getBoundingClientRect();
  return Array.from(host.querySelectorAll(RESERVED_SELECTORS)).map((node) => {
    const r = node.getBoundingClientRect();
    return {
      left: Math.round(r.left - origin.left) - RESERVED_SLACK,
      top: Math.round(r.top - origin.top) - RESERVED_SLACK,
      right: Math.round(r.right - origin.left) + RESERVED_SLACK,
      bottom: Math.round(r.bottom - origin.top) + RESERVED_SLACK,
    };
  });
}

/**
 * Sample points covering a layout's line, extension lines and label box --
 * enough to test it against the frame, the controls, the other dimension
 * and the model itself. `skipNearModel` drops each extension line's first
 * few px, which start right at the silhouette by design; `withExtensions`
 * false leaves the extension lines out altogether.
 */
function samplesOf(layout: DimensionLayout, skipNearModel = false, withExtensions = true): Pt[] {
  const out: Pt[] = [];
  const segment = ([a, b]: [Pt, Pt], skip = 0) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / 3));
    for (let i = 0; i <= steps; i++) {
      if ((len * i) / steps < skip) continue;
      out.push({ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps });
    }
  };
  segment(layout.line);
  if (withExtensions) for (const ext of layout.extensions) segment(ext, skipNearModel ? 2 * MASK_CELL : 0);
  const rad = (layout.labelAngle * Math.PI) / 180;
  const ux = { x: Math.cos(rad), y: Math.sin(rad) };
  const uy = { x: -ux.y, y: ux.x };
  for (let u = -layout.labelWidth / 2; u <= layout.labelWidth / 2; u += 4) {
    for (let v = -LABEL_HEIGHT / 2; v <= LABEL_HEIGHT / 2; v += 4) {
      out.push({ x: layout.labelAt.x + ux.x * u + uy.x * v, y: layout.labelAt.y + ux.y * u + uy.y * v });
    }
  }
  return out;
}

/** How badly a candidate layout misbehaves: points outside the frame, on a control, on the model, or too close to an already-placed dimension. 0 is clean. */
function penaltyOf(layout: DimensionLayout, projected: Projected, width: number, height: number, reserved: Rect[], placed: DimensionLayout[]): number {
  let penalty = 0;
  for (const p of samplesOf(layout)) {
    if (p.x < FRAME_INSET || p.y < FRAME_INSET || p.x > width - FRAME_INSET || p.y > height - FRAME_INSET) penalty += 2;
    if (reserved.some((r) => p.x > r.left && p.x < r.right && p.y > r.top && p.y < r.bottom)) penalty += 2;
  }
  // Nothing may touch another dimension's line or label; two extension
  // lines meeting (at a shared corner, say) is fine.
  const near = (ps: Pt[], qs: Pt[]) => ps.filter((p) => qs.some((q) => Math.abs(q.x - p.x) < 4 && Math.abs(q.y - p.y) < 4)).length;
  for (const other of placed) {
    penalty += 4 * near(samplesOf(layout), samplesOf(other, false, false));
    penalty += 4 * near(samplesOf(layout, false, false), samplesOf(other));
  }
  for (const p of samplesOf(layout, true)) if (onModel(projected, p)) penalty += 2;
  return penalty;
}

// The model's projected footprint, rasterized into MASK_CELL-px cells, so a
// layout can be checked for crossing the model (e.g. an extension line
// that would cut across it from a hidden extreme point).
const MASK_CELL = 3; // px

/** Every vertex of every part (then of the wound cable), in world space and projected to viewer CSS px, plus the projected footprint mask. */
interface Projected {
  world: Float32Array; // xyz per vertex
  screen: Float32Array; // xy per vertex
  count: number;
  /** Vertices [0, partCount) belong to the parts -- the only ones measured; the cable after them only counts toward the silhouette. */
  partCount: number;
  mask: Uint8Array;
  maskWidth: number;
  maskHeight: number;
}

function coveredCell(projected: Projected, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < projected.maskWidth && y < projected.maskHeight && projected.mask[y * projected.maskWidth + x] === 1;
}

function covered(projected: Projected, p: Pt): boolean {
  return coveredCell(projected, Math.floor(p.x / MASK_CELL), Math.floor(p.y / MASK_CELL));
}

/** Whether `p` is well inside the model's footprint: its cell and all four neighbours are covered, so a line merely grazing the silhouette doesn't count. */
function onModel(projected: Projected, p: Pt): boolean {
  const cx = Math.floor(p.x / MASK_CELL);
  const cy = Math.floor(p.y / MASK_CELL);
  return [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]].every(([dx, dy]) => coveredCell(projected, cx + dx, cy + dy));
}

function projectAll(parts: THREE.BufferGeometry[], cable: THREE.BufferGeometry[], fit: Fit, width: number, height: number): Projected {
  const geometries = [...parts, ...cable];
  let count = 0;
  let partCount = 0;
  for (const geo of geometries) count += geo.getAttribute("position")?.count ?? 0;
  for (const geo of parts) partCount += geo.getAttribute("position")?.count ?? 0;
  const world = new Float32Array(count * 3);
  const screen = new Float32Array(count * 2);
  const maskWidth = Math.ceil(width / MASK_CELL);
  const maskHeight = Math.ceil(height / MASK_CELL);
  const mask = new Uint8Array(maskWidth * maskHeight);
  const v = new THREE.Vector3();
  let i = 0;
  for (const geo of geometries) {
    const pos = geo.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) continue;
    const base = i;
    for (let k = 0; k < pos.count; k++, i++) {
      v.fromBufferAttribute(pos, k);
      world[i * 3] = v.x;
      world[i * 3 + 1] = v.y;
      world[i * 3 + 2] = v.z;
      v.sub(fit.center).applyMatrix4(fit.inverse);
      screen[i * 2] = (0.5 + v.x / (2 * fit.halfWidth)) * width;
      screen[i * 2 + 1] = (0.5 - v.y / (2 * fit.halfHeight)) * height;
    }
    // Rasterize every triangle's cell centres into the mask.
    const index = geo.getIndex();
    const triCount = index ? index.count / 3 : pos.count / 3;
    for (let t = 0; t < triCount; t++) {
      const [a, b, c] = [0, 1, 2].map((j) => base + (index ? index.getX(t * 3 + j) : t * 3 + j));
      const ax = screen[a * 2], ay = screen[a * 2 + 1];
      const bx = screen[b * 2], by = screen[b * 2 + 1];
      const cx = screen[c * 2], cy = screen[c * 2 + 1];
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-6) continue;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) / MASK_CELL));
      const x1 = Math.min(maskWidth - 1, Math.floor(Math.max(ax, bx, cx) / MASK_CELL));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy) / MASK_CELL));
      const y1 = Math.min(maskHeight - 1, Math.floor(Math.max(ay, by, cy) / MASK_CELL));
      for (let my = y0; my <= y1; my++) {
        const py = (my + 0.5) * MASK_CELL;
        for (let mx = x0; mx <= x1; mx++) {
          if (mask[my * maskWidth + mx]) continue;
          const px = (mx + 0.5) * MASK_CELL;
          const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
          const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
          if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) mask[my * maskWidth + mx] = 1;
        }
      }
    }
  }
  return { world, screen, count, partCount, mask, maskWidth, maskHeight };
}

/**
 * Lays out one dimension along the world-space unit `axis` (projecting to
 * the screen unit direction `d`), drafting-style, with its extension lines
 * running along the screen unit direction `e` (any direction not parallel
 * to `d`: the screen normal, or a projected model axis for the classic
 * iso look of vertical extension lines):
 *
 * - the measured extent is the model's own extreme planes along `axis`;
 * - on each plane, the vertex furthest toward `e` is that end's anchor;
 * - the dimension line runs parallel to `d`, `GAP` beyond every projected
 *   vertex that lies within its span (in the oblique d/e frame), so it
 *   clears the model's silhouette entirely;
 * - the extension lines run from the anchors (or, for a hidden anchor, from
 *   where their path leaves the model) along `e` to just past the line.
 */
function layoutAlong(projected: Projected, axis: THREE.Vector3, d: Pt, e: Pt, testId: string, labelFor: (extentMm: number) => string): DimensionLayout | null {
  const { world, screen, count, partCount } = projected;
  // Oblique coordinates: screen point p = s*d + k*e.
  const det = d.x * e.y - d.y * e.x;
  if (Math.abs(det) < 0.2) return null;
  const sOf = (i: number) => (screen[i * 2] * e.y - screen[i * 2 + 1] * e.x) / det;
  const kOf = (i: number) => (d.x * screen[i * 2 + 1] - d.y * screen[i * 2]) / det;
  const cOf = (i: number) => world[i * 3] * axis.x + world[i * 3 + 1] * axis.y + world[i * 3 + 2] * axis.z;

  let cMin = Infinity;
  let cMax = -Infinity;
  for (let i = 0; i < partCount; i++) {
    const c = cOf(i);
    if (c < cMin) cMin = c;
    if (c > cMax) cMax = c;
  }
  let a = -1;
  let b = -1;
  for (let i = 0; i < partCount; i++) {
    const c = cOf(i);
    if (c <= cMin + PLANE_EPS && (a < 0 || kOf(i) > kOf(a))) a = i;
    if (c >= cMax - PLANE_EPS && (b < 0 || kOf(i) > kOf(b))) b = i;
  }
  if (a < 0 || b < 0) return null;

  const sLo = Math.min(sOf(a), sOf(b)) - ARROW_LENGTH;
  const sHi = Math.max(sOf(a), sOf(b)) + ARROW_LENGTH;
  let kClear = Math.max(kOf(a), kOf(b));
  for (let i = 0; i < count; i++) {
    const s = sOf(i);
    if (s >= sLo && s <= sHi) kClear = Math.max(kClear, kOf(i));
  }
  const kLine = kClear + GAP;

  const anchor = (i: number) => {
    const p = { x: screen[i * 2], y: screen[i * 2 + 1] };
    const k0 = kOf(i);
    const along = (k: number) => ({ x: p.x + e.x * k, y: p.y + e.y * k });
    // Drafting convention: the extension line starts a small gap off the
    // VISIBLE outline -- so from a hidden extreme point, it starts where its
    // path last leaves the model's footprint, rather than crossing it.
    let exit = 0;
    for (let k = 0; k < kLine - k0; k += 1.5) if (covered(projected, along(k))) exit = k;
    return { from: along(exit + EXT_GAP), onLine: along(kLine - k0), past: along(kLine - k0 + EXT_OVERSHOOT) };
  };
  const ea = anchor(a);
  const eb = anchor(b);
  const label = labelFor(cMax - cMin);
  // Keep the label upright: vertical text reads bottom-to-top.
  let angle = (Math.atan2(d.y, d.x) * 180) / Math.PI;
  if (angle >= 90) angle -= 180;
  if (angle < -90) angle += 180;
  return {
    testId,
    label,
    extensions: [
      [ea.from, ea.past],
      [eb.from, eb.past],
    ],
    line: [ea.onLine, eb.onLine],
    labelAt: { x: (ea.onLine.x + eb.onLine.x) / 2, y: (ea.onLine.y + eb.onLine.y) / 2 },
    labelAngle: angle,
    labelWidth: approxLabelWidth(label),
  };
}

export interface DimensionOverlayProps {
  /** The SAME (already view-rotated, already creased) per-part geometries CoilViewer renders -- they size the camera fit, and every dimension is measured and placed off their vertices. */
  geometries: THREE.BufferGeometry[];
  /** The wound cable's (already view-rotated) tube geometries, when shown -- part of the silhouette the dimensions keep clear of, never measured. */
  cableGeometries: THREE.BufferGeometry[];
  preset: PresetId;
  fill: number;
  /** The SAME rotation CoilViewer applies to `geometries` for the current view (`null` for the standing pose) -- applied to the local width/axis directions so they land in the identical frame. */
  rotation: THREE.Matrix4 | null;
  /** `Solution.flangeSize`, mm -- shown as a round flange's "Ø" (its true diameter). */
  widthMm: number;
  shapeKind: ShapeKind;
}

/**
 * Two IKEA-style dimensions -- overall width/diameter and overall height --
 * laid out drafting-style outside the model's silhouette (see the file
 * header), clear of the viewer's own overlay controls.
 */
export function DimensionOverlay({ geometries, cableGeometries, preset, fill, rotation, widthMm, shapeKind }: DimensionOverlayProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const { width, height } = useSize(wrapRef);
  const aspect = width > 0 && height > 0 ? width / height : 1;
  // Walks every vertex of every part -- worth memoizing against a
  // final-resolution mesh (see CoilViewer's own `dimensionGeometries`
  // comment for why an unmemoized version measurably delayed the line-art
  // pipeline's settle frames on an unrelated re-render).
  const fit = useMemo(() => (width > 0 && height > 0 ? computeFit(geometries, preset, aspect, fill) : null), [geometries, preset, aspect, fill, width, height]);

  // The controls' boxes move with the viewport and the preset (the wall
  // caption), so re-measure after each of those; only commit a real change,
  // so a steady view never re-renders (see useSize for why that matters).
  const [reserved, setReserved] = useState<Rect[]>([]);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const next = measureReserved(el);
    setReserved((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [width, height, preset]);

  const layouts = useMemo(() => {
    if (!fit) return [];
    const projected = projectAll(geometries, cableGeometries, fit, width, height);
    const toWorld = (local: THREE.Vector3) => (rotation ? local.clone().transformDirection(rotation) : local);
    // A world direction on screen: unit direction (y down) plus its
    // projected length (1 = parallel to the screen, 0 = edge-on).
    // `fit.inverse` is a pure rotation, so a unit direction stays one.
    const onScreen = (dir: THREE.Vector3) => {
      const f = dir.clone().applyMatrix4(fit.inverse);
      const len = Math.hypot(f.x, f.y);
      return { dir: len > 0 ? { x: f.x / len, y: -f.y / len } : { x: 0, y: 0 }, len };
    };
    const flip = (p: Pt) => ({ x: -p.x, y: -p.y });

    const coilAxis = toWorld(new THREE.Vector3(0, 0, 1));
    const axial = onScreen(coilAxis);
    const axialDown = axial.dir.y >= 0 ? axial.dir : flip(axial.dir);

    // Width runs across the flange, along the most horizontal-reading
    // in-plane direction (the rest, less horizontal first, are fallbacks
    // for when it doesn't fit).
    const widthAxes = WIDTH_ANGLES.map((deg) => toWorld(new THREE.Vector3(Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0)))
      .filter((dir) => onScreen(dir).len >= WIDTH_MIN_LEN)
      .sort((p, q) => Math.abs(onScreen(q).dir.x) - Math.abs(onScreen(p).dir.x));

    const dims = [
      // Width first, below the model -- the classic place for it; height
      // then takes whichever side stays clear of it. A round flange's width
      // is its diameter in every direction, so it shows design()'s own
      // `flangeSize`; a square/triangle flange's width depends on the
      // direction, so it shows the extent actually measured along the drawn
      // line (the result panel's `flangeSize` is the solver's envelope,
      // not any real sq/tri flange width -- see the file header).
      {
        testId: "dimension-width",
        axes: widthAxes,
        labelFor: (extentMm: number) => (shapeKind === "round" ? `Ø ${formatCm(widthMm)} cm` : `${formatCm(extentMm)} cm`),
        down: true,
      },
      { testId: "dimension-height", axes: [coilAxis], labelFor: (extentMm: number) => `${formatCm(extentMm)} cm`, down: false },
    ];
    // Greedy placement, one dimension at a time, each avoiding those already
    // placed; tried in both orders when the first leaves a conflict (a
    // cramped phone-width frame), keeping the cleaner result.
    const place = (order: typeof dims) => {
      const placed: DimensionLayout[] = [];
      let total = 0;
      for (const dim of order) {
        let best: { layout: DimensionLayout; penalty: number } | null = null;
        for (const axis of dim.axes) {
          const { dir: d, len } = onScreen(axis);
          if (len < FORESHORTEN_MIN) continue; // nearly edge-on -- hide rather than mislead.
          let n = { x: -d.y, y: d.x };
          if ((dim.down ? n.y : n.x) < 0) n = flip(n);
          // Extension-line directions, preferred first. Width: along the
          // coil's own axis when that reads as straight down on screen (the
          // classic iso look: vertical extension lines, the line parallel to
          // the flange's own edge), else the screen normal, below. Height:
          // the screen normal, right side first. The opposite side is only a
          // fallback for when the preferred one would leave the frame, sit
          // on a control or cross the other dimension.
          const sides: Pt[] = [n, flip(n)];
          if (dim.down && axial.len >= FORESHORTEN_MIN && axialDown.y > 0.8 && Math.abs(d.x * axialDown.y - d.y * axialDown.x) >= 0.8) sides.unshift(axialDown);
          for (const side of sides) {
            const layout = layoutAlong(projected, axis, d, side, dim.testId, dim.labelFor);
            if (!layout) continue;
            const penalty = penaltyOf(layout, projected, width, height, reserved, placed);
            if (!best || penalty < best.penalty) best = { layout, penalty };
            if (penalty === 0) break;
          }
          if (best?.penalty === 0) break;
        }
        if (best) {
          placed.push(best.layout);
          total += best.penalty;
        }
      }
      return { placed, total };
    };
    const first = place(dims);
    if (first.total === 0) return first.placed;
    const second = place([...dims].reverse());
    // Keep the width-then-height DOM order either way.
    return (second.total < first.total ? second.placed.reverse() : first.placed);
  }, [fit, geometries, cableGeometries, width, height, rotation, widthMm, shapeKind, reserved]);

  if (!fit) return <div ref={wrapRef} className="dimension-overlay" aria-hidden="true" />;

  const lines = layouts.map((layout) => (
    <g key={layout.testId}>
      {layout.extensions.map(([a, b], i) => (
        <line key={i} className="dimension-extension" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
      ))}
      <line
        className="dimension-line"
        x1={layout.line[0].x}
        y1={layout.line[0].y}
        x2={layout.line[1].x}
        y2={layout.line[1].y}
        markerStart="url(#dimension-arrowhead)"
        markerEnd="url(#dimension-arrowhead)"
      />
      <g transform={`translate(${layout.labelAt.x} ${layout.labelAt.y}) rotate(${layout.labelAngle})`}>
        <rect className="dimension-label-bg" x={-layout.labelWidth / 2} y={-LABEL_HEIGHT / 2} width={layout.labelWidth} height={LABEL_HEIGHT} />
        <text className="dimension-label" data-testid={layout.testId} x={0} y={1} textAnchor="middle">
          {layout.label}
        </text>
      </g>
    </g>
  ));

  return (
    <div ref={wrapRef} className="dimension-overlay" data-testid="dimension-overlay" aria-hidden="true">
      <svg className="dimension-overlay-svg" viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <marker id="dimension-arrowhead" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="7" refX="9" refY="3.5" orient="auto-start-reverse">
            <path d="M0 0.5 L9 3.5 L0 6.5 Z" fill="currentColor" />
          </marker>
        </defs>
        {lines}
      </svg>
    </div>
  );
}
