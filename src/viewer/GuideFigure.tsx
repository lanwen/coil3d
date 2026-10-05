import { useEffect, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { Part, WireLayerPath } from "../core";
import { CoilScene } from "./CoilScene";
import { kickInvalidate } from "./lineArt/LineArtRenderer";
import type { PresetId } from "./lineArt/presets";
import { ViewerBoundary, useThrowOnContextLoss } from "./ViewerBoundary";

const VISIBLE_MARGIN = "200px 0px";
const RENDER_ALL_TIMEOUT_MS = 5000;
const AFTER_LINE_ART_FRAME_PRIORITY = 2;

const figures = new Set<{ activate: () => void; drawn: Promise<void> }>();

export async function renderAllGuideFigures(): Promise<void> {
  const all = [...figures];
  all.forEach((f) => f.activate());
  await Promise.race([Promise.all(all.map((f) => f.drawn)), new Promise((resolve) => window.setTimeout(resolve, RENDER_ALL_TIMEOUT_MS))]);
}

export interface GuideFigureProps {
  parts: Part[];
  wirePaths?: WireLayerPath[];
  wireDiameter?: number;
  showWire?: boolean;
  exploded?: boolean;
  preset?: PresetId;
  fill?: number;
  className?: string;
  testId?: string;
}

export function GuideFigure({ parts, wirePaths, wireDiameter, showWire = false, exploded = false, preset, fill, className, testId }: GuideFigureProps) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={frameRef} className={className ?? "guide-figure"} data-testid={testId} data-rendered="false">
      <ViewerBoundary fallback={<p className="guide-figure-unavailable">Illustration unavailable in this browser.</p>}>
        <GuideCanvas frameRef={frameRef} parts={parts} wirePaths={wirePaths} wireDiameter={wireDiameter} showWire={showWire} exploded={exploded} preset={preset} fill={fill} controlsRef={controlsRef} />
      </ViewerBoundary>
    </div>
  );
}

interface GuideCanvasProps extends Pick<GuideFigureProps, "parts" | "wirePaths" | "wireDiameter" | "showWire" | "exploded" | "preset" | "fill"> {
  frameRef: React.RefObject<HTMLDivElement | null>;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}

function GuideCanvas({ frameRef, parts, wirePaths, wireDiameter, showWire, exploded, preset, fill, controlsRef }: GuideCanvasProps) {
  const onCanvasCreated = useThrowOnContextLoss();
  return (
    <Canvas flat frameloop="never" onCreated={onCanvasCreated} resize={{ scroll: false }} gl={{ alpha: true, antialias: false, preserveDrawingBuffer: true }} style={{ width: "100%", height: "100%", background: "transparent" }}>
      <RenderGate frameRef={frameRef} />
      <CoilScene parts={parts} wirePaths={wirePaths} wireDiameter={wireDiameter} showWire={showWire} exploded={exploded} preset={preset} fill={fill} controlsRef={controlsRef} />
    </Canvas>
  );
}

function RenderGate({ frameRef }: { frameRef: React.RefObject<HTMLDivElement | null> }) {
  const invalidate = useThree((s) => s.invalidate);
  const setFrameloop = useThree((s) => s.setFrameloop);
  const frameloop = useThree((s) => s.frameloop);
  const [onScreen, setOnScreen] = useState(typeof IntersectionObserver === "undefined");
  const [forced, setForced] = useState(false);
  const active = onScreen || forced;

  const [firstDraw] = useState(() => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  });

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => setOnScreen(entries[entries.length - 1].isIntersecting), { rootMargin: VISIBLE_MARGIN });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frameRef]);

  useEffect(() => {
    const activate = () => setForced(true);
    const figure = { activate, drawn: firstDraw.promise };
    figures.add(figure);
    window.addEventListener("beforeprint", activate);
    return () => {
      figures.delete(figure);
      window.removeEventListener("beforeprint", activate);
    };
  }, [firstDraw]);

  useEffect(() => {
    const wanted = active ? "demand" : "never";
    if (frameloop !== wanted) setFrameloop(wanted);
    else if (active) kickInvalidate(invalidate);
  }, [active, frameloop, setFrameloop, invalidate]);

  useFrame(() => {
    const frame = frameRef.current;
    if (!frame || frame.dataset.rendered === "true") return;
    frame.dataset.rendered = "true";
    firstDraw.resolve();
  }, AFTER_LINE_ART_FRAME_PRIORITY);
  return null;
}
