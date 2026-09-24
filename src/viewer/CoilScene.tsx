import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { CoilMesh, Part, WireLayerPath } from "../core";
import { LineArtRenderer } from "./lineArt/LineArtRenderer";
import { buildWireGeometries } from "./wireGeometry";

// Extracted from CoilViewer (issue #17, "printable assembly guide"): the
// guide's illustrations reuse this exact scene-building logic through a
// SEPARATE, lighter host component (GuideFigure.tsx) instead of duplicating
// it -- CoilViewer itself only adds the interactive frame (OrbitControls,
// the draft/final edge-fade). Moving here is a pure extraction; nothing
// about how a scene is built or rendered changed.

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

export interface CoilSceneProps {
  /** Every printable part (issue #9): the core is drawn in place; every other part (currently only the top cap) can be lifted along the coil axis in the exploded view. */
  parts: Part[];
  /** The schematic wound-cable path per layer (issue #4), or omitted/empty to draw none. */
  wirePaths?: WireLayerPath[];
  /** Cable outer diameter, mm -- sets the drawn wire's tube radius. */
  wireDiameter?: number;
  /** Wire visibility toggle (issue #4), mirrored in the URL hash by the caller. */
  showWire?: boolean;
  /** Animated exploded view (issue #9): lifts every non-core part along the coil axis, away from the core. The wound cable stays on the core regardless. Respects prefers-reduced-motion. */
  exploded?: boolean;
  /** Forwarded to LineArtRenderer for reframing/hit-testing; a host with no
   * OrbitControls (GuideFigure) passes a ref that is simply never attached
   * to anything -- LineArtRenderer already null-checks it. */
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}

export function usePrefersReducedMotion(): boolean {
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
 * A non-core part, lifted along Z by `offset` mm when `exploded`. Eases
 * toward its target with `THREE.MathUtils.damp` (frame-rate independent) and
 * re-invalidates the demand-mode canvas every frame until it settles;
 * `prefers-reduced-motion` (and a one-shot guide illustration, which passes
 * `reducedMotion` unconditionally) skips the easing and jumps straight there.
 */
function ExplodedPart({ geometry, offset, exploded, reducedMotion }: { geometry: THREE.BufferGeometry; offset: number; exploded: boolean; reducedMotion: boolean }) {
  const groupRef = useRef<THREE.Group>(null);
  const invalidate = useThree((s) => s.invalidate);
  const target = exploded ? offset : 0;

  useEffect(() => {
    invalidate(); // kick the demand-mode loop whenever the target changes
  }, [target, invalidate]);

  useFrame((_, delta) => {
    const group = groupRef.current;
    if (!group) return;
    if (reducedMotion) {
      group.position.z = target;
      return;
    }
    const next = THREE.MathUtils.damp(group.position.z, target, EXPLODE_EASE_RATE, delta);
    group.position.z = next;
    if (Math.abs(next - target) > EXPLODE_SETTLE_EPS) invalidate();
  });

  return (
    <group ref={groupRef}>
      <mesh geometry={geometry} />
    </group>
  );
}

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
 *
 * This is the scene content ONLY -- no `<Canvas>`, no `OrbitControls`. Two
 * hosts wrap it: `CoilViewer` (interactive, issue #3/#9) and `GuideFigure`
 * (issue #17's static assembly-guide illustrations), so the two never
 * duplicate how a design is turned into a line-art render.
 */
export function CoilScene({ parts, wirePaths, wireDiameter, showWire = true, exploded = false, controlsRef }: CoilSceneProps) {
  const reducedMotion = usePrefersReducedMotion();

  const partGeometries = useMemo(() => parts.map((part) => ({ part, geometry: buildCreasedGeometry(part.mesh) })), [parts]);
  useEffect(() => () => partGeometries.forEach(({ geometry }) => geometry.dispose()), [partGeometries]);

  // How far each non-core part lifts when exploded: its own Z-extent plus a
  // fixed gap, so it clears itself regardless of design scale.
  const explodeOffsets = useMemo(() => new Map(parts.filter((p) => p.role !== "core").map((p) => [p.name, zExtent(p.mesh) + EXPLODE_GAP])), [parts]);

  // A stable framing geometry (issue #9): every non-core part contributes
  // its FULLY exploded position, not its live animated one, so the camera
  // never reframes mid-explode -- only the parts themselves move (see
  // ExplodedPart above). Position-only (no index/normals needed):
  // LineArtRenderer only reads bounding-sphere/vertex bounds from it.
  const framingGeometry = useMemo(() => {
    const chunks = parts.map((part) => {
      const offset = explodeOffsets.get(part.name) ?? 0;
      if (offset === 0) return part.mesh.positions;
      const shifted = new Float32Array(part.mesh.positions.length);
      for (let i = 0; i < shifted.length; i += 3) {
        shifted[i] = part.mesh.positions[i];
        shifted[i + 1] = part.mesh.positions[i + 1];
        shifted[i + 2] = part.mesh.positions[i + 2] + offset;
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
  }, [parts, explodeOffsets]);
  useEffect(() => () => framingGeometry.dispose(), [framingGeometry]);

  // Deliberately NOT creased (unlike the coil geometry above): a tube's own
  // radial facets would otherwise draw a spurious line at every facet ridge,
  // hatching the whole coil (see src/viewer/wireGeometry.ts / S3 spike RESULT.md).
  const wireGeometries = useMemo(() => {
    if (!showWire || !wirePaths?.length || !wireDiameter) return [];
    return buildWireGeometries(wirePaths, wireDiameter / 2);
  }, [showWire, wirePaths, wireDiameter]);
  useEffect(() => () => wireGeometries.forEach((g) => g.dispose()), [wireGeometries]);

  return (
    <>
      {partGeometries.map(({ part, geometry }) =>
        part.role === "core" ? (
          <mesh key={part.name} geometry={geometry} />
        ) : (
          <ExplodedPart key={part.name} geometry={geometry} offset={explodeOffsets.get(part.name) ?? 0} exploded={exploded} reducedMotion={reducedMotion} />
        ),
      )}
      {wireGeometries.map((g, i) => (
        <mesh key={i} geometry={g} />
      ))}
      <LineArtRenderer geometry={framingGeometry} controlsRef={controlsRef} />
    </>
  );
}
