import { Component, useCallback, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import type { RootState } from "@react-three/fiber";

interface Props {
  /** What to show in place of a 3D canvas that failed. */
  fallback: ReactNode;
  children: ReactNode;
}

/**
 * Keeps a 3D canvas that fails (no WebGL, a blocklisted GPU or driver, a lost
 * context) from taking the whole page down with it: React unmounts the entire
 * tree when an error is not caught. Everything but the canvas needs no WebGL
 * (the geometry is solved in a worker), so the rest of the app keeps working
 * and `fallback` shows where the canvas would be. Error boundaries have to be
 * class components.
 */
export class ViewerBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("3D view unavailable:", error, info.componentStack);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** The note that replaces the main 3D view. */
export function ViewerUnavailable() {
  return (
    <p className="viewer-unavailable" data-testid="viewer-unavailable" role="status">
      3D preview unavailable in this browser. Downloads still work.
    </p>
  );
}

/**
 * A `<Canvas onCreated>` handler for the component that renders the canvas:
 * when the WebGL context is lost later, it throws from that component's own
 * render, which the nearest `ViewerBoundary` catches (an event listener's
 * errors never reach a boundary).
 */
export function useThrowOnContextLoss() {
  const [lost, setLost] = useState(false);
  if (lost) throw new Error("WebGL context lost");
  return useCallback(({ gl }: RootState) => gl.domElement.addEventListener("webglcontextlost", () => setLost(true)), []);
}
