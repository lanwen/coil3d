import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { CAP_THICKNESS, JOINT_ENGAGE_DEPTH, JOINT_TRANSITION_HEIGHT } from "../core";
import type { CoilMesh, MountKind, Part, PegboardSection, PrintSpec, Resolution, ShapeKind, WireLayerPath } from "../core";
import { DimensionAxes, type DimensionLabels } from "./DimensionAxes";
import { dimensionAxesGeometry, dimensionFramePoints, measureDimensionFrame } from "./dimensionGeometry";
import { frontFacingDimensionSpin, frontFacingRotation } from "./frontFacing";
import { LineArtRenderer, type Projection } from "./lineArt/LineArtRenderer";
import { getPreset, presetQuaternion, type PresetId } from "./lineArt/presets";
import { PegboardSlots } from "./PegboardSlots";
import { PrintLayoutLabels } from "./PrintLayoutLabels";
import { buildBedGeometry, buildPrintLayout } from "./printLayoutScene";
import { ViewControls } from "./ViewControls";
import { WALL_MOUNT_VIEW_ROTATION, WALL_VIEW_ROTATION, withMountAxisCorrection } from "./wallRotations";
import { buildCableTube, buildWireGeometries, needsEnvelope } from "./wireGeometry";

// Normals are split where faces meet at more than this angle, so the edge
// shader sees a hard jump at every real crease (rims, the flange, each groove
// ridge) and nothing on smooth curves. The groove arc turns about 17 degrees
// per mesh row, safely below it; the ridges and rims turn 45-110 degrees.
const CREASE_ANGLE = (30 * Math.PI) / 180;

// Exploded view (issue #9): extra clearance beyond a lifted part's own
// bounding-box height, so it visibly separates from the core regardless of
// design scale (a tiny cap on a tiny coil still needs to clear the core's
// own top rim, not just a few sub-millimeter joint features). Issue #15's
// #9-review comment: the collar (the part that actually dips into the
// core's bore -- press/bayonet/snap all share it, docs/research.md §1 "Cap
// joint") must clear the core's rim by a wide, unambiguous margin once
// exploded, not just enough to not-overlap -- floored at the collar's own
// engagement depth (plus its weld-transition flare) plus 1.5x the cap's
// thickness, then padded further for comfortable visibility.
const EXPLODE_VISIBILITY_MARGIN = 15; // mm
const EXPLODE_GAP = JOINT_ENGAGE_DEPTH + JOINT_TRANSITION_HEIGHT + 1.5 * CAP_THICKNESS + EXPLODE_VISIBILITY_MARGIN;
// How quickly the explode offset eases toward its target (an exponential
// decay rate for THREE.MathUtils.damp, frame-rate independent). Reaches
// ~95% of the way there in about a third of a second.
const EXPLODE_EASE_RATE = 9;
const EXPLODE_SETTLE_EPS = 0.01; // mm
// A tighter fit while exploded (issue #15, issue #9 review: "consider a
// slight camera reframe while exploded"): the separated joint reads clearer
// when the frame isn't also reserving its usual slack margin around it.
const EXPLODED_FILL = 0.85;
// A looser fill for the inner-end debug close-up: `innerEndLeadIn`'s own
// extent is tiny (a few mm), so the default 0.75 leaves almost no context
// around the keyhole/channel -- this keeps some of the surrounding flange
// and groove visible too.
const FOCUS_FILL = 0.4;

export interface CoilViewerProps {
  /** Every printable part (issue #9): the core is drawn in place; every other part (currently only the top cap) can be lifted along the coil axis in the exploded view. */
  parts: Part[];
  resolution: Resolution;
  /** The schematic wound-cable path per layer (issue #4), or omitted/empty to draw none. */
  wirePaths?: WireLayerPath[];
  /** `Design.innerEndLeadIn` (issue #8): the inner-end keyhole-through-channel centerline, drawn as one more small tube alongside `wirePaths` so the wound cable reads as one continuous line from the keyhole into the groove. Omitted/too short to draw none. */
  innerEndLeadIn?: Float32Array;
  /** `Design.layerTransitions` (issue #68): one short bridging tube per layer-to-layer transition, drawn alongside `wirePaths` so a multi-layer coil reads as ONE continuous cable instead of a fresh start at every layer. Omitted/empty draws none. */
  layerTransitions?: Float32Array[];
  /** `Design.outerEndLeadOut` (issue #68): the cable's outer end (to the top cap's rim keyhole, or a free tail with the cap off), drawn the same way as `innerEndLeadIn`. Omitted/too short to draw none. */
  outerEndLeadOut?: Float32Array;
  /** `Design.cablePath` (issue #115): the whole cable as one polyline, drawn as ONE tube whenever no layer needs the many-turn envelope (see wireGeometry.ts). */
  cablePath?: Float32Array;
  /** Cable outer diameter, mm -- sets the drawn wire's tube radius. */
  wireDiameter?: number;
  /** Wire visibility toggle (issue #4), mirrored in the URL hash by the caller. */
  showWire?: boolean;
  /** Animated exploded view (issue #9): lifts every non-core part along the coil axis, away from the core. The wound cable stays on the core regardless. Respects prefers-reduced-motion. */
  exploded?: boolean;
  /** `Design.mountAxisDeg` (issue #13): the screw-keyhole mount's own true "hangs level" axis, when it differs from the design's local +Y (WALL_UP) -- see `buildViewRotations`'s comment. Omit (or leave undefined) when there's no mount, or it fits exactly on local +Y already. */
  mountAxisDeg?: number;
  /** Issue #50 (numbers fixed in #63): `Solution.flangeExtent.acrossFlats` -- a round flange's true outer diameter, shown as the "Ø" width and depth dimensions (sq/tri widths/depths are the flange mesh's own extents along local X/Y). Omitted (no solved design yet) hides the dimension axes. */
  envelopeWidth?: number;
  /** Issue #63: `Solution.overallHeight` -- the height dimension (flange underside to the top). Falls back to the part meshes' own Z extent. */
  overallHeight?: number;
  /** Issue #50: `CoilSpec.shape.kind` -- whether the width/depth dimensions read as a true diameter ("Ø", round, from `envelopeWidth`) or a plain width (sq/tri). */
  shapeKind?: ShapeKind;
  /** Issue #69: the dimension axes' visibility toggle. */
  showDimensions?: boolean;
  /** `CoilSpec.print` (issue #78): the configured print bed, driving the
   * "Print layout" view's drawn bed rectangle and part arrangement -- the
   * SAME `PrintSpec` the 3MF plate layout reads. */
  bed: PrintSpec;
  /** Issue #78 PR review: the print-layout view force-hides the wound cable
   * and the dimension axes itself (there's nothing to toggle -- the core
   * prints without a cable, see CoilViewer's own render), but the "Show
   * wound cable"/"Dimensions" TOGGLE CONTROLS live in App.tsx, outside this
   * component -- fired whenever `viewMode` enters/leaves "printLayout" so
   * the caller can hide those controls while they'd have no visible effect,
   * without touching `showWire`/`showDimensions` themselves (so whatever
   * the user had them set to is exactly what shows again once they leave). */
  onPrintLayoutActiveChange?: (active: boolean) => void;
  /** `Design.spec.mount`: switching it TO "skadis" (not a page load that starts there) swaps in the mount-side view once, so the new plate and its clips are actually seen (issue #106). */
  mountKind?: MountKind;
  /** `Design.pegboard` (issue #106): the SKÅDIS slot grid the mount-side view draws against the clips; undefined hides that view. */
  pegboard?: PegboardSection;
  /** Isometric (`ortho`) or perspective camera. Owned by App since issue #145, so its switch can sit with the other viewport toggles (under the canvas on a phone). */
  projection?: Projection;
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
// orientation, bottom flange against the wall, top cap facing the room";
// issue #49 trimmed the interactive viewer down to just this one, room-side
// hung view -- the mount-side "what the wall sees" view stays available in
// the assembly guide, `guide/Guide.tsx`'s `StepMountKeyhole`, via its own
// separate use of `WALL_MOUNT_VIEW_ROTATION`). `WALL_VIEW_ROTATION` and the
// `mountAxisDeg` correction are the one shared definition in
// `./wallRotations` (issue #40) -- the printable guide (`guide/wallView.ts`)
// uses the exact same matrix, so its wall step can never drift out of sync
// with this viewer's. See that module for the full derivation.
//
// Rotates the GEOMETRY itself, not a wrapping group: LineArtRenderer frames
// the camera from `geometry`'s own LOCAL vertex positions (see
// LineArtRenderer.tsx's reframe effect), with no knowledge of a parent
// transform, so a group-level rotation would frame the UNrotated shape
// while rendering the rotated one. The schematic wire geometries (issue #4)
// are rotated the identical way, so the wire never visually separates from
// its coil when the preset is toggled.

// Issue #106 adds "mountSide": the wall's own face-on view of the clip
// mount plate (`WALL_MOUNT_VIEW_ROTATION`, the same one the guide's mount
// insets use), with the SKÅDIS slot grid (`PegboardSlots`) drawn in.
type ViewMode = "standing" | "wallRoom" | "mountSide" | "printLayout";

// Issue #79: "standing" now also carries a per-shape presentation rotation
// (frontFacing.ts) so Front (and Iso, 45 degrees off it) face a flat side
// for square/triangle -- null for round (nothing to face) and undefined
// shapeKind (no design solved yet). `printLayout` needs no rotation of its
// own: its scene is a completely different geometry (buildPrintLayout), not
// a rotated copy of the assembled one (see CoilViewer's own render below).
function buildViewRotations(mountAxisDeg: number | undefined, shapeKind: ShapeKind | undefined): Record<ViewMode, THREE.Matrix4 | null> {
  return {
    standing: frontFacingRotation(shapeKind),
    wallRoom: withMountAxisCorrection(WALL_VIEW_ROTATION, mountAxisDeg),
    mountSide: withMountAxisCorrection(WALL_MOUNT_VIEW_ROTATION, mountAxisDeg),
    printLayout: null,
  };
}

// The coil's own axis (local +Z), wherever each preset renders it -- see
// wallRotations.ts's WALL_REMAP comment for the room-side case (world +X; a
// rotation about world X, its spin correction, never moves points along
// world X, so it needs no correction of its own). Unused in `printLayout`
// (that view never explodes, see CoilViewer's own render below) -- present
// only so this stays a total map over `ViewMode`.
const EXPLODE_AXES: Record<ViewMode, THREE.Vector3> = {
  standing: new THREE.Vector3(0, 0, 1),
  wallRoom: new THREE.Vector3(1, 0, 0),
  // WALL_MOUNT_VIEW_ROTATION's own image of local +Z (the camera's forward);
  // its mountAxisDeg correction spins about local Z, so never moves it.
  mountSide: new THREE.Vector3(0, 0, 1).applyMatrix4(WALL_MOUNT_VIEW_ROTATION),
  printLayout: new THREE.Vector3(0, 0, 1),
};

// Issue #78 AC ("a 'no supports needed' note is visible") reuses the
// wall-mount preset's own caption element (same `wall-view-caption` testid/
// class) rather than a new one -- one already-tested "the current view's
// own note" slot, not a second parallel mechanism.
const VIEW_CAPTION: Partial<Record<ViewMode, string>> = {
  wallRoom: "Bottom flange against the wall -- top cap faces the room",
  mountSide: "Seen from behind the wall -- each clip in its SKÅDIS slot (grey)",
  printLayout: "Every part rests flat on the bed -- no supports needed",
};

/**
 * Screenshot-only close-up on one end of the cable: the bottom flange's own
 * inner-end keyhole + channel (issue #8 PR review), gated behind
 * `?debugFocusInnerEnd=1`, or the cable's outer end (issue #115: the cap
 * keyhole, or the free tail with the cap off), behind
 * `?debugFocusOuterEnd=1` (checked once at mount, not reactively -- a
 * screenshot tool, not a user control). `&debugFocusFromBelow=1` also turns
 * the model over so the camera looks at that end from underneath (issue
 * #117: the top cap's clip hangs under its rim), and
 * `&debugFocusRadius=<mm>` frames only the part of that end within this
 * distance of the cable's end, for a tighter close-up.
 */
function useDebugFocusOptions(): { fromBelow: boolean; radius: number } {
  const [options] = useState(() => {
    if (typeof window === "undefined") return { fromBelow: false, radius: Infinity };
    try {
      const params = new URLSearchParams(window.location.search);
      const radius = Number(params.get("debugFocusRadius"));
      return { fromBelow: params.get("debugFocusFromBelow") === "1", radius: radius > 0 ? radius : Infinity };
    } catch {
      return { fromBelow: false, radius: Infinity };
    }
  });
  return options;
}

function useDebugFocusEnd(): "inner" | "outer" | null {
  const [end] = useState<"inner" | "outer" | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get("debugFocusInnerEnd") === "1") return "inner";
      if (params.get("debugFocusOuterEnd") === "1") return "outer";
      return null;
    } catch {
      return null;
    }
  });
  return end;
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
 */
export function CoilViewer({
  parts,
  resolution,
  wirePaths,
  innerEndLeadIn,
  layerTransitions,
  outerEndLeadOut,
  cablePath,
  wireDiameter,
  showWire = true,
  exploded = false,
  mountAxisDeg,
  envelopeWidth,
  overallHeight,
  shapeKind,
  showDimensions = true,
  bed,
  onPrintLayoutActiveChange,
  mountKind,
  pegboard,
  projection = "ortho",
}: CoilViewerProps) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const prevResolution = useRef<Resolution>(resolution);
  const reducedMotion = usePrefersReducedMotion();
  const [viewMode, setViewMode] = useState<ViewMode>("standing");
  const debugFocusEnd = useDebugFocusEnd();
  const { fromBelow: debugFocusFromBelow, radius: debugFocusRadius } = useDebugFocusOptions();
  // The cable end the debug close-up frames (its own samples), and the
  // sample it turns to face the camera: the keyhole (the lead-in's first)
  // or the outer end's last.
  const focusPath = useMemo(() => {
    const path = debugFocusEnd === "inner" ? innerEndLeadIn : debugFocusEnd === "outer" ? outerEndLeadOut : undefined;
    if (!path || path.length < 6 || !Number.isFinite(debugFocusRadius)) return path;
    // Only the samples near the cable's end (`debugFocusRadius`).
    const at = debugFocusEnd === "outer" ? path.length - 3 : 0;
    const near: number[] = [];
    for (let i = 0; i < path.length; i += 3) {
      if (Math.hypot(path[i] - path[at], path[i + 1] - path[at + 1], path[i + 2] - path[at + 2]) <= debugFocusRadius) near.push(path[i], path[i + 1], path[i + 2]);
    }
    return near.length >= 6 ? new Float32Array(near) : path;
  }, [debugFocusEnd, innerEndLeadIn, outerEndLeadOut, debugFocusRadius]);
  const focusIndex = debugFocusEnd === "outer" && focusPath ? focusPath.length / 3 - 1 : 0;
  useEffect(() => {
    onPrintLayoutActiveChange?.(viewMode === "printLayout");
  }, [viewMode, onPrintLayoutActiveChange]);
  const viewRotations = useMemo(() => buildViewRotations(mountAxisDeg, shapeKind), [mountAxisDeg, shapeKind]);

  // Issue #106: a SKÅDIS plate sits behind the flange, where neither the Iso
  // nor the Wall mount camera ever looks -- so selecting it (a change of
  // mount, not a link that already had it) jumps to the mount-side view
  // once. The view goes away again with the plate.
  const prevMountKind = useRef<MountKind | undefined>(mountKind);
  useEffect(() => {
    const prev = prevMountKind.current;
    prevMountKind.current = mountKind;
    if (prev !== mountKind && mountKind === "skadis" && pegboard) setViewMode("mountSide");
  }, [mountKind, pegboard]);
  useEffect(() => {
    if (!pegboard) setViewMode((mode) => (mode === "mountSide" ? "standing" : mode));
  }, [pegboard]);

  // Debug close-up on the inner-end keyhole + channel (issue #8 PR review):
  // rotates the rendered geometry about the coil axis so the keyhole's own
  // (data-dependent) azimuth lines up with the DEFAULT "iso" preset's own
  // fixed camera azimuth (-45 degrees, equal parts +X/-Y -- presets.ts's
  // ISO_DIR) -- so the existing iso camera, entirely unchanged, already
  // looks straight at it from iso's own ~32 degree elevation. Only active
  // in the "standing" view (the wall presets already own their own
  // rotation), and only once `innerEndLeadIn` has real samples (empty when
  // layer 1 has no turns -- see wire.ts's own doc comment).
  const focusRotation = useMemo(() => {
    if (viewMode !== "standing" || !focusPath || focusPath.length < 6) return null;
    const isoAzimuth = Math.atan2(getPreset("iso").direction.y, getPreset("iso").direction.x);
    const keyholeAzimuth = Math.atan2(focusPath[focusIndex * 3 + 1], focusPath[focusIndex * 3]);
    const turn = new THREE.Matrix4().makeRotationZ(isoAzimuth - keyholeAzimuth);
    if (!debugFocusFromBelow) return turn;
    // Upside down about the horizontal axis through the focus point's own
    // azimuth, so it stays in front of the camera.
    return new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(Math.cos(isoAzimuth), Math.sin(isoAzimuth), 0), Math.PI).multiply(turn);
  }, [viewMode, focusPath, focusIndex, debugFocusFromBelow]);

  const partGeometries = useMemo(() => parts.map((part) => ({ part, geometry: buildCreasedGeometry(part.mesh) })), [parts]);
  useEffect(() => () => partGeometries.forEach(({ geometry }) => geometry.dispose()), [partGeometries]);

  // Camera view controls (issue #15, trimmed to Front/Iso/Wall mount by
  // issue #49): purely viewer-internal (no bearing on the design itself),
  // so the preset is owned here rather than lifted to App -- it resets on
  // reload, same as the exploded-view toggle. (The projection used to live
  // here too; issue #145 lifted it to App, see the `projection` prop.)
  // `preset` only ever holds a
  // STANDING-camera value (front/iso): the wall preset is represented by
  // `viewMode` instead (issue #13, see `effectivePreset` below), since it's
  // really a geometry rotation this component already owned, not a new
  // camera direction of its own.
  const [preset, setPreset] = useState<PresetId>("iso");

  // The preset this render actually asks LineArtRenderer for, and what
  // ViewControls highlights as active: `viewMode`'s own wall preset once a
  // wall view is on (both wall rotations assume the camera sits at "iso" --
  // see VIEW_PRESETS' own comment in presets.ts), else whatever standing
  // camera preset was last chosen.
  const effectivePreset: PresetId = viewMode === "standing" ? preset : viewMode;

  /** Clicking Front/Iso exits the wall/print-layout view; clicking "Wall
   * mount" or "Print layout" sets the `viewMode` that swaps in that view's
   * own geometry. */
  const handlePresetChange = (id: PresetId) => {
    if (id === "wallRoom" || id === "mountSide" || id === "printLayout") {
      setViewMode(id);
    } else {
      setViewMode("standing");
      setPreset(id);
    }
  };

  // How far each non-core part lifts when exploded: its own Z-extent plus a
  // fixed gap, so it clears itself regardless of design scale.
  // Issue #132: the alignment pegs float halfway across the plate's own
  // gap, between the flange and the lowered plate, in line with their holes.
  const explodeOffsets = useMemo(() => {
    const offsets = new Map(parts.filter((p) => p.role !== "core" && p.role !== "peg").map((p) => [p.name, zExtent(p.mesh) + EXPLODE_GAP]));
    const plate = parts.find((p) => p.role === "mountPlate");
    for (const peg of parts.filter((p) => p.role === "peg")) offsets.set(peg.name, plate ? (offsets.get(plate.name) ?? 0) / 2 : 0);
    return offsets;
  }, [parts]);

  // Deliberately NOT creased (unlike the coil geometry above): a tube's own
  // radial facets would otherwise draw a spurious line at every facet ridge,
  // hatching the whole coil (see src/viewer/wireGeometry.ts / S3 spike RESULT.md).
  const wireGeometries = useMemo(() => {
    if (!showWire || !wireDiameter) return [];
    // Issue #115: the whole cable as ONE continuous tube -- no separately
    // drawn lead-in, transitions or end -- unless some layer has so many
    // turns it needs the envelope + hints treatment.
    if (cablePath && cablePath.length >= 6 && !needsEnvelope(wirePaths ?? [])) return [buildCableTube(cablePath, wireDiameter / 2)];
    const paths = wirePaths ? [...wirePaths] : [];
    // The inner-end lead-in (issue #8), every layer-to-layer transition and
    // the outer-end lead-out (issue #68) are drawn as more small paths
    // alongside the real layers -- `turns: 1` keeps them well under
    // wireGeometry.ts's TURNS_FOR_ENVELOPE, so they always get the full,
    // non-schematic tube regardless of how the layers themselves are drawn.
    if (innerEndLeadIn && innerEndLeadIn.length >= 6) paths.push({ layer: 0, turns: 1, points: innerEndLeadIn });
    for (const t of layerTransitions ?? []) {
      if (t.length >= 6) paths.push({ layer: 0, turns: 1, points: t });
    }
    if (outerEndLeadOut && outerEndLeadOut.length >= 6) paths.push({ layer: 0, turns: 1, points: outerEndLeadOut });
    if (!paths.length) return [];
    return buildWireGeometries(paths, wireDiameter / 2);
  }, [showWire, wirePaths, innerEndLeadIn, layerTransitions, outerEndLeadOut, cablePath, wireDiameter]);
  useEffect(() => () => wireGeometries.forEach((g) => g.dispose()), [wireGeometries]);

  // The rotation applied to every rendered geometry for the current view
  // (the wall-mount pose's own geometry rotation, the standing view's own
  // per-shape front-facing rotation, or the inner-end debug close-up's
  // azimuth spin) -- shared by `viewPartGeometries`/`viewWireGeometries`
  // below and by DimensionAxes (issue #69), which carries the identical
  // rotation on its own group so the axes stay on the geometry they
  // measure. `focusRotation` wins when active (not `??`'s usual left-to-
  // right order): the debug close-up (issue #8 PR review) must reproduce
  // its own existing checked-in screenshots (e2e/inner-end.spec.ts's SQUARE
  // case) UNCHANGED by issue #79's new standing-view rotation, which it
  // knows nothing about.
  const viewRotation = useMemo(() => focusRotation ?? viewRotations[viewMode], [viewRotations, viewMode, focusRotation]);

  // Wall-view preset: physically rotated COPIES of every part's geometry (not
  // the base `partGeometries`/`wireGeometries`, which the draft/final swap
  // and the crease pass above both key off of), so toggling the preset never
  // disturbs those.
  const viewPartGeometries = useMemo(() => {
    if (!viewRotation) return partGeometries;
    return partGeometries.map(({ part, geometry }) => {
      const rotated = geometry.clone();
      rotated.applyMatrix4(viewRotation);
      return { part, geometry: rotated };
    });
  }, [partGeometries, viewRotation]);
  useEffect(() => {
    if (viewPartGeometries === partGeometries) return;
    return () => viewPartGeometries.forEach(({ geometry }) => geometry.dispose());
  }, [viewPartGeometries, partGeometries]);

  // The dimension axes' box (issue #69), in the parts' local frame. Issue
  // #79: while STANDING, forced flush with the SAME flat `viewRotations.
  // standing` (frontFacing.ts) rotates the mesh to face -- see that module's
  // own doc comment on why an independent area search can disagree with it.
  // Only while standing: the forced angle is derived assuming a plain Z
  // rotation (`viewRotations.standing`); the wall-mount pose is a full 3D
  // basis change (`WALL_VIEW_ROTATION`), so composing the two wouldn't cancel
  // out the same way -- wallRoom keeps the plain area-search spin, same as
  // before this issue.
  const dimensionBox = useMemo(
    () => measureDimensionFrame(parts, viewMode === "standing" ? frontFacingDimensionSpin(shapeKind) : undefined),
    [parts, shapeKind, viewMode],
  );
  const dimensionMatrix = useMemo(() => (viewRotation ? viewRotation.clone().multiply(dimensionBox.spin) : dimensionBox.spin), [viewRotation, dimensionBox]);
  // Issue #93: the axes themselves, fixed in that box's frame -- their
  // origin corner is picked once from the default Iso camera, never per frame.
  const dimensionAxes = useMemo(() => {
    const toBox = dimensionMatrix.clone().invert();
    const iso = presetQuaternion("iso");
    const along = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyQuaternion(iso).transformDirection(toBox);
    return dimensionAxesGeometry(dimensionBox.box, dimensionBox.groundZ, along(1, 0, 0), along(0, 0, 1));
  }, [dimensionBox, dimensionMatrix]);

  const dimensionLabels = useMemo((): DimensionLabels | null => {
    if (envelopeWidth === undefined || shapeKind === undefined || dimensionBox.box.isEmpty()) return null;
    const size = dimensionBox.box.getSize(new THREE.Vector3());
    const cm = (mm: number) => `${(mm / 10).toFixed(1)} cm`;
    const across = (mm: number) => (shapeKind === "round" ? `Ø ${cm(envelopeWidth)}` : cm(mm));
    return { width: across(size.x), depth: across(size.y), height: cm(overallHeight ?? size.z) };
  }, [dimensionBox, envelopeWidth, shapeKind, overallHeight]);

  const viewWireGeometries = useMemo(() => {
    if (!viewRotation) return wireGeometries;
    return wireGeometries.map((g) => {
      const rotated = g.clone();
      rotated.applyMatrix4(viewRotation);
      return rotated;
    });
  }, [wireGeometries, viewRotation]);
  useEffect(() => {
    if (viewWireGeometries === wireGeometries) return;
    return () => viewWireGeometries.forEach((g) => g.dispose());
  }, [viewWireGeometries, wireGeometries]);

  // Print layout (issue #78): an entirely SEPARATE scene -- every part in
  // its own print-bed placement (core's `printPlacements`, shared with the
  // 3MF writer) laid out on a drawn bed rectangle -- not a rotated copy of
  // the assembled `viewPartGeometries` above (a rotation alone could never
  // separate the parts onto their own plate positions). Built only while
  // this view is actually showing; the debug close-up and the wall view
  // never combine with it (see `handlePresetChange`).
  const printLayout = useMemo(() => (viewMode === "printLayout" ? buildPrintLayout(parts, bed) : null), [viewMode, parts, bed]);
  const printLayoutParts = useMemo(() => {
    if (!printLayout) return null;
    return printLayout.parts.map(({ part, mesh, box, transform }) => ({ part, geometry: buildCreasedGeometry(mesh), box, transform }));
  }, [printLayout]);
  useEffect(() => {
    if (!printLayoutParts) return;
    return () => printLayoutParts.forEach(({ geometry }) => geometry.dispose());
  }, [printLayoutParts]);
  const printLayoutBedGeometry = useMemo(() => (viewMode === "printLayout" ? buildBedGeometry(bed) : null), [viewMode, bed]);
  useEffect(() => () => printLayoutBedGeometry?.dispose(), [printLayoutBedGeometry]);
  // A stable reference (memoized on `printLayoutParts` itself, not rebuilt
  // every render): PrintLayoutLabels.tsx memoizes its own sprites on this
  // array's identity, so a fresh array literal here every render would
  // rebuild (and re-draw) every label's canvas texture every frame.
  // Issue #132: the two small alignment pegs lie side by side, so they share
  // one label ("pegs x2") over their joint box instead of two overlapping ones.
  const printLayoutLabelParts = useMemo(() => {
    if (!printLayoutParts) return null;
    const pegs = printLayoutParts.filter(({ part }) => part.role === "peg");
    const labels = printLayoutParts.filter(({ part }) => part.role !== "peg").map(({ part, box }) => ({ name: part.name, box }));
    if (pegs.length > 0) labels.push({ name: `pegs \u00d7${pegs.length}`, box: pegs.reduce((box, p) => box.union(p.box), new THREE.Box3()) });
    return labels;
  }, [printLayoutParts]);

  // Frames the WHOLE bed (not just the parts) AND the labels' own shared
  // callout row (PrintLayoutLabels.tsx, issue #78 PR review: a fixed margin
  // past the layout's own Y extent, on EITHER side -- the row can land on
  // whichever side the camera currently looks from), so neither the drawn
  // bed rectangle nor a label is ever cropped by the shot.
  const printLayoutFramingGeometry = useMemo(() => {
    if (!printLayout || !printLayoutParts) return null;
    const { bounds } = printLayout;
    const chunks = printLayoutParts.map(({ geometry }) => (geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array);
    const labelRowMargin = Math.max(8, 0.1 * bounds.getSize(new THREE.Vector3()).y);
    const corners: number[] = [];
    for (const x of [bounds.min.x, bounds.max.x])
      for (const y of [bounds.min.y - labelRowMargin, bounds.max.y + labelRowMargin])
        for (const z of [bounds.min.z, bounds.max.z]) corners.push(x, y, z);
    chunks.push(new Float32Array(corners));
    const merged = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      merged.set(c, at);
      at += c.length;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(merged, 3));
    return geometry;
  }, [printLayout, printLayoutParts]);
  useEffect(() => () => printLayoutFramingGeometry?.dispose(), [printLayoutFramingGeometry]);

  // The exploded-view lift direction: the coil's own axis, wherever the
  // current preset renders it (see EXPLODE_AXES above).
  const explodeAxis = useMemo(() => EXPLODE_AXES[viewMode], [viewMode]);

  // Issue #14: the mount plate sits on the OPPOSITE side of the core from
  // the top cap (bottom flange's outer face, negative local Z, vs. the
  // cap's positive local Z past `solution.height`) -- exploding it along
  // the SAME fixed `explodeAxis` the cap uses would lift it INTO the core
  // instead of away from it. Every other non-core part (currently only the
  // top cap) keeps the shared axis as-is.
  // Always a FRESH clone: both call sites below mutate the vector they get
  // back (`.multiplyScalar`/`ExplodedPart`'s own per-frame `.copy`), so
  // returning the shared `explodeAxis` object as-is for the top-cap case
  // would corrupt it for every other reader.
  const explodeAxisFor = (role: Part["role"]): THREE.Vector3 => (role === "mountPlate" || role === "peg" ? explodeAxis.clone().negate() : explodeAxis.clone());

  // A stable framing geometry (issue #9, reworked for #15): every non-core
  // part contributes its FULLY exploded position whenever `exploded` is on,
  // and its assembled (unshifted) position otherwise -- so toggling explode
  // now genuinely reframes (issue #9 review: "consider a slight camera
  // reframe while exploded"), via LineArtRenderer's own tweened-fit
  // transition (issue #15), rather than always framing the union of both so
  // toggling never has to move the camera at all. Built from the (possibly
  // wall-view-rotated) part geometries, so framing always matches what's
  // actually on screen. Position-only (no index/normals needed):
  // LineArtRenderer only reads bounding-sphere/vertex bounds from it.
  const framingGeometry = useMemo(() => {
    const chunks = viewPartGeometries.map(({ part, geometry }) => {
      const offset = exploded ? (explodeOffsets.get(part.name) ?? 0) : 0;
      const positions = (geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
      if (offset === 0) return positions;
      const shift = explodeAxisFor(part.role).multiplyScalar(offset);
      const shifted = new Float32Array(positions.length);
      for (let i = 0; i < shifted.length; i += 3) {
        shifted[i] = positions[i] + shift.x;
        shifted[i + 1] = positions[i + 1] + shift.y;
        shifted[i + 2] = positions[i + 2] + shift.z;
      }
      return shifted;
    });
    // Issue #69: room for the dimension axes and their labels (kept even when
    // they are toggled off, so the toggle never zooms the model).
    if (!exploded && dimensionLabels && viewMode !== "mountSide") {
      const points = dimensionFramePoints(dimensionAxes);
      new THREE.BufferAttribute(points, 3).applyMatrix4(dimensionMatrix);
      chunks.push(points);
    }
    const merged = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      merged.set(c, at);
      at += c.length;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(merged, 3));
    return geometry;
  }, [viewPartGeometries, explodeOffsets, explodeAxis, exploded, dimensionLabels, dimensionAxes, dimensionMatrix, viewMode]);
  useEffect(() => () => framingGeometry.dispose(), [framingGeometry]);

  // Debug close-up (continued): a SMALL framing geometry -- just
  // `innerEndLeadIn`'s own extent (keyhole to groove start), rotated the
  // same way as the rendered parts above -- so LineArtRenderer's fit zooms
  // tight on that region instead of the whole model (its `geometry` prop
  // only ever drives the camera FIT; the actual RENDERED scene is every
  // `<mesh>` in the Canvas below, unaffected by this substitution -- see
  // LineArtRenderer's own file header). Two extra points, far along iso's
  // own view direction from the keyhole (a zero contribution to the
  // on-screen X/Y fit -- lookAt's local Z axis IS that direction, so an
  // offset purely along it always resolves to local (0,0,+-k) -- see
  // computeFit's own rotation/inverse math), keep the fit's near/far planes
  // wide enough to cover the ACTUAL (much bigger) rendered model instead of
  // clipping it to this tiny region's own bounding sphere.
  const focusFramingGeometry = useMemo(() => {
    if (!focusRotation || !focusPath || focusPath.length < 6) return null;
    // Rotate the real lead-in points FIRST: the far points below are placed
    // along the camera's own (unrotated) view direction, so they must be
    // anchored to the ALREADY-rotated keyhole position, not rotated a
    // second time themselves (which would misalign them with that
    // direction and corrupt the on-screen fit).
    const rotatedLeadIn = new Float32Array(focusPath.length);
    const p = new THREE.Vector3();
    for (let i = 0; i < focusPath.length; i += 3) {
      p.set(focusPath[i], focusPath[i + 1], focusPath[i + 2]).applyMatrix4(focusRotation);
      rotatedLeadIn[i] = p.x;
      rotatedLeadIn[i + 1] = p.y;
      rotatedLeadIn[i + 2] = p.z;
    }
    const isoDirection = getPreset("iso").direction;
    const anchor = new THREE.Vector3(rotatedLeadIn[focusIndex * 3], rotatedLeadIn[focusIndex * 3 + 1], rotatedLeadIn[focusIndex * 3 + 2]);
    const FAR_RADIUS = 600; // mm, comfortably past the solver's own SIZE_HI (500mm) upper bound
    const far1 = anchor.clone().addScaledVector(isoDirection, FAR_RADIUS);
    const far2 = anchor.clone().addScaledVector(isoDirection, -FAR_RADIUS);
    const positions = new Float32Array(rotatedLeadIn.length + 6);
    positions.set(rotatedLeadIn, 0);
    positions.set([far1.x, far1.y, far1.z, far2.x, far2.y, far2.z], rotatedLeadIn.length);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geometry;
  }, [focusRotation, focusPath, focusIndex]);
  useEffect(() => () => focusFramingGeometry?.dispose(), [focusFramingGeometry]);

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
      {VIEW_CAPTION[viewMode] && (
        <p className="wall-view-caption" data-testid="wall-view-caption">
          {VIEW_CAPTION[viewMode]}
        </p>
      )}
      <Canvas
        flat
        frameloop="demand"
        gl={{ alpha: true, antialias: false, preserveDrawingBuffer: true }}
        style={{ width: "100%", height: "100%", background: "transparent" }}
      >
        {printLayoutParts && printLayoutBedGeometry && printLayout && printLayoutLabelParts ? (
          <>
            <mesh geometry={printLayoutBedGeometry} />
            {printLayoutParts.map(({ part, geometry }) => (
              <mesh key={part.name} geometry={geometry} />
            ))}
            <PrintLayoutLabels parts={printLayoutLabelParts} bounds={printLayout.bounds} />
          </>
        ) : (
          <>
            {viewPartGeometries.map(({ part, geometry }) =>
              part.role === "core" ? (
                <mesh key={part.name} geometry={geometry} />
              ) : (
                <ExplodedPart key={part.name} geometry={geometry} offset={explodeOffsets.get(part.name) ?? 0} axis={explodeAxisFor(part.role)} exploded={exploded} reducedMotion={reducedMotion} />
              ),
            )}
            {viewWireGeometries.map((g, i) => (
              <mesh key={i} geometry={g} />
            ))}
            {(viewMode === "mountSide" || viewMode === "wallRoom") && pegboard && !exploded && (
              <PegboardSlots board={pegboard} rotation={viewRotation} face={viewMode === "mountSide" ? "back" : "front"} />
            )}
          </>
        )}
        <LineArtRenderer
          geometry={printLayoutFramingGeometry ?? focusFramingGeometry ?? framingGeometry}
          controlsRef={controlsRef}
          projection={projection}
          preset={effectivePreset}
          fill={printLayoutFramingGeometry ? undefined : focusFramingGeometry ? FOCUS_FILL : exploded ? EXPLODED_FILL : undefined}
          reducedMotion={reducedMotion}
          resolution={resolution}
        />
        {/* Issue #69: hidden while exploded, in the inner-end debug close-up,
            or in the print-layout view (issue #78 AC: hidden, or showing the
            bed size -- its own caption above already names the bed) -- none
            of those measure the assembled pose. */}
        {showDimensions && !exploded && !focusFramingGeometry && !printLayoutParts && viewMode !== "mountSide" && dimensionLabels && (
          <DimensionAxes axes={dimensionAxes} rotation={dimensionMatrix} labels={dimensionLabels} roundGroundLabel={shapeKind === "round"} />

        )}
        <OrbitControls ref={controlsRef} makeDefault enableDamping={false} />
      </Canvas>
      {/* The same values as text, for screen readers (the axes' labels are
          drawn inside the canvas). */}
      {showDimensions && !exploded && !focusFramingGeometry && !printLayoutParts && viewMode !== "mountSide" && dimensionLabels && (
        <ul className="visually-hidden" data-testid="dimensions" aria-label="Overall dimensions">
          <li>
            Width <span data-testid="dimension-width">{dimensionLabels.width}</span>
          </li>
          <li>
            Depth <span data-testid="dimension-depth">{dimensionLabels.depth}</span>
          </li>
          <li>
            Height <span data-testid="dimension-height">{dimensionLabels.height}</span>
          </li>
        </ul>
      )}
      {/* Issue #78: each part's own EXACT print-bed transform, mirrored as
          text (like the dimensions list above) both for screen readers and
          so e2e coverage can confirm it against the 3MF export's own item
          transform (`printPlacements`, the one function both read) without
          re-deriving positions from rendered pixels. */}
      {printLayoutParts && (
        <ul className="visually-hidden" data-testid="print-layout-parts" aria-label="Parts on the print bed">
          {printLayoutParts.map(({ part, transform }) => (
            <li key={part.name} data-testid={`print-layout-part-${part.name}`}>
              {part.name}: rotateX={transform.rotateX.toFixed(6)}, x={transform.translate[0].toFixed(3)}mm, y={transform.translate[1].toFixed(3)}mm, z={transform.translate[2].toFixed(3)}mm
            </li>
          ))}
        </ul>
      )}
      <ViewControls preset={effectivePreset} onPresetChange={handlePresetChange} showMountSide={!!pegboard} />
    </div>
  );
}
