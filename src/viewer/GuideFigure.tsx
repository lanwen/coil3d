import { useEffect, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { Part, WireLayerPath } from "../core";
import { CoilScene } from "./CoilScene";
import { kickInvalidate } from "./lineArt/LineArtRenderer";
import type { PresetId } from "./lineArt/presets";

// How far outside the viewport a figure starts rendering, so one that is
// about to scroll in is already drawn when it arrives.
const VISIBLE_MARGIN = "200px 0px";
// How long `renderAllGuideFigures` waits for the figures before it gives up.
const RENDER_ALL_TIMEOUT_MS = 5000;

// Every mounted figure, so the print button can render the ones that are
// still off screen before the browser snapshots the page.
const figures = new Set<{ activate: () => void; drawn: Promise<void> }>();

/**
 * Render every guide figure now, however far off screen it is, and resolve
 * once each has drawn (or after a timeout). A browser prints the canvases as
 * they are, so a figure that was never scrolled into view would come out blank.
 */
export async function renderAllGuideFigures(): Promise<void> {
  const all = [...figures];
  all.forEach((f) => f.activate());
  await Promise.race([Promise.all(all.map((f) => f.drawn)), new Promise((resolve) => window.setTimeout(resolve, RENDER_ALL_TIMEOUT_MS))]);
}

export interface GuideFigureProps {
  /** The part(s) to draw, already in whatever frame the caller wants shown
   * (the shared assembly frame for an "as assembled" figure, or a part's own
   * `printTransform` pre-applied for an "as printed" figure -- see
   * src/guide/printOrientation.ts). */
  parts: Part[];
  wirePaths?: WireLayerPath[];
  wireDiameter?: number;
  showWire?: boolean;
  /** Static, not interactively toggled -- a guide step shows a fixed pose (e.g. the "fit the cap" step's exploded/assembled PAIR is two separate figures, not one animated toggle). */
  exploded?: boolean;
  /** `CoilScene`'s own default is "iso"; a step overrides this only if it genuinely needs a different standard view. */
  preset?: PresetId;
  /** How tightly the model fills the figure (`LineArtRenderer`'s `fill`, issue #15) -- see `CoilScene`'s own doc comment. Also the ONE thing a `ZoomInset` (src/guide/overlays.tsx) varies to magnify a region: rendering the SAME geometry/preset at a much higher fill and cropping the result is what makes the crop line up with a point projected via `computeGuideFit` at the ORIGINAL fill. */
  fill?: number;
  className?: string;
  testId?: string;
}

/**
 * A single static, non-interactive line-art illustration for the printable
 * assembly guide (issue #17). Reuses `LineArtRenderer` (the actual line-art
 * render pass) and `presets.ts` (camera direction/up data) through the
 * shared `CoilScene` component -- see src/viewer/CoilScene.tsx's file header
 * for why this is a small, standalone scene builder rather than an
 * extraction from the (actively-evolving) `CoilViewer.tsx`.
 *
 * No `OrbitControls`: `controlsRef` is a plain, never-attached ref.
 * `LineArtRenderer` already null-checks it (used only for reframe-time
 * camera/target sync, which doesn't apply to a print illustration), and
 * `CoilScene`'s own auto-fit-to-bounds camera
 * logic runs regardless, so every figure is correctly framed on mount with
 * zero interaction. `reducedMotion` is always on (see CoilScene): a static
 * illustration has no transition to skip in the first place.
 */
export function GuideFigure({ parts, wirePaths, wireDiameter, showWire = false, exploded = false, preset, fill, className, testId }: GuideFigureProps) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  // `data-rendered` flips to "true" once the figure has drawn (RenderGate).
  // The canvas starts with its frame loop off and only renders near the
  // viewport. `scroll: false`: the canvas's position never matters to a
  // static figure, but re-measuring it on scroll would resize it, and a
  // resize clears the picture (and redraws it, if the loop is on).
  return (
    <div ref={frameRef} className={className ?? "guide-figure"} data-testid={testId} data-rendered="false">
      <Canvas flat frameloop="never" resize={{ scroll: false }} gl={{ alpha: true, antialias: false, preserveDrawingBuffer: true }} style={{ width: "100%", height: "100%", background: "transparent" }}>
        <RenderGate frameRef={frameRef} />
        <CoilScene parts={parts} wirePaths={wirePaths} wireDiameter={wireDiameter} showWire={showWire} exploded={exploded} preset={preset} fill={fill} controlsRef={controlsRef} />
      </Canvas>
    </div>
  );
}

/**
 * A software or phone GPU pays for the whole line-art pipeline on every
 * figure, so a figure only renders while it is (nearly) on screen. This turns
 * the canvas's frame loop on and off, from inside the canvas: changing the
 * `frameloop` prop would reconfigure the canvas, and that resizes it, which
 * clears the picture it keeps while it is away (preserveDrawingBuffer).
 */
function RenderGate({ frameRef }: { frameRef: React.RefObject<HTMLDivElement | null> }) {
  const invalidate = useThree((s) => s.invalidate);
  const setFrameloop = useThree((s) => s.setFrameloop);
  const frameloop = useThree((s) => s.frameloop);
  const [onScreen, setOnScreen] = useState(typeof IntersectionObserver === "undefined");
  // Printing: the browser prints the canvases as they are.
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
    // Printing from the browser menu, which has no chance to wait for us.
    window.addEventListener("beforeprint", activate);
    return () => {
      figures.delete(figure);
      window.removeEventListener("beforeprint", activate);
    };
  }, [firstDraw]);

  // Also re-applies the wanted state after the canvas is reconfigured (new
  // figure props), which resets the loop to the prop's value.
  useEffect(() => {
    const wanted = active ? "demand" : "never";
    if (frameloop !== wanted) setFrameloop(wanted);
    // Frames asked for while the loop was off (the scene mounting, a resize)
    // were dropped, and a resize clears the canvas, so draw again on arrival.
    else if (active) kickInvalidate(invalidate);
  }, [active, frameloop, setFrameloop, invalidate]);

  // After LineArtRenderer's own frame callback (priority 1), so this reports a frame that was really drawn.
  useFrame(() => {
    const frame = frameRef.current;
    if (!frame || frame.dataset.rendered === "true") return;
    frame.dataset.rendered = "true";
    firstDraw.resolve();
  }, 2);
  return null;
}
