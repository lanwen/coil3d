import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { CoilMesh, Part, Resolution, WireLayerPath } from "../core";
import { LineArtRenderer } from "./lineArt/LineArtRenderer";
import { buildWireGeometries } from "./wireGeometry";

// Normals are split where faces meet at more than this angle, so the edge
// shader sees a hard jump at every real crease (rims, the flange, each groove
// ridge) and nothing on smooth curves. The groove arc turns about 17 degrees
// per mesh row, safely below it; the ridges and rims turn 45-110 degrees.
const CREASE_ANGLE = (30 * Math.PI) / 180;

// Exploded view (issue #9): extra clearance beyond a lifted part's own
// bounding-box height, so it visibly separates from the core regardless of
// design scale (a tiny cap on a tiny coil still needs to clear the core's
// own top rim, not just a few sub-millimeter joint features).
const EXPLODE_GAP = 20; // mm
// How quickly the explode offset eases toward its target (an exponential
// decay rate for THREE.MathUtils.damp, frame-rate independent). Reaches
// ~95% of the way there in about a third of a second.
const EXPLODE_EASE_RATE = 9;
const EXPLODE_SETTLE_EPS = 0.01; // mm

export interface CoilViewerProps {
  /** Every printable part (issue #9): the core is drawn in place; every other part (currently only the top cap) can be lifted along the coil axis in the exploded view. */
  parts: Part[];
  resolution: Resolution;
  /** The schematic wound-cable path per layer (issue #4), or omitted/empty to draw none. */
  wirePaths?: WireLayerPath[];
  /** Cable outer diameter, mm -- sets the drawn wire's tube radius. */
  wireDiameter?: number;
  /** Wire visibility toggle (issue #4), mirrored in the URL hash by the caller. */
  showWire?: boolean;
  /** Animated exploded view (issue #9): lifts every non-core part along the coil axis, away from the core. The wound cable stays on the core regardless. Respects prefers-reduced-motion. */
  exploded?: boolean;
}

function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** The Z-extent of a mesh, mm -- used to size the exploded-view lift so a part clears its own height. */
function zExtent(mesh: CoilMesh): number {
  let minZ = Infinity;
  let maxZ = -Infinity;
  const pos = mesh.positions;
  for (let i = 2; i < pos.length; i += 3) {
    if (pos[i] < minZ) minZ = pos[i];
    if (pos[i] > maxZ) maxZ = pos[i];
  }
  return Math.max(0, maxZ - minZ);
}

function buildCreasedGeometry(mesh: CoilMesh): THREE.BufferGeometry {
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  indexed.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  const creased = toCreasedNormals(indexed, CREASE_ANGLE);
  indexed.dispose();
  return creased;
}

/**
 * A non-core part, lifted along `axis` by `offset` mm when `exploded` (the
 * coil's own axis, wherever it currently renders -- world Z when standing,
 * or wherever WALL_VIEW_ROTATION remaps it to once the wall-view preset is
 * on, see that matrix's own comment). Eases toward its target with
 * `THREE.MathUtils.damp` (frame-rate independent) and re-invalidates the
 * demand-mode canvas every frame until it settles; `prefers-reduced-motion`
 * skips the easing and jumps straight there.
 */
function ExplodedPart({
  geometry,
  offset,
  axis,
  exploded,
  reducedMotion,
}: {
  geometry: THREE.BufferGeometry;
  offset: number;
  axis: THREE.Vector3;
  exploded: boolean;
  reducedMotion: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const invalidate = useThree((s) => s.invalidate);
  const target = exploded ? offset : 0;
  const current = useRef(0);

  useEffect(() => {
    invalidate(); // kick the demand-mode loop whenever the target changes
  }, [target, invalidate]);

  useFrame((_, delta) => {
    const group = groupRef.current;
    if (!group) return;
    if (reducedMotion) {
      current.current = target;
      group.position.copy(axis).multiplyScalar(target);
      return;
    }
    const next = THREE.MathUtils.damp(current.current, target, EXPLODE_EASE_RATE, delta);
    current.current = next;
    group.position.copy(axis).multiplyScalar(next);
    if (Math.abs(next - target) > EXPLODE_SETTLE_EPS) invalidate();
  });

  return (
    <group ref={groupRef}>
      <mesh geometry={geometry} />
    </group>
  );
}

// Wall-mount preset (issue #13 AC: "the viewer can show the wall
// orientation, bottom flange against the wall, top cap facing the room").
// The core's own axis is Z (wall.ts: the bottom flange sits at z=-thickness,
// the open/top-cap end at z=height); this remaps it onto world X, laying the
// coil on its side the way it hangs in real life -- axis horizontal,
// pointing out of the wall (docs/research.md "Wall orientation") -- rather
// than the default standing-on-its-flange preview.
//
// The remaining two axes are NOT an arbitrary choice: mount.ts's WALL_UP
// (local +Y in the flange plane -- where the keyhole slots' own "up" is
// defined, see that file's header) must land on the axis the LineArtRenderer
// camera actually renders as vertical on screen. That renderer's camera uses
// a FIXED, oblique view direction (LineArtRenderer.tsx's VIEW_DIR) with
// `up = world +Z` (its UP constant) -- with an oblique view direction, only
// a difference along the camera's OWN up vector (which `lookAt`/Gram-Schmidt
// derives FROM world +Z) is guaranteed to render with zero horizontal
// component; a difference along any other world axis leaks into the
// screen's horizontal axis too (exactly the bug this rotation fixes: an
// earlier version sent local Y to world Y, which -- combined with this
// camera's tilt -- rendered two slots meant to sit side by side as stacked
// on top of each other instead). So: local Y (mount.ts's WALL_UP) -> world Z
// (this renderer's vertical), and local X (left/right between 2 slots) ->
// world Y, which is what's left over.
//
// This must rotate the GEOMETRY itself, not a wrapping group:
// LineArtRenderer frames the camera from `geometry`'s own LOCAL vertex
// positions (see LineArtRenderer.tsx's reframe effect), with no knowledge
// of a parent transform, so a group-level rotation would frame the
// UNrotated shape while rendering the rotated one. The schematic wire
// geometries (issue #4) are rotated the identical way, so the wire never
// visually separates from its coil when the preset is toggled.
const WALL_REMAP = new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, 1, 0), // local +X (left/right between 2 slots) -> world +Y
  new THREE.Vector3(0, 0, 1), // local +Y (mount.ts's WALL_UP) -> world +Z (this renderer's vertical)
  new THREE.Vector3(1, 0, 0), // local +Z (the coil's own axis) -> world +X (sticking out of the wall)
);
// A world-X-only difference (see WALL_REMAP above) has zero horizontal
// screen component, but its OWN vertical screen component isn't maximised
// at world Z's own extreme: this renderer's oblique VIEW_DIR/UP tilt the
// projected "up" a further ~24.2 degrees around that depth axis (derived
// from VIEW_DIR=(1,-1,0.9)/UP=(0,0,1): the camera's own up vector,
// (right x forward), points partway into world Y too, not purely Z). Left
// uncorrected, mount.ts's WALL_UP (theta=0, "top centre") lands about a
// quarter-turn off the ellipse's own visual apex once the flange is
// rotated face-on-ish, so two slots meant to sit level and side by side
// instead read as one clear (near the apex) and one barely-visible, deep
// in the foreshortened silhouette (issue #13 PR review). This extra spin
// about the SAME depth axis (world X) cancels that, independent of the
// model: it only depends on this renderer's own fixed camera, not on any
// particular design.
const WALL_VIEW_ROTATION = new THREE.Matrix4().makeRotationX(-0.42285392613294076).multiply(WALL_REMAP);

/**
 * The IKEA line-art look (issue #3, docs/research.md §5 & §10b): the mesh is
 * never shaded directly. `LineArtRenderer` takes over the render loop and
 * draws white fill and black lines from a normal+depth pass (via
 * `scene.overrideMaterial`), so no part's own material is ever seen. The
 * schematic wound-cable meshes (issue #4) are plain siblings in the same
 * scene, so the same pass outlines them for free.
 *
 * Every part (issue #9) is drawn: the core in place, and any other part
 * (currently only the top cap) inside an `ExplodedPart` group that can lift
 * away from the core. The wound cable is built from the SOLVED layer
 * offsets, which live on the core, so it never moves with the cap.
 */
export function CoilViewer({ parts, resolution, wirePaths, wireDiameter, showWire = true, exploded = false }: CoilViewerProps) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const prevResolution = useRef<Resolution>(resolution);
  const reducedMotion = usePrefersReducedMotion();
  const [wallView, setWallView] = useState(false);

  const partGeometries = useMemo(() => parts.map((part) => ({ part, geometry: buildCreasedGeometry(part.mesh) })), [parts]);
  useEffect(() => () => partGeometries.forEach(({ geometry }) => geometry.dispose()), [partGeometries]);

  // How far each non-core part lifts when exploded: its own Z-extent plus a
  // fixed gap, so it clears itself regardless of design scale.
  const explodeOffsets = useMemo(() => new Map(parts.filter((p) => p.role !== "core").map((p) => [p.name, zExtent(p.mesh) + EXPLODE_GAP])), [parts]);

  // Deliberately NOT creased (unlike the coil geometry above): a tube's own
  // radial facets would otherwise draw a spurious line at every facet ridge,
  // hatching the whole coil (see src/viewer/wireGeometry.ts / S3 spike RESULT.md).
  const wireGeometries = useMemo(() => {
    if (!showWire || !wirePaths?.length || !wireDiameter) return [];
    return buildWireGeometries(wirePaths, wireDiameter / 2);
  }, [showWire, wirePaths, wireDiameter]);
  useEffect(() => () => wireGeometries.forEach((g) => g.dispose()), [wireGeometries]);

  // Wall-view preset: physically rotated COPIES of every part's geometry (not
  // the base `partGeometries`/`wireGeometries`, which the draft/final swap
  // and the crease pass above both key off of), so toggling the preset never
  // disturbs those.
  const viewPartGeometries = useMemo(() => {
    if (!wallView) return partGeometries;
    return partGeometries.map(({ part, geometry }) => {
      const rotated = geometry.clone();
      rotated.applyMatrix4(WALL_VIEW_ROTATION);
      return { part, geometry: rotated };
    });
  }, [partGeometries, wallView]);
  useEffect(() => {
    if (viewPartGeometries === partGeometries) return;
    return () => viewPartGeometries.forEach(({ geometry }) => geometry.dispose());
  }, [viewPartGeometries, partGeometries]);

  const viewWireGeometries = useMemo(() => {
    if (!wallView) return wireGeometries;
    return wireGeometries.map((g) => {
      const rotated = g.clone();
      rotated.applyMatrix4(WALL_VIEW_ROTATION);
      return rotated;
    });
  }, [wireGeometries, wallView]);
  useEffect(() => {
    if (viewWireGeometries === wireGeometries) return;
    return () => viewWireGeometries.forEach((g) => g.dispose());
  }, [viewWireGeometries, wireGeometries]);

  // The exploded-view lift direction: the coil's own axis, wherever it
  // currently renders -- world Z when standing, or world X once
  // WALL_VIEW_ROTATION remaps it (see that matrix's own comment: "local +Z
  // (the coil's own axis) -> world +X").
  const explodeAxis = useMemo(() => new THREE.Vector3(wallView ? 1 : 0, 0, wallView ? 0 : 1), [wallView]);

  // A stable framing geometry (issue #9): every non-core part contributes
  // its FULLY exploded position, not its live animated one, so the camera
  // never reframes mid-explode -- only the parts themselves move (see
  // ExplodedPart above). Built from the (possibly wall-view-rotated) part
  // geometries, so framing always matches what's actually on screen.
  // Position-only (no index/normals needed): LineArtRenderer only reads
  // bounding-sphere/vertex bounds from it.
  const framingGeometry = useMemo(() => {
    const chunks = viewPartGeometries.map(({ part, geometry }) => {
      const offset = explodeOffsets.get(part.name) ?? 0;
      const positions = (geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
      if (offset === 0) return positions;
      const shift = explodeAxis.clone().multiplyScalar(offset);
      const shifted = new Float32Array(positions.length);
      for (let i = 0; i < shifted.length; i += 3) {
        shifted[i] = positions[i] + shift.x;
        shifted[i + 1] = positions[i + 1] + shift.y;
        shifted[i + 2] = positions[i + 2] + shift.z;
      }
      return shifted;
    });
    const merged = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      merged.set(c, at);
      at += c.length;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(merged, 3));
    return geometry;
  }, [viewPartGeometries, explodeOffsets, explodeAxis]);
  useEffect(() => () => framingGeometry.dispose(), [framingGeometry]);

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
  }, [parts, resolution]);

  return (
    <div ref={frameRef} data-testid="coil-viewer" className="coil-viewer-frame">
      <button type="button" data-testid="toggle-wall-view" className="wall-view-toggle" onClick={() => setWallView((v) => !v)}>
        {wallView ? "Standing view" : "Wall-mount view"}
      </button>
      {wallView && (
        <p className="wall-view-caption" data-testid="wall-view-caption">
          Bottom flange against the wall -- top cap faces the room
        </p>
      )}
      <Canvas
        orthographic
        flat
        frameloop="demand"
        camera={{ up: [0, 0, 1] }}
        gl={{ alpha: true, antialias: false }}
        style={{ width: "100%", height: "100%", background: "transparent" }}
      >
        {viewPartGeometries.map(({ part, geometry }) =>
          part.role === "core" ? (
            <mesh key={part.name} geometry={geometry} />
          ) : (
            <ExplodedPart key={part.name} geometry={geometry} offset={explodeOffsets.get(part.name) ?? 0} axis={explodeAxis} exploded={exploded} reducedMotion={reducedMotion} />
          ),
        )}
        {viewWireGeometries.map((g, i) => (
          <mesh key={i} geometry={g} />
        ))}
        <LineArtRenderer geometry={framingGeometry} controlsRef={controlsRef} />
        <OrbitControls ref={controlsRef} makeDefault enableDamping={false} />
      </Canvas>
    </div>
  );
}
