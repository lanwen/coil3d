// Geometry-attached SVG overlays for the assembly guide (issue #17 review:
// "arrows and callouts are simple black line art: SVG overlays positioned
// from projected 3D points, so they stay attached to the geometry"). Every
// coordinate here is a FRACTION (0..1, origin top-left) of a `GuideFigure`'s
// own frame -- see src/guide/projection.ts's `projectToFigure` -- converted
// to this file's fixed viewBox units so the overlay's own aspect always
// matches `FIGURE_ASPECT` (guide.css's `.guide-figure` `aspect-ratio`),
// regardless of how wide the figure actually renders.

import { useMemo } from "react";
import type { Part, WireLayerPath } from "../core";
import { GuideFigure } from "../viewer/GuideFigure";
import type { PresetId } from "../viewer/lineArt/presets";
import * as THREE from "three";
import { computeGuideFit, explodedParts, FIGURE_ASPECT, projectToFigure, type GuideFit } from "./projection";
import { EXPLODE_GAP } from "../viewer/CoilScene";

export interface Pt {
  x: number;
  y: number;
}

const VB_H = 300;
const VB_W = VB_H * FIGURE_ASPECT;

function toVb(p: Pt): Pt {
  return { x: p.x * VB_W, y: p.y * VB_H };
}

/** The absolutely-positioned SVG layer every overlay lives in, stacked over one `GuideFigure`'s own frame. Never intercepts pointer events -- it's illustration, not UI. */
export function FigureOverlay({ children }: { children: React.ReactNode }) {
  return (
    <svg className="guide-overlay" viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <defs>
        <marker id="guide-arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto-start-reverse">
          <path d="M0 0 L8 4 L0 8 Z" fill="currentColor" />
        </marker>
      </defs>
      {children}
    </svg>
  );
}

/** A smooth polyline through 2+ projected points, with an arrowhead at the last one pointing along its own final segment -- used both for a straight two-point arrow and for a curved one traced through several points along a real path (the winding direction, the rotate arc). */
export function PolylineArrow({ points, curved = true }: { points: Pt[]; curved?: boolean }) {
  if (points.length < 2) return null;
  const vb = points.map(toVb);
  const d = curved
    ? vb.reduce((acc, p, i) => {
        if (i === 0) return `M ${p.x} ${p.y}`;
        const prev = vb[i - 1];
        const midX = (prev.x + p.x) / 2;
        const midY = (prev.y + p.y) / 2;
        return `${acc} Q ${prev.x} ${prev.y} ${midX} ${midY}`;
      }, "") + ` L ${vb[vb.length - 1].x} ${vb[vb.length - 1].y}`
    : `M ${vb.map((p) => `${p.x} ${p.y}`).join(" L ")}`;
  return <path className="guide-overlay-arrow" d={d} markerEnd="url(#guide-arrowhead)" />;
}

/** A straight arrow between two projected points -- the align->fit press direction, a leader line from a callout circle. */
export function StraightArrow({ from, to }: { from: Pt; to: Pt }) {
  return <PolylineArrow points={[from, to]} curved={false} />;
}

/** A dashed circle around a projected point -- a schematic call-out (the keyhole, a screw), not a precise measurement. */
export function CircleMark({ at, r }: { at: Pt; r: number }) {
  const c = toVb(at);
  return <circle className="guide-overlay-mark" cx={c.x} cy={c.y} r={r * VB_H} />;
}

/** A short curved twist arrow (bayonet) or a small burst of "click" ticks (snap), both anchored at a projected point (the core/cap seam) -- see pictograms.tsx's TwistIcon/ClickIcon for the same motifs at fixed, non-attached scale; this version is sized and placed from the actual model. */
export function TwistMark({ at, r }: { at: Pt; r: number }) {
  const c = toVb(at);
  const rr = r * VB_H;
  return (
    <g className="guide-overlay-arrow" transform={`translate(${c.x} ${c.y})`}>
      <path d={`M ${-rr} ${-rr * 0.3} A ${rr} ${rr} 0 1 0 ${rr * 0.2} ${-rr}`} fill="none" markerEnd="url(#guide-arrowhead)" />
    </g>
  );
}

export function ClickMark({ at, r }: { at: Pt; r: number }) {
  const c = toVb(at);
  const rr = r * VB_H;
  const ticks = [-1, 0, 1].map((i) => {
    const angle = (i * 28 * Math.PI) / 180 - Math.PI / 2;
    const x1 = c.x + Math.cos(angle) * rr * 0.5;
    const y1 = c.y + Math.sin(angle) * rr * 0.5;
    const x2 = c.x + Math.cos(angle) * rr;
    const y2 = c.y + Math.sin(angle) * rr;
    return <line key={i} className="guide-overlay-mark" x1={x1} y1={y1} x2={x2} y2={y2} />;
  });
  return <>{ticks}</>;
}

/** A single stroked line, e.g. the crossed-out "don't pull" mark over a straight arrow. */
export function SlashMark({ at, r }: { at: Pt; r: number }) {
  const c = toVb(at);
  const rr = r * VB_H;
  return <line className="guide-overlay-mark" x1={c.x - rr} y1={c.y - rr} x2={c.x + rr} y2={c.y + rr} />;
}

/**
 * The rendered CSS width `.guide-figure-row--solo` (guide.css) holds a
 * single figure to -- fixed, NOT fluid (`flex: 0 0`), specifically so a zoom
 * inset's own "how many times bigger" is a known ratio against a known
 * reference, not against whatever width flexbox happened to grow the main
 * figure to. Kept as one constant both sides read, exactly like
 * `FIGURE_ASPECT`.
 */
const HOST_FIGURE_WIDTH = 480; // CSS px

/**
 * A magnified, circular crop of the SAME figure, panned so `at` (a fraction
 * of the HOST figure) sits centred in the small window -- issue #17
 * review's "a circled zoom inset" (steps 2 and 5, the rim keyhole). Renders
 * a second, larger copy of the exact same `GuideFigure` (same parts/preset/
 * `fill` -- see the caller) inside an `overflow:hidden` circle, sized so it
 * is `zoom`x as WIDE (in real CSS px) as `HOST_FIGURE_WIDTH` -- the host
 * figure's own known rendered width -- at the SAME aspect ratio: a fraction
 * is scale-invariant (it depends only on aspect/fill/preset, all unchanged),
 * so `at` lands at the identical fraction of the bigger box too, and
 * "bigger" here is bigger than the host ACTUALLY IS, not just bigger than
 * the small window -- this crops a true higher-resolution, visually
 * magnified render of that region, not a same-scale (or, worse, smaller)
 * one that merely happens to sit behind a small round mask.
 */
export function zoomInsetStyle(insetPx: number, zoom: number, at: Pt): { wrapStyle: React.CSSProperties; innerStyle: React.CSSProperties } {
  const bigW = HOST_FIGURE_WIDTH * zoom;
  const bigH = bigW / FIGURE_ASPECT;
  const offsetX = at.x * bigW - insetPx / 2;
  const offsetY = at.y * bigH - insetPx / 2;
  return {
    wrapStyle: { width: insetPx, height: insetPx },
    innerStyle: { width: bigW, height: bigH, transform: `translate(${-offsetX}px, ${-offsetY}px)` },
  };
}

const INSET_SIZE = 100; // CSS px, the small round window's diameter
const INSET_ZOOM = 2.6; // how many times bigger than HOST_FIGURE_WIDTH the cropped render is

/** The visible circled zoom inset itself: a round, `INSET_SIZE`px window magnifying the model `INSET_ZOOM`x around `at` (a fraction of the HOST figure it's laid over), positioned at a fixed corner so it never covers the very feature it's zooming into. */
export function ZoomInset({
  parts,
  wirePaths,
  wireDiameter,
  showWire,
  preset,
  fill,
  at,
  corner = "bottom-right",
}: {
  parts: Part[];
  wirePaths?: WireLayerPath[];
  wireDiameter?: number;
  showWire?: boolean;
  preset?: PresetId;
  fill: number;
  at: Pt;
  corner?: "bottom-right" | "bottom-left";
}) {
  const { wrapStyle, innerStyle } = zoomInsetStyle(INSET_SIZE, INSET_ZOOM, at);
  return (
    <div className={`guide-zoom-inset guide-zoom-inset-${corner}`} style={wrapStyle}>
      <div className="guide-zoom-inset-inner" style={innerStyle}>
        <GuideFigure parts={parts} wirePaths={wirePaths} wireDiameter={wireDiameter} showWire={showWire} preset={preset} fill={fill} className="guide-zoom-inset-figure" />
      </div>
    </div>
  );
}

const DEFAULT_FIGURE_FILL = 0.85; // tighter than the interactive viewer's own 0.75 default -- issue #17 review: "the model fills ~70% of its figure"

export interface FigureProps {
  parts: Part[];
  wirePaths?: WireLayerPath[];
  wireDiameter?: number;
  showWire?: boolean;
  exploded?: boolean;
  preset?: PresetId;
  fill?: number;
  testId?: string;
  /** Given the ACTUAL camera fit this figure rendered at (already accounting for `exploded`'s Z-shift), returns whatever geometry-attached arrows/marks belong on top of it -- see projection.ts's `projectToFigure`. */
  renderOverlay?: (fit: GuideFit) => React.ReactNode;
  /** A world point (same posed frame as `renderOverlay`'s fit) to show a circled zoom inset of, e.g. a rim keyhole -- issue #17 review. */
  zoomInsetAt?: THREE.Vector3;
  zoomInsetCorner?: "bottom-right" | "bottom-left";
}

/**
 * One guide illustration PLUS its geometry-attached SVG overlay and/or zoom
 * inset, sharing a single computed camera fit (`computeGuideFit`) so
 * neither can ever drift from what `GuideFigure` actually draws for the
 * same parts/preset/fill (see projection.ts's file header for why this is a
 * parallel, not shared, computation).
 */
export function Figure({ parts, wirePaths, wireDiameter, showWire, exploded, preset = "iso", fill = DEFAULT_FIGURE_FILL, testId, renderOverlay, zoomInsetAt, zoomInsetCorner }: FigureProps) {
  const posedParts = useMemo(() => explodedParts(parts, exploded ?? false, EXPLODE_GAP), [parts, exploded]);
  const fit = useMemo(() => computeGuideFit(posedParts, preset, fill), [posedParts, preset, fill]);
  return (
    <div className="guide-figure-stage">
      <GuideFigure parts={parts} wirePaths={wirePaths} wireDiameter={wireDiameter} showWire={showWire} exploded={exploded} preset={preset} fill={fill} testId={testId} />
      {fit && renderOverlay && <FigureOverlay>{renderOverlay(fit)}</FigureOverlay>}
      {fit && zoomInsetAt && (
        <>
          <FigureOverlay>
            <ZoomLeader at={projectToFigure(fit, zoomInsetAt)} corner={zoomInsetCorner} />
          </FigureOverlay>
          <ZoomInset parts={posedParts} wirePaths={wirePaths} wireDiameter={wireDiameter} showWire={showWire} preset={preset} fill={fill} at={projectToFigure(fit, zoomInsetAt)} corner={zoomInsetCorner} />
        </>
      )}
    </div>
  );
}

/**
 * A schematic hatched wall plane along a figure's left edge -- issue #17
 * review's "the wall as a hatched plane" (step 6). Deliberately a FIXED 2D
 * decoration (not a projected 3D point): the interactive viewer's own
 * precise wall-mount rotation (`CoilViewer.tsx`'s `WALL_VIEW_ROTATION`) only
 * makes sense together with its exact fixed camera; reusing it here would
 * mean either editing that file (out of scope, see CoilScene.tsx's own file
 * header) or duplicating a fragile, camera-specific derivation. A flat
 * schematic wall beside the model -- like many real assembly manuals draw a
 * wall or floor -- reads clearly without either.
 */
export function WallPlane() {
  const bandW = VB_W * 0.09;
  const spacing = bandW * 0.85;
  const lines = [];
  for (let x = -VB_H; x < bandW + VB_H; x += spacing) {
    lines.push(<line key={x} className="guide-overlay-wall-hatch" x1={x} y1={0} x2={x + VB_H} y2={VB_H} />);
  }
  return (
    <g className="guide-overlay-wall">
      <clipPath id="guide-wall-clip">
        <rect x={0} y={0} width={bandW} height={VB_H} />
      </clipPath>
      <g clipPath="url(#guide-wall-clip)">{lines}</g>
      <rect className="guide-overlay-wall-border" x={0} y={0} width={bandW} height={VB_H} />
    </g>
  );
}

/** A thin leader line from the source point (on the host figure) to the zoom inset's fixed corner, plus a small dashed circle marking exactly what's being zoomed -- the two visual halves of one call-out. */
export function ZoomLeader({ at, corner = "bottom-right" }: { at: Pt; corner?: "bottom-right" | "bottom-left" }) {
  const cornerPt: Pt = corner === "bottom-right" ? { x: 0.92, y: 0.88 } : { x: 0.08, y: 0.88 };
  return (
    <>
      <CircleMark at={at} r={0.05} />
      <StraightArrow from={at} to={cornerPt} />
    </>
  );
}
