import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { CAP_THICKNESS, JOINT_ENGAGE_DEPTH, JOINT_TRANSITION_HEIGHT } from "../core";
import type { CoilMesh, Part, Resolution, ShapeKind, WireLayerPath } from "../core";
import { DimensionAxes, dimensionFramePoints, measureDimensionFrame, type DimensionLabels } from "./DimensionAxes";
import { LineArtRenderer, type Projection } from "./lineArt/LineArtRenderer";
import { getPreset, type PresetId } from "./lineArt/presets";
import { ViewControls } from "./ViewControls";
import { WALL_VIEW_ROTATION, withMountAxisCorrection } from "./wallRotations";
import { buildWireGeometries } from "./wireGeometry";

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
  /** `Design.outerEndLeadOut` (issue #68): from the last wound layer's own end to the top cap's rim keyhole, drawn the same way as `innerEndLeadIn`. Omitted/too short to draw none. */
  outerEndLeadOut?: Float32Array;
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

type ViewMode = "standing" | "wallRoom";

function buildViewRotations(mountAxisDeg: number | undefined): Record<ViewMode, THREE.Matrix4 | null> {
  return {
    standing: null,
    wallRoom: withMountAxisCorrection(WALL_VIEW_ROTATION, mountAxisDeg),
  };
}

// The coil's own axis (local +Z), wherever each preset renders it -- see
// wallRotations.ts's WALL_REMAP comment for the room-side case (world +X; a
// rotation about world X, its spin correction, never moves points along
// world X, so it needs no correction of its own).
const EXPLODE_AXES: Record<ViewMode, THREE.Vector3> = {
  standing: new THREE.Vector3(0, 0, 1),
  wallRoom: new THREE.Vector3(1, 0, 0),
};

const VIEW_CAPTION: Partial<Record<ViewMode, string>> = {
  wallRoom: "Bottom flange against the wall -- top cap faces the room",
};

/**
 * Screenshot-only close-up on the bottom flange's own inner-end keyhole +
 * channel (issue #8 PR review), gated behind `?debugFocusInnerEnd=1`
 * (checked once at mount, not reactively -- a screenshot tool, not a user
 * control).
 */
function useDebugFocusInnerEnd(): boolean {
  const [enabled] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return new URLSearchParams(window.location.search).get("debugFocusInnerEnd") === "1";
    } catch {
      return false;
    }
  });
  return enabled;
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
  wireDiameter,
  showWire = true,
  exploded = false,
  mountAxisDeg,
  envelopeWidth,
  overallHeight,
  shapeKind,
  showDimensions = true,
}: CoilViewerProps) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const prevResolution = useRef<Resolution>(resolution);
  const reducedMotion = usePrefersReducedMotion();
  const [viewMode, setViewMode] = useState<ViewMode>("standing");
  const debugFocusInnerEnd = useDebugFocusInnerEnd();
  const viewRotations = useMemo(() => buildViewRotations(mountAxisDeg), [mountAxisDeg]);

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
    if (!debugFocusInnerEnd || viewMode !== "standing" || !innerEndLeadIn || innerEndLeadIn.length < 6) return null;
    const isoAzimuth = Math.atan2(getPreset("iso").direction.y, getPreset("iso").direction.x);
    const keyholeAzimuth = Math.atan2(innerEndLeadIn[1], innerEndLeadIn[0]);
    return new THREE.Matrix4().makeRotationZ(isoAzimuth - keyholeAzimuth);
  }, [debugFocusInnerEnd, viewMode, innerEndLeadIn]);

  const partGeometries = useMemo(() => parts.map((part) => ({ part, geometry: buildCreasedGeometry(part.mesh) })), [parts]);
  useEffect(() => () => partGeometries.forEach(({ geometry }) => geometry.dispose()), [partGeometries]);

  // Camera view controls (issue #15, trimmed to Front/Iso/Wall mount by
  // issue #49): both are purely viewer-internal (no bearing on the design
  // itself), so they're owned here rather than lifted to App -- they reset
  // on reload, same as the exploded-view toggle. `preset` only ever holds a
  // STANDING-camera value (front/iso): the wall preset is represented by
  // `viewMode` instead (issue #13, see `effectivePreset` below), since it's
  // really a geometry rotation this component already owned, not a new
  // camera direction of its own.
  const [projection, setProjection] = useState<Projection>("ortho");
  const [preset, setPreset] = useState<PresetId>("iso");

  // The preset this render actually asks LineArtRenderer for, and what
  // ViewControls highlights as active: `viewMode`'s own wall preset once a
  // wall view is on (both wall rotations assume the camera sits at "iso" --
  // see VIEW_PRESETS' own comment in presets.ts), else whatever standing
  // camera preset was last chosen.
  const effectivePreset: PresetId = viewMode === "standing" ? preset : viewMode;

  /** Clicking Front/Iso exits the wall view; clicking "Wall mount" sets the
   * `viewMode` that rotates the geometry into its as-hung pose. */
  const handlePresetChange = (id: PresetId) => {
    if (id === "wallRoom") {
      setViewMode(id);
    } else {
      setViewMode("standing");
      setPreset(id);
    }
  };

  // How far each non-core part lifts when exploded: its own Z-extent plus a
  // fixed gap, so it clears itself regardless of design scale.
  const explodeOffsets = useMemo(() => new Map(parts.filter((p) => p.role !== "core").map((p) => [p.name, zExtent(p.mesh) + EXPLODE_GAP])), [parts]);

  // Deliberately NOT creased (unlike the coil geometry above): a tube's own
  // radial facets would otherwise draw a spurious line at every facet ridge,
  // hatching the whole coil (see src/viewer/wireGeometry.ts / S3 spike RESULT.md).
  const wireGeometries = useMemo(() => {
    if (!showWire || !wireDiameter) return [];
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
  }, [showWire, wirePaths, innerEndLeadIn, layerTransitions, outerEndLeadOut, wireDiameter]);
  useEffect(() => () => wireGeometries.forEach((g) => g.dispose()), [wireGeometries]);

  // The rotation applied to every rendered geometry for the current view
  // (the wall-mount pose's own geometry rotation, or the inner-end debug
  // close-up's azimuth spin) -- shared by `viewPartGeometries`/
  // `viewWireGeometries` below and by DimensionAxes (issue #69), which
  // carries the identical rotation on its own group so the axes stay on the
  // geometry they measure.
  const viewRotation = useMemo(() => viewRotations[viewMode] ?? focusRotation, [viewRotations, viewMode, focusRotation]);

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

  // The dimension axes' box (issue #69), in the parts' local frame.
  const dimensionBox = useMemo(() => measureDimensionFrame(parts), [parts]);
  const dimensionMatrix = useMemo(() => (viewRotation ? viewRotation.clone().multiply(dimensionBox.spin) : dimensionBox.spin), [viewRotation, dimensionBox]);

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
  const explodeAxisFor = (role: Part["role"]): THREE.Vector3 => (role === "mountPlate" ? explodeAxis.clone().negate() : explodeAxis.clone());

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
    if (!exploded && dimensionLabels) {
      const points = dimensionFramePoints(dimensionBox.box, dimensionBox.groundZ);
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
  }, [viewPartGeometries, explodeOffsets, explodeAxis, exploded, dimensionLabels, dimensionBox, dimensionMatrix]);
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
    if (!focusRotation || !innerEndLeadIn || innerEndLeadIn.length < 6) return null;
    // Rotate the real lead-in points FIRST: the far points below are placed
    // along the camera's own (unrotated) view direction, so they must be
    // anchored to the ALREADY-rotated keyhole position, not rotated a
    // second time themselves (which would misalign them with that
    // direction and corrupt the on-screen fit).
    const rotatedLeadIn = new Float32Array(innerEndLeadIn.length);
    const p = new THREE.Vector3();
    for (let i = 0; i < innerEndLeadIn.length; i += 3) {
      p.set(innerEndLeadIn[i], innerEndLeadIn[i + 1], innerEndLeadIn[i + 2]).applyMatrix4(focusRotation);
      rotatedLeadIn[i] = p.x;
      rotatedLeadIn[i + 1] = p.y;
      rotatedLeadIn[i + 2] = p.z;
    }
    const isoDirection = getPreset("iso").direction;
    const anchor = new THREE.Vector3(rotatedLeadIn[0], rotatedLeadIn[1], rotatedLeadIn[2]);
    const FAR_RADIUS = 600; // mm, comfortably past the solver's own SIZE_HI (500mm) upper bound
    const far1 = anchor.clone().addScaledVector(isoDirection, FAR_RADIUS);
    const far2 = anchor.clone().addScaledVector(isoDirection, -FAR_RADIUS);
    const positions = new Float32Array(rotatedLeadIn.length + 6);
    positions.set(rotatedLeadIn, 0);
    positions.set([far1.x, far1.y, far1.z, far2.x, far2.y, far2.z], rotatedLeadIn.length);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geometry;
  }, [focusRotation, innerEndLeadIn]);
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
        <LineArtRenderer
          geometry={focusFramingGeometry ?? framingGeometry}
          controlsRef={controlsRef}
          projection={projection}
          preset={effectivePreset}
          fill={focusFramingGeometry ? FOCUS_FILL : exploded ? EXPLODED_FILL : undefined}
          reducedMotion={reducedMotion}
          resolution={resolution}
        />
        {/* Issue #69: hidden while exploded (or in the inner-end debug
            close-up) -- they measure the assembled pose. */}
        {showDimensions && !exploded && !focusFramingGeometry && dimensionLabels && (
          <DimensionAxes box={dimensionBox.box} groundZ={dimensionBox.groundZ} rotation={dimensionMatrix} labels={dimensionLabels} />
        )}
        <OrbitControls ref={controlsRef} makeDefault enableDamping={false} />
      </Canvas>
      {/* The same values as text, for screen readers (the axes' labels are
          drawn inside the canvas). */}
      {showDimensions && !exploded && !focusFramingGeometry && dimensionLabels && (
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
      <ViewControls preset={effectivePreset} onPresetChange={handlePresetChange} projection={projection} onProjectionChange={setProjection} />
    </div>
  );
}
