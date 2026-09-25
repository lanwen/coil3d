// IKEA-style overall-dimension lines (issue #50): the assembled coil's
// overall width/diameter and height, in cm, drawn as thin line-art
// dimension arrows next to the model -- attached to its own PROJECTED
// bounds, so they track whichever preset/wall-view is currently on screen.
//
// This is the interactive viewer's own small, independent reimplementation
// of "project a 3D bound through the current camera fit", the same idea
// `src/guide/projection.ts`'s `computeGuideFit`/`projectToFigure` use for
// the guide's SVG overlays (see that file's header for why LineArtRenderer's
// `computeFit` and that module are already two independent, deliberately-
// duplicated copies of the same math -- each needs to run against a
// different kind of input at a different time). This third copy runs off
// the SAME already-rotated, already-creased `THREE.BufferGeometry[]`
// CoilViewer builds for rendering (`viewPartGeometries`), at ordinary React
// render time, against the viewer's own LIVE pixel size (measured via
// `ResizeObserver` on this component's own wrapper, since -- unlike the
// guide's fixed-aspect printed figures -- the interactive viewer's canvas is
// a fluid CSS box). The SVG's `viewBox` is set to that same measured pixel
// size (a 1:1 unit-to-CSS-px mapping), so stroke widths and the label font
// size can just be plain small numbers and stay genuinely thin/legible at
// any viewport size, matching the line-art render's own thin-pen look,
// rather than scaling up with the model the way the guide's fixed-VB-unit
// figures deliberately do.
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

interface BoxFraction {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The model's own projected bounding box, as a fraction (0..1, origin top-left) of the frame -- mirrors LineArtRenderer's `computeFit`'s `halfHeight`/`extent*` closely enough that a box built from them always agrees with what it actually draws for the same geometry/preset/fill/aspect. */
function computeBoxFraction(geometries: THREE.BufferGeometry[], preset: PresetId, aspect: number, fill: number): BoxFraction | null {
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
  const halfWidth = halfHeight * aspect;
  const fracHalfW = extent.x / (4 * halfWidth);
  const fracHalfH = extent.y / (4 * halfHeight);
  return { left: 0.5 - fracHalfW, right: 0.5 + fracHalfW, top: 0.5 - fracHalfH, bottom: 0.5 + fracHalfH };
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

const MARGIN = 22; // px -- how far outside the model's own bounds each dimension line sits.
const TICK = 8; // px -- how far each extension tick reaches past the dimension line itself.
const LABEL_HEIGHT = 16; // px

export interface DimensionOverlayProps {
  /** The SAME (already view-rotated, already creased) per-part geometries CoilViewer renders -- see the file header for why this is what gets projected, not a second copy of the raw parts. */
  geometries: THREE.BufferGeometry[];
  preset: PresetId;
  fill: number;
  /** The flange's own physical outer diameter, mm (`Solution.flangeSize`) -- the width/diameter dimension's value. */
  widthMm: number;
  /** The assembled coil's overall height, mm (core height plus the top cap's own thickness when present). */
  heightMm: number;
  shapeKind: ShapeKind;
}

/**
 * Two IKEA-style dimension lines -- one for the overall width/diameter, one
 * for the overall height -- drawn just outside the model's own projected
 * silhouette, in the same black/white line-art style as the guide's SVG
 * overlays. A round core's width reads as a literal diameter ("Ø"); sq/tri's
 * flange envelope isn't one, so it's shown as a plain value.
 */
export function DimensionOverlay({ geometries, preset, fill, widthMm, heightMm, shapeKind }: DimensionOverlayProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const { width, height } = useSize(wrapRef);
  const aspect = width > 0 && height > 0 ? width / height : 1;
  // Walks every vertex of every part -- worth memoizing against a
  // final-resolution mesh (see CoilViewer's own `dimensionGeometries`
  // comment for why an unmemoized version measurably delayed the line-art
  // pipeline's settle frames on an unrelated re-render).
  const box = useMemo(() => (width > 0 && height > 0 ? computeBoxFraction(geometries, preset, aspect, fill) : null), [geometries, preset, aspect, fill, width, height]);

  if (!box) return <div ref={wrapRef} className="dimension-overlay" aria-hidden="true" />;

  const widthLabel = `${shapeKind === "round" ? "Ø " : ""}${formatCm(widthMm)} cm`;
  const heightLabel = `${formatCm(heightMm)} cm`;

  const left = box.left * width;
  const right = box.right * width;
  const top = box.top * height;
  const bottom = box.bottom * height;

  // Width: a horizontal line just below the model's own bottom edge, with
  // short vertical extension ticks up to the model's actual left/right
  // corners and an arrowhead at each end.
  const wY = bottom + MARGIN;
  // Height: a vertical line just left of the model's own left edge, with
  // short horizontal extension ticks to the model's actual top/bottom
  // corners and an arrowhead at each end.
  const hX = left - MARGIN;

  const widthLabelW = approxLabelWidth(widthLabel);
  const heightLabelW = approxLabelWidth(heightLabel);

  return (
    <div ref={wrapRef} className="dimension-overlay" data-testid="dimension-overlay" aria-hidden="true">
      <svg className="dimension-overlay-svg" viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <marker id="dimension-arrowhead" markerWidth="7" markerHeight="7" refX="3.5" refY="3.5" orient="auto-start-reverse">
            <path d="M0 0 L7 3.5 L0 7 Z" fill="currentColor" />
          </marker>
        </defs>

        {/* Width / diameter */}
        <line className="dimension-tick" x1={left} y1={bottom} x2={left} y2={wY + TICK} />
        <line className="dimension-tick" x1={right} y1={bottom} x2={right} y2={wY + TICK} />
        <line className="dimension-line" x1={left} y1={wY} x2={right} y2={wY} markerStart="url(#dimension-arrowhead)" markerEnd="url(#dimension-arrowhead)" />
        <g transform={`translate(${(left + right) / 2} ${wY})`}>
          <rect className="dimension-label-bg" x={-widthLabelW / 2} y={-LABEL_HEIGHT / 2} width={widthLabelW} height={LABEL_HEIGHT} />
          <text className="dimension-label" data-testid="dimension-width" x={0} y={4} textAnchor="middle">
            {widthLabel}
          </text>
        </g>

        {/* Height */}
        <line className="dimension-tick" x1={left} y1={top} x2={hX - TICK} y2={top} />
        <line className="dimension-tick" x1={left} y1={bottom} x2={hX - TICK} y2={bottom} />
        <line className="dimension-line" x1={hX} y1={top} x2={hX} y2={bottom} markerStart="url(#dimension-arrowhead)" markerEnd="url(#dimension-arrowhead)" />
        <g transform={`translate(${hX} ${(top + bottom) / 2})`}>
          <rect className="dimension-label-bg" x={-heightLabelW / 2} y={-LABEL_HEIGHT / 2} width={heightLabelW} height={LABEL_HEIGHT} />
          <text className="dimension-label" data-testid="dimension-height" x={0} y={4} textAnchor="middle">
            {heightLabel}
          </text>
        </g>
      </svg>
    </div>
  );
}
