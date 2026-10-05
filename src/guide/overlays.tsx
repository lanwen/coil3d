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

export function StraightArrow({ from, to }: { from: Pt; to: Pt }) {
  return <PolylineArrow points={[from, to]} curved={false} />;
}

export function CircleMark({ at, r }: { at: Pt; r: number }) {
  const c = toVb(at);
  return <circle className="guide-overlay-mark" cx={c.x} cy={c.y} r={r * VB_H} />;
}

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

export function SlashMark({ at, r }: { at: Pt; r: number }) {
  const c = toVb(at);
  const rr = r * VB_H;
  return <line className="guide-overlay-mark" x1={c.x - rr} y1={c.y - rr} x2={c.x + rr} y2={c.y + rr} />;
}

export const HOST_FIGURE_WIDTH_PX = 480;

export function zoomInsetStyle(insetPx: number, zoom: number, at: Pt): { wrapStyle: React.CSSProperties; innerStyle: React.CSSProperties } {
  const bigW = HOST_FIGURE_WIDTH_PX * zoom;
  const bigH = bigW / FIGURE_ASPECT;
  const offsetX = at.x * bigW - insetPx / 2;
  const offsetY = at.y * bigH - insetPx / 2;
  return {
    wrapStyle: { width: insetPx, height: insetPx },
    innerStyle: { width: bigW, height: bigH, transform: `translate(${-offsetX}px, ${-offsetY}px)` },
  };
}

export function zoomForWindowMm(fit: GuideFit, insetPx: number, windowMm: number): number {
  const hostFigureWidthMm = 2 * fit.halfHeight * fit.aspect;
  return (insetPx * hostFigureWidthMm) / (HOST_FIGURE_WIDTH_PX * windowMm);
}

const INSET_DIAMETER_PX = 100;
const INSET_ZOOM = 2.6;

export function ZoomInset({
  parts,
  wirePaths,
  wireDiameter,
  showWire,
  preset,
  fill,
  at,
  corner = "bottom-right",
  zoom = INSET_ZOOM,
  size = INSET_DIAMETER_PX,
}: {
  parts: Part[];
  wirePaths?: WireLayerPath[];
  wireDiameter?: number;
  showWire?: boolean;
  preset?: PresetId;
  fill: number;
  at: Pt;
  corner?: "bottom-right" | "bottom-left" | "top-right";
  zoom?: number;
  size?: number;
}) {
  const { wrapStyle, innerStyle } = zoomInsetStyle(size, zoom, at);
  return (
    <div className={`guide-zoom-inset guide-zoom-inset-${corner}`} style={wrapStyle}>
      <div className="guide-zoom-inset-inner" style={innerStyle}>
        <GuideFigure parts={parts} wirePaths={wirePaths} wireDiameter={wireDiameter} showWire={showWire} preset={preset} fill={fill} className="guide-zoom-inset-figure" />
      </div>
    </div>
  );
}

const DEFAULT_FIGURE_FILL = 0.85;

export interface FigureProps {
  parts: Part[];
  wirePaths?: WireLayerPath[];
  wireDiameter?: number;
  showWire?: boolean;
  exploded?: boolean;
  preset?: PresetId;
  fill?: number;
  testId?: string;
  renderOverlay?: (fit: GuideFit) => React.ReactNode;
  zoomInsetAt?: THREE.Vector3;
  zoomInsetCorner?: "bottom-right" | "bottom-left";
  zoomInsetWindowMm?: number;
}

export function Figure({ parts, wirePaths, wireDiameter, showWire, exploded, preset = "iso", fill = DEFAULT_FIGURE_FILL, testId, renderOverlay, zoomInsetAt, zoomInsetCorner, zoomInsetWindowMm }: FigureProps) {
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
          <ZoomInset
            parts={posedParts}
            wirePaths={wirePaths}
            wireDiameter={wireDiameter}
            showWire={showWire}
            preset={preset}
            fill={fill}
            at={projectToFigure(fit, zoomInsetAt)}
            corner={zoomInsetCorner}
            zoom={zoomInsetWindowMm ? zoomForWindowMm(fit, INSET_DIAMETER_PX, zoomInsetWindowMm) : undefined}
          />
        </>
      )}
    </div>
  );
}

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

function lerpPt(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function WallQuad({ corners }: { corners: [Pt, Pt, Pt, Pt] }) {
  const vb = corners.map(toVb) as [Pt, Pt, Pt, Pt];
  const pointsAttr = vb.map((p) => `${p.x},${p.y}`).join(" ");
  const hatchCount = 5;
  const hatches = Array.from({ length: hatchCount - 1 }, (_, i) => {
    const t = (i + 1) / hatchCount;
    const p1 = lerpPt(vb[0], vb[1], t);
    const p2 = lerpPt(vb[3], vb[2], t);
    return <line key={t} className="guide-overlay-wall-hatch" x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} />;
  });
  const clipId = "guide-wallquad-clip";
  return (
    <g className="guide-overlay-wall">
      <clipPath id={clipId}>
        <polygon points={pointsAttr} />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>{hatches}</g>
      <polygon className="guide-overlay-wall-border" points={pointsAttr} />
    </g>
  );
}

export function CornerInset({ children, corner = "bottom-right", size = INSET_DIAMETER_PX }: { children: React.ReactNode; corner?: "bottom-right" | "bottom-left"; size?: number }) {
  return (
    <div className={`guide-zoom-inset guide-zoom-inset-${corner}`} style={{ width: size, height: size }}>
      {children}
    </div>
  );
}

export function SlotOutlines({ slots }: { slots: Pt[][] }) {
  return (
    <g className="guide-overlay-slots">
      {slots.map((pts, i) => (
        <polygon key={i} className="guide-overlay-slot" points={pts.map((p) => `${toVb(p).x},${toVb(p).y}`).join(" ")} />
      ))}
    </g>
  );
}

export function InsetMark({ at }: { at: Pt }) {
  return <div className="guide-inset-mark" style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }} />;
}

export function ZoomLeader({ at, corner = "bottom-right" }: { at: Pt; corner?: "bottom-right" | "bottom-left" | "top-right" }) {
  const cornerPt: Pt = corner === "bottom-right" ? { x: 0.92, y: 0.88 } : corner === "top-right" ? { x: 0.92, y: 0.12 } : { x: 0.08, y: 0.88 };
  return (
    <>
      <CircleMark at={at} r={0.05} />
      <StraightArrow from={at} to={cornerPt} />
    </>
  );
}
