import { useRef } from "react";
import { Canvas } from "@react-three/fiber";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { Part, WireLayerPath } from "../core";
import { CoilScene } from "./CoilScene";
import type { PresetId } from "./lineArt/presets";

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

  return (
    <div className={className ?? "guide-figure"} data-testid={testId}>
      <Canvas flat frameloop="demand" gl={{ alpha: true, antialias: false, preserveDrawingBuffer: true }} style={{ width: "100%", height: "100%", background: "transparent" }}>
        <CoilScene parts={parts} wirePaths={wirePaths} wireDiameter={wireDiameter} showWire={showWire} exploded={exploded} preset={preset} fill={fill} controlsRef={controlsRef} />
      </Canvas>
    </div>
  );
}
