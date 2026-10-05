import { Component, useCallback, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import type { RootState } from "@react-three/fiber";

interface Props {
  fallback: ReactNode;
  children: ReactNode;
}

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

export function ViewerUnavailable() {
  return (
    <p className="viewer-unavailable" data-testid="viewer-unavailable" role="status">
      3D preview unavailable in this browser. Downloads still work.
    </p>
  );
}

export function useThrowOnContextLoss() {
  const [lost, setLost] = useState(false);
  if (lost) throw new Error("WebGL context lost");
  return useCallback(({ gl }: RootState) => gl.domElement.addEventListener("webglcontextlost", () => setLost(true)), []);
}
