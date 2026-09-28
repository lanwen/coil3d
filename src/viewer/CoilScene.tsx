import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { CoilMesh, Part, WireLayerPath } from "../core";
import { LineArtRenderer, type Projection } from "./lineArt/LineArtRenderer";
import type { PresetId } from "./lineArt/presets";
import { buildWireGeometries } from "./wireGeometry";

// A small, STANDALONE scene builder for the printable assembly guide (issue
// #17) -- not an extraction from `CoilViewer.tsx` (issue #13's wall-mount
// rewrite, and issue #15's camera/preset rework right after it, both landed
// mid-implementation and substantially changed that file; re-extracting from
// its current, still-actively-edited state each time would make this code
// hostage to unrelated viewer work). Instead this reuses the parts of the
// pipeline that already ARE shared, stable modules -- `LineArtRenderer`
// (the line-art render pass itself) and `presets.ts` (camera direction/up
// data) -- and reimplements the small, self-contained amount of glue around
// them (creased geometry, the exploded-view lift, framing) independently,
// the same way `CoilViewer.tsx` itself does. `CoilViewer.tsx` is untouched
// by this ticket.
//
// Unlike `CoilViewer`, every guide figure is a STATIC, one-shot render (no
// user ever drags or toggles a single figure), so this always asks
// `LineArtRenderer` for `reducedMotion=true` (no tweens to wait out) and
// never reserves headroom for an explode that isn't actually happening --
// see `framingGeometry` below.

// Normals are split where faces meet at more than this angle, so the edge
// shader sees a hard jump at every real crease (rims, the flange, each groove
// ridge) and nothing on smooth curves. The groove arc turns about 17 degrees
// per mesh row, safely below it; the ridges and rims turn 45-110 degrees.
const CREASE_ANGLE = (30 * Math.PI) / 180;

// Exploded view (issue #9): extra clearance beyond a lifted part's own
// bounding-box height, so it visibly separates from the core regardless of
// design scale (a tiny cap on a tiny coil still needs to clear the core's
// own top rim, not just a few sub-millimeter joint features).
export const EXPLODE_GAP = 20; // mm

export interface CoilSceneProps {
  /** Every printable part (issue #9): the core is drawn in place; every other part (currently only the top cap) can be lifted along the coil axis in the exploded view. */
  parts: Part[];
  /** The schematic wound-cable path per layer (issue #4), or omitted/empty to draw none. */
  wirePaths?: WireLayerPath[];
  /** Cable outer diameter, mm -- sets the drawn wire's tube radius. */
  wireDiameter?: number;
  /** Wire visibility toggle (issue #4), mirrored in the URL hash by the caller. */
  showWire?: boolean;
  /** A STATIC exploded pose (issue #9's animated toggle doesn't apply here -- every guide figure is one-shot): lifts every non-core part along the coil axis, away from the core, and reframes tightly around exactly that pose (no reserved headroom for the OTHER pose -- issue #17 review). */
  exploded?: boolean;
  /** Which standard view to render (`presets.ts`, issue #15); the guide always uses "iso", the same 3/4 assembly-manual look the interactive viewer defaults to. */
  preset?: PresetId;
  /** How much of the canvas's tighter axis the fit targets (`LineArtRenderer`'s own `fill`, issue #15) -- the guide asks for a tighter default than the interactive viewer's 0.75 so each step's model reads bigger (issue #17 review: "the model fills ~70% of its figure"). */
  fill?: number;
  /** Forwarded to LineArtRenderer for reframing; a host with no OrbitControls
   * (GuideFigure) passes a ref that is simply never attached to anything --
   * LineArtRenderer already null-checks it. */
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
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

/** A non-core part, held at Z=`offset` when `exploded`, Z=0 otherwise -- a plain static position (no easing: every guide figure is a one-shot render, never toggled live). */
function ExplodedPart({ geometry, offset, exploded }: { geometry: THREE.BufferGeometry; offset: number; exploded: boolean }) {
  const groupRef = useRef<THREE.Group>(null);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => invalidate(), [exploded, invalidate]); // kick the demand-mode loop when the pose changes
  useFrame(() => {
    const group = groupRef.current;
    if (group) group.position.z = exploded ? offset : 0;
  });
  return (
    <group ref={groupRef}>
      <mesh geometry={geometry} />
    </group>
  );
}

/**
 * The IKEA line-art look (issue #3, docs/research.md §5 & §10b) for one
 * static guide illustration: the mesh is never shaded directly --
 * `LineArtRenderer` draws white fill and black lines from a normal+depth
 * pass. Every part (issue #9) is drawn: the core in place, and any other
 * part (currently only the top cap) at its assembled or exploded Z per
 * `exploded`. The wound cable (issue #4) is a plain sibling mesh, outlined
 * by the same pass.
 *
 * This is scene content ONLY -- no `<Canvas>`. `GuideFigure` (issue #17)
 * wraps it in a `Canvas`, with no `OrbitControls` (a static illustration
 * needs none).
 */
export function CoilScene({ parts, wirePaths, wireDiameter, showWire = true, exploded = false, preset = "iso", fill, controlsRef }: CoilSceneProps) {
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

  // Framing (issue #17 review: "the model fills ~70% of its figure"): every
  // non-core part contributes its CURRENT pose only -- offset when
  // `exploded`, unshifted otherwise -- never both, since (unlike
  // `CoilViewer`) a guide figure's pose never changes after mount, so there
  // is no "reframe mid-toggle" to keep stable against. This is what actually
  // fixes steps 5/6/7 (assembled, not exploded) reading as a small, distant
  // model in a mostly-empty frame: the old always-reserve-explode-headroom
  // framing padded every figure for a lift that, for those steps, never
  // happens.
  const framingGeometry = useMemo(() => {
    const chunks = parts.map((part) => {
      const offset = exploded ? (explodeOffsets.get(part.name) ?? 0) : 0;
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
  }, [parts, explodeOffsets, exploded]);
  useEffect(() => () => framingGeometry.dispose(), [framingGeometry]);

  const projection: Projection = "ortho";

  return (
    <>
      {partGeometries.map(({ part, geometry }) =>
        part.role === "core" ? (
          <mesh key={part.name} geometry={geometry} />
        ) : (
          <ExplodedPart key={part.name} geometry={geometry} offset={explodeOffsets.get(part.name) ?? 0} exploded={exploded} />
        ),
      )}
      {wireGeometries.map((g, i) => (
        <mesh key={i} geometry={g} />
      ))}
      <LineArtRenderer geometry={framingGeometry} controlsRef={controlsRef} projection={projection} preset={preset} fill={fill} reducedMotion />
    </>
  );
}
