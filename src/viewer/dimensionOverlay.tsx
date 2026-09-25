// IKEA-style overall-dimension lines (issue #50): the assembled coil's
// overall width/diameter and height, in cm, drawn as thin line-art
// dimension arrows next to the model -- attached to PROJECTED POINTS ON THE
// MODEL'S OWN REAL AXES, so the labels stay semantically correct in every
// preset, including the wall-mount pose (PR #59 review: a screen-space
// bounding-box version got this wrong -- in the wall-mount pose the coil's
// axis points roughly at the camera, so the screen-vertical span is the
// ~diameter, not the height; labelling whatever happens to be vertical on
// screen "height" was flatly wrong there).
//
// The height dimension runs along the coil's own local +Z axis (flange to
// cap); the width/diameter runs across the flange along local +/-X (shapes.
// ts's own t=0 reference direction -- the same convention CoilViewer's
// `debugFocusInnerEnd` and wire.ts's inner-end azimuth already key off of).
// Both anchor pairs are pure LOCAL-frame math (length = the exact physical
// mm value; position is schematic, like the guide's own approxRimPoint --
// not a mesh sample), rotated by the SAME `rotation` CoilViewer applies to
// the rendered geometry for the current view, then projected through this
// component's own independent camera-fit math (see below). A dimension
// whose projected on-screen length falls below `FORESHORTEN_MIN` of its
// true length (nearly edge-on) is hidden rather than drawn misleadingly
// short -- this can't happen in practice for Front/Iso/room-side Wall
// mount alone (their fixed camera directions keep both axes comfortably
// off-axis), but a mount's own `mountAxisDeg` spins the width axis about
// the coil's own axis, so some designs really can foreshorten one of them.
//
// This is the interactive viewer's own small, independent reimplementation
// of "project a 3D point through the current camera fit", the same idea
// `src/guide/projection.ts`'s `computeGuideFit`/`projectToFigure` use for
// the guide's SVG overlays (see that file's header for why LineArtRenderer's
// `computeFit` and that module are already two independent, deliberately-
// duplicated copies of the same math -- each needs to run against a
// different kind of input at a different time). This third copy runs off
// the SAME already-rotated, already-creased `THREE.BufferGeometry[]`
// CoilViewer builds for rendering (`viewPartGeometries`, used here only to
// size the overall camera fit/scale), at ordinary React render time,
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

import { useEffect, useMemo, useRef, useState } from "react";
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

/** `point` (world/local-post-rotation space) projected to the fit's own camera-flat XY, in WORLD UNITS (mm) -- i.e. BEFORE the halfHeight/fill scaling, unlike a screen fraction. Two such points' distance is exactly "how long this segment reads on screen, in world units", which is what the foreshortening check compares against the segment's own true length. */
function flatOf(fit: Fit, point: THREE.Vector3): THREE.Vector2 {
  const v = point.clone().sub(fit.center).applyMatrix4(fit.inverse);
  return new THREE.Vector2(v.x, v.y);
}

/** A flat (world-unit) point as a CSS-pixel position within a `width`x`height` frame -- fraction (0..1, origin top-left, matching `projectToFigure`'s own convention) times the frame's own pixel size. */
function pixelOf(fit: Fit, flat: THREE.Vector2, width: number, height: number): { x: number; y: number } {
  return {
    x: (0.5 + flat.x / (2 * fit.halfWidth)) * width,
    y: (0.5 - flat.y / (2 * fit.halfHeight)) * height,
  };
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

/** A quick, deliberately-approximate text width (px) for sizing the label's paper-coloured halo behind it -- exact glyph metrics aren't worth measuring for a small schematic tag. */
function approxLabelWidth(label: string): number {
  return label.length * 6.5 + 12;
}

// A projected dimension whose on-screen length is less than this fraction of
// its own true length reads as a nearly edge-on sliver, not a usable
// dimension line -- hidden rather than drawn misleadingly short (PR #59
// review).
const FORESHORTEN_MIN = 0.25;

const MARGIN = 22; // px -- how far outside the model's own anchor points each dimension line's offset sits, before any keep-out nudging.
const TICK_GAP = 3; // px -- a small gap between the anchor point and where its extension tick begins (so ticks don't touch the model's own silhouette line).
const LABEL_HEIGHT = 16; // px

// Reserved screen regions (PR #59 review: "keep the dimension lines and
// labels clear of the overlay controls") -- approximate CSS boxes for the
// wire/explode toggles (top-left, App.css `.wire-toggle`/`.explode-toggle`)
// and the view-controls preset bar + projection toggle (top-right,
// App.css's `.view-controls`), with a little slack. Only the label's own
// anchor point is tested against these (see `nudgeClearOfControls`); a
// dimension line/tick brushing near a button's edge is a much smaller
// problem than its TEXT sitting on top of one.
function inTopLeftControls(x: number, y: number): boolean {
  return x < 190 && y < 95;
}
function inTopRightControls(x: number, y: number, width: number): boolean {
  return x > width - 130 && y < 95;
}

export interface DimensionOverlayProps {
  /** The SAME (already view-rotated, already creased) per-part geometries CoilViewer renders -- used only to size the overall camera fit (bounding sphere/extent); the dimension anchors themselves are pure local-axis math (see the file header), not read off these. */
  geometries: THREE.BufferGeometry[];
  preset: PresetId;
  fill: number;
  /** The SAME rotation CoilViewer applies to `geometries` for the current view (`null` for the standing pose) -- applied to this component's own local-axis anchor points so they land in the identical frame. */
  rotation: THREE.Matrix4 | null;
  /** The flange's own physical outer diameter, mm (`Solution.flangeSize`) -- the width/diameter dimension's value, and the local +/-X anchor points' radius. */
  widthMm: number;
  /** The assembled coil's overall height, mm (core height plus the top cap's own thickness when present) -- the height dimension's value, and the local +Z anchor points' span. */
  heightMm: number;
  shapeKind: ShapeKind;
}

/**
 * Two IKEA-style dimension lines -- one for the overall width/diameter, one
 * for the overall height -- each drawn between the PROJECTED positions of
 * two points on the model's own real axes (see the file header), offset
 * outward from the model and clear of the preset bar / wire-toggle /
 * explode-toggle. A round core's width reads as a literal diameter ("Ø");
 * sq/tri's flange envelope isn't one, so it's shown as a plain value.
 */
export function DimensionOverlay({ geometries, preset, fill, rotation, widthMm, heightMm, shapeKind }: DimensionOverlayProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const { width, height } = useSize(wrapRef);
  const aspect = width > 0 && height > 0 ? width / height : 1;
  // Walks every vertex of every part -- worth memoizing against a
  // final-resolution mesh (see CoilViewer's own `dimensionGeometries`
  // comment for why an unmemoized version measurably delayed the line-art
  // pipeline's settle frames on an unrelated re-render).
  const fit = useMemo(() => (width > 0 && height > 0 ? computeFit(geometries, preset, aspect, fill) : null), [geometries, preset, aspect, fill, width, height]);

  if (!fit) return <div ref={wrapRef} className="dimension-overlay" aria-hidden="true" />;

  const rotate = (p: THREE.Vector3) => (rotation ? p.clone().applyMatrix4(rotation) : p);

  const dims = [
    {
      testId: "dimension-height",
      valueMm: heightMm,
      label: `${formatCm(heightMm)} cm`,
      a: rotate(new THREE.Vector3(0, 0, 0)),
      b: rotate(new THREE.Vector3(0, 0, heightMm)),
    },
    {
      testId: "dimension-width",
      valueMm: widthMm,
      label: `${shapeKind === "round" ? "Ø " : ""}${formatCm(widthMm)} cm`,
      a: rotate(new THREE.Vector3(-widthMm / 2, 0, 0)),
      b: rotate(new THREE.Vector3(widthMm / 2, 0, 0)),
    },
  ];

  const frameCenter = { x: width / 2, y: height / 2 };

  const lines = dims.flatMap((dim) => {
    const flatA = flatOf(fit, dim.a);
    const flatB = flatOf(fit, dim.b);
    const projectedLen = flatA.distanceTo(flatB);
    if (dim.valueMm <= 0 || projectedLen / dim.valueMm < FORESHORTEN_MIN) return []; // nearly edge-on -- hide rather than mislead.

    const pA = pixelOf(fit, flatA, width, height);
    const pB = pixelOf(fit, flatB, width, height);
    const dx = pB.x - pA.x;
    const dy = pB.y - pA.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 1) return [];
    const ux = dx / segLen;
    const uy = dy / segLen;
    let px = -uy; // perpendicular, one of two possible directions
    let py = ux;
    const mid = { x: (pA.x + pB.x) / 2, y: (pA.y + pB.y) / 2 };
    // Point the perpendicular AWAY from the frame's own centre, so the
    // offset line sits outside the model rather than across it.
    if (px * (mid.x - frameCenter.x) + py * (mid.y - frameCenter.y) < 0) {
      px = -px;
      py = -py;
    }

    // Nudge the offset further out, up to a few tries, if the label would
    // otherwise land on top of the wire/explode toggles or the preset bar
    // (PR #59 review) -- checked on the label's own anchor (the offset
    // line's midpoint), the most visually disruptive overlap.
    let margin = MARGIN;
    for (let attempt = 0; attempt < 6; attempt++) {
      const labelX = mid.x + px * margin;
      const labelY = mid.y + py * margin;
      if (!inTopLeftControls(labelX, labelY) && !inTopRightControls(labelX, labelY, width)) break;
      margin += 20;
    }

    const offA = { x: pA.x + px * margin, y: pA.y + py * margin };
    const offB = { x: pB.x + px * margin, y: pB.y + py * margin };
    const labelPos = { x: (offA.x + offB.x) / 2, y: (offA.y + offB.y) / 2 };
    const tickA = { x: pA.x + px * TICK_GAP, y: pA.y + py * TICK_GAP };
    const tickB = { x: pB.x + px * TICK_GAP, y: pB.y + py * TICK_GAP };
    const labelW = approxLabelWidth(dim.label);

    return [
      <g key={dim.testId}>
        <line className="dimension-tick" x1={tickA.x} y1={tickA.y} x2={offA.x} y2={offA.y} />
        <line className="dimension-tick" x1={tickB.x} y1={tickB.y} x2={offB.x} y2={offB.y} />
        <line
          className="dimension-line"
          x1={offA.x}
          y1={offA.y}
          x2={offB.x}
          y2={offB.y}
          markerStart="url(#dimension-arrowhead)"
          markerEnd="url(#dimension-arrowhead)"
        />
        <g transform={`translate(${labelPos.x} ${labelPos.y})`}>
          <rect className="dimension-label-bg" x={-labelW / 2} y={-LABEL_HEIGHT / 2} width={labelW} height={LABEL_HEIGHT} />
          <text className="dimension-label" data-testid={dim.testId} x={0} y={4} textAnchor="middle">
            {dim.label}
          </text>
        </g>
      </g>,
    ];
  });

  return (
    <div ref={wrapRef} className="dimension-overlay" data-testid="dimension-overlay" aria-hidden="true">
      <svg className="dimension-overlay-svg" viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <marker id="dimension-arrowhead" markerWidth="7" markerHeight="7" refX="3.5" refY="3.5" orient="auto-start-reverse">
            <path d="M0 0 L7 3.5 L0 7 Z" fill="currentColor" />
          </marker>
        </defs>
        {lines}
      </svg>
    </div>
  );
}
