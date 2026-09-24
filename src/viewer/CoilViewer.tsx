import { useEffect, useMemo, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { CoilMesh, Resolution, WireLayerPath } from "../core";
import { LineArtRenderer } from "./lineArt/LineArtRenderer";
import { buildWireGeometries } from "./wireGeometry";

// Normals are split where faces meet at more than this angle, so the edge
// shader sees a hard jump at every real crease (rims, the flange, each groove
// ridge) and nothing on smooth curves. The groove arc turns about 17 degrees
// per mesh row, safely below it; the ridges and rims turn 45-110 degrees.
const CREASE_ANGLE = (30 * Math.PI) / 180;

export interface CoilViewerProps {
  mesh: CoilMesh;
  resolution: Resolution;
  /** The schematic wound-cable path per layer (issue #4), or omitted/empty to draw none. */
  wirePaths?: WireLayerPath[];
  /** Cable outer diameter, mm -- sets the drawn wire's tube radius. */
  wireDiameter?: number;
  /** Wire visibility toggle (issue #4), mirrored in the URL hash by the caller. */
  showWire?: boolean;
}

/**
 * The IKEA line-art look (issue #3, docs/research.md §5 & §10b): the mesh is
 * never shaded directly. `LineArtRenderer` takes over the render loop and
 * draws white fill and black lines from a normal+depth pass (via
 * `scene.overrideMaterial`), so this mesh's own material is never seen. The
 * schematic wound-cable meshes (issue #4) are plain siblings in the same
 * scene, so the same pass outlines them for free.
 */
export function CoilViewer({ mesh, resolution, wirePaths, wireDiameter, showWire = true }: CoilViewerProps) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const prevResolution = useRef<Resolution>(resolution);

  const geometry = useMemo(() => {
    const indexed = new THREE.BufferGeometry();
    indexed.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    indexed.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    const creased = toCreasedNormals(indexed, CREASE_ANGLE);
    indexed.dispose();
    return creased;
  }, [mesh]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Deliberately NOT creased (unlike the coil geometry above): a tube's own
  // radial facets would otherwise draw a spurious line at every facet ridge,
  // hatching the whole coil (see src/viewer/wireGeometry.ts / S3 spike RESULT.md).
  const wireGeometries = useMemo(() => {
    if (!showWire || !wirePaths?.length || !wireDiameter) return [];
    return buildWireGeometries(wirePaths, wireDiameter / 2);
  }, [showWire, wirePaths, wireDiameter]);
  useEffect(() => () => wireGeometries.forEach((g) => g.dispose()), [wireGeometries]);

  // Draft -> final swap gets a short edge fade (issue #7 AC), matching the
  // gridfinity-layout-tool review's approach (docs/research.md §10b: "the
  // exact mesh replaces it with a ... edge fade"). Draft -> draft (still
  // editing) and final -> final (settled again with the same numbers) never
  // fade, so dragging a slider stays snappy. Restarting a CSS animation by
  // toggling its class off then back on (forcing a reflow in between) is a
  // standard technique; it needs no extra libraries.
  useEffect(() => {
    const swapped = prevResolution.current === "draft" && resolution === "final";
    prevResolution.current = resolution;
    if (!swapped) return;
    const el = frameRef.current;
    if (!el) return;
    el.classList.remove("edge-fade");
    void el.offsetWidth; // force a reflow so the next classList.add restarts the animation
    el.classList.add("edge-fade");
  }, [mesh, resolution]);

  return (
    <div ref={frameRef} data-testid="coil-viewer" className="coil-viewer-frame">
      <Canvas
        orthographic
        flat
        frameloop="demand"
        camera={{ up: [0, 0, 1] }}
        gl={{ alpha: true, antialias: false }}
        style={{ width: "100%", height: "100%", background: "transparent" }}
      >
        <mesh geometry={geometry} />
        {wireGeometries.map((g, i) => (
          <mesh key={i} geometry={g} />
        ))}
        <LineArtRenderer geometry={geometry} controlsRef={controlsRef} />
        <OrbitControls ref={controlsRef} makeDefault enableDamping={false} />
      </Canvas>
    </div>
  );
}
