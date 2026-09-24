import { useRef } from "react";
import { Canvas } from "@react-three/fiber";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { Part, WireLayerPath } from "../core";
import { CoilScene } from "./CoilScene";

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
  className?: string;
  testId?: string;
}

/**
 * A single static, non-interactive line-art illustration for the printable
 * assembly guide (issue #17). Reuses the exact same scene-building and
 * line-art pipeline as the interactive `CoilViewer` (issue #3/#9) through the
 * shared `CoilScene` component -- see src/viewer/CoilScene.tsx's file header
 * -- so guide illustrations can never visually drift from the live viewer.
 *
 * No `OrbitControls`: `controlsRef` is a plain, never-attached ref.
 * `LineArtRenderer` already null-checks it (used only for reframe-time
 * camera/target sync and pointer-driven hit-testing, neither of which apply
 * to a print illustration), and `CoilScene`'s own auto-fit-to-bounds camera
 * logic runs regardless, so every figure is correctly framed on mount with
 * zero interaction.
 */
export function GuideFigure({ parts, wirePaths, wireDiameter, showWire = false, exploded = false, className, testId }: GuideFigureProps) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);

  return (
    <div className={className ?? "guide-figure"} data-testid={testId}>
      <Canvas
        orthographic
        flat
        frameloop="demand"
        camera={{ up: [0, 0, 1] }}
        gl={{ alpha: true, antialias: false, preserveDrawingBuffer: true }}
        style={{ width: "100%", height: "100%", background: "transparent" }}
      >
        <CoilScene parts={parts} wirePaths={wirePaths} wireDiameter={wireDiameter} showWire={showWire} exploded={exploded} controlsRef={controlsRef} />
      </Canvas>
    </div>
  );
}
