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
import { LineArtRenderer, markFaceKinds, type Projection } from "./lineArt/LineArtRenderer";
import { getPreset, presetQuaternion, type PresetId } from "./lineArt/presets";
import { mountClipsLabel } from "./partLabels";
import { PegboardSlots } from "./PegboardSlots";
import { PrintLayoutLabels } from "./PrintLayoutLabels";
import { buildBedGeometry, buildPrintLayout } from "./printLayoutScene";
import { ViewControls } from "./ViewControls";
import { useThrowOnContextLoss } from "./ViewerBoundary";
import { WALL_MOUNT_VIEW_ROTATION, WALL_VIEW_ROTATION, withMountAxisCorrection } from "./wallRotations";
import { buildCableTube, buildWireGeometries, needsEnvelope } from "./wireGeometry";

const CREASE_ANGLE = (30 * Math.PI) / 180;

const EXPLODE_VISIBILITY_MARGIN_MM = 15;
const EXPLODE_GAP_MM = JOINT_ENGAGE_DEPTH + JOINT_TRANSITION_HEIGHT + 1.5 * CAP_THICKNESS + EXPLODE_VISIBILITY_MARGIN_MM;
const EXPLODE_EASE_RATE_PER_SECOND = 9;
const EXPLODE_SETTLE_EPS_MM = 0.01;
const EXPLODED_FILL = 0.85;
const FOCUS_FILL = 0.4;

export interface CoilViewerProps {
  parts: Part[];
  resolution: Resolution;
  wirePaths?: WireLayerPath[];
  innerEndLeadIn?: Float32Array;
  layerTransitions?: Float32Array[];
  outerEndLeadOut?: Float32Array;
  cablePath?: Float32Array;
  wireDiameter?: number;
  showWire?: boolean;
  exploded?: boolean;
  mountAxisDeg?: number;
  envelopeWidth?: number;
  overallHeight?: number;
  shapeKind?: ShapeKind;
  showDimensions?: boolean;
  bed: PrintSpec;
  onPrintLayoutActiveChange?: (active: boolean) => void;
  mountKind?: MountKind;
  pegboard?: PegboardSection;
  projection?: Projection;
}

function singleTurnPath(points: Float32Array): WireLayerPath {
  return { layer: 0, turns: 1, points };
}

function restartCssAnimation(el: HTMLElement, className: string) {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
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

function useElementHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setHeight(el.clientHeight);
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}

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
  markFaceKinds(creased, mesh);
  return creased;
}

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
    invalidate();
  }, [target, invalidate]);

  useFrame((_, delta) => {
    const group = groupRef.current;
    if (!group) return;
    if (reducedMotion) {
      current.current = target;
      group.position.copy(axis).multiplyScalar(target);
      return;
    }
    const next = THREE.MathUtils.damp(current.current, target, EXPLODE_EASE_RATE_PER_SECOND, delta);
    current.current = next;
    group.position.copy(axis).multiplyScalar(next);
    if (Math.abs(next - target) > EXPLODE_SETTLE_EPS_MM) invalidate();
  });

  return (
    <group ref={groupRef}>
      <mesh geometry={geometry} />
    </group>
  );
}


type ViewMode = "standing" | "wallRoom" | "mountSide" | "printLayout";

function buildViewRotations(mountAxisDeg: number | undefined, shapeKind: ShapeKind | undefined): Record<ViewMode, THREE.Matrix4 | null> {
  return {
    standing: frontFacingRotation(shapeKind),
    wallRoom: withMountAxisCorrection(WALL_VIEW_ROTATION, mountAxisDeg),
    mountSide: withMountAxisCorrection(WALL_MOUNT_VIEW_ROTATION, mountAxisDeg),
    printLayout: null,
  };
}

const ROLES_EXPLODING_AWAY_FROM_CAP: Part["role"][] = ["mountPlate", "peg", "mountClip"];

const EXPLODE_AXES: Record<ViewMode, THREE.Vector3> = {
  standing: new THREE.Vector3(0, 0, 1),
  wallRoom: new THREE.Vector3(1, 0, 0),
  mountSide: new THREE.Vector3(0, 0, 1).applyMatrix4(WALL_MOUNT_VIEW_ROTATION),
  printLayout: new THREE.Vector3(0, 0, 1),
};

const VIEW_CAPTION: Partial<Record<ViewMode, string>> = {
  wallRoom: "Bottom flange against the wall -- top cap faces the room",
  mountSide: "Seen from behind the wall -- each clip in its SKÅDIS slot (grey)",
  printLayout: "Every part rests flat on the bed -- no supports needed",
};

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
  const frameHeight = useElementHeight(frameRef);
  const [viewMode, setViewMode] = useState<ViewMode>("standing");
  const debugFocusEnd = useDebugFocusEnd();
  const { fromBelow: debugFocusFromBelow, radius: debugFocusRadius } = useDebugFocusOptions();
  const focusPath = useMemo(() => {
    const path = debugFocusEnd === "inner" ? innerEndLeadIn : debugFocusEnd === "outer" ? outerEndLeadOut : undefined;
    if (!path || path.length < 6 || !Number.isFinite(debugFocusRadius)) return path;
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

  const prevMountKind = useRef<MountKind | undefined>(mountKind);
  useEffect(() => {
    const prev = prevMountKind.current;
    prevMountKind.current = mountKind;
    if (prev !== mountKind && (mountKind === "skadis" || mountKind === "skadis-tclip") && pegboard) setViewMode("mountSide");
  }, [mountKind, pegboard]);
  useEffect(() => {
    if (!pegboard) setViewMode((mode) => (mode === "mountSide" ? "standing" : mode));
  }, [pegboard]);

  const focusRotation = useMemo(() => {
    if (viewMode !== "standing" || !focusPath || focusPath.length < 6) return null;
    const isoAzimuth = Math.atan2(getPreset("iso").direction.y, getPreset("iso").direction.x);
    const keyholeAzimuth = Math.atan2(focusPath[focusIndex * 3 + 1], focusPath[focusIndex * 3]);
    const turn = new THREE.Matrix4().makeRotationZ(isoAzimuth - keyholeAzimuth);
    if (!debugFocusFromBelow) return turn;
    return new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(Math.cos(isoAzimuth), Math.sin(isoAzimuth), 0), Math.PI).multiply(turn);
  }, [viewMode, focusPath, focusIndex, debugFocusFromBelow]);

  const partGeometries = useMemo(() => parts.map((part) => ({ part, geometry: buildCreasedGeometry(part.mesh) })), [parts]);
  useEffect(() => () => partGeometries.forEach(({ geometry }) => geometry.dispose()), [partGeometries]);

  const [preset, setPreset] = useState<PresetId>("iso");

  const effectivePreset: PresetId = viewMode === "standing" ? preset : viewMode;

  const handlePresetChange = (id: PresetId) => {
    if (id === "wallRoom" || id === "mountSide" || id === "printLayout") {
      setViewMode(id);
    } else {
      setViewMode("standing");
      setPreset(id);
    }
  };

  const explodeOffsets = useMemo(() => {
    const offsets = new Map(parts.filter((p) => p.role !== "core" && p.role !== "peg").map((p) => [p.name, zExtent(p.mesh) + EXPLODE_GAP_MM]));
    const plate = parts.find((p) => p.role === "mountPlate");
    const plateLift = plate ? (offsets.get(plate.name) ?? 0) : 0;
    for (const peg of parts.filter((p) => p.role === "peg")) offsets.set(peg.name, plateLift / 2);
    return offsets;
  }, [parts]);

  const envelope = useMemo(() => needsEnvelope(wirePaths ?? [], (wireDiameter ?? 0) / 2, frameHeight), [wirePaths, wireDiameter, frameHeight]);
  const wireGeometries = useMemo(() => {
    if (!showWire || !wireDiameter) return [];
    if (cablePath && cablePath.length >= 6 && !envelope) return [buildCableTube(cablePath, wireDiameter / 2)];
    const paths = wirePaths ? [...wirePaths] : [];
    if (innerEndLeadIn && innerEndLeadIn.length >= 6) paths.push(singleTurnPath(innerEndLeadIn));
    for (const t of layerTransitions ?? []) {
      if (t.length >= 6) paths.push(singleTurnPath(t));
    }
    if (outerEndLeadOut && outerEndLeadOut.length >= 6) paths.push(singleTurnPath(outerEndLeadOut));
    if (!paths.length) return [];
    return buildWireGeometries(paths, wireDiameter / 2, envelope);
  }, [showWire, wirePaths, innerEndLeadIn, layerTransitions, outerEndLeadOut, cablePath, wireDiameter, envelope]);
  useEffect(() => () => wireGeometries.forEach((g) => g.dispose()), [wireGeometries]);

  const viewRotation = useMemo(() => focusRotation ?? viewRotations[viewMode], [viewRotations, viewMode, focusRotation]);

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

  const dimensionBox = useMemo(
    () => measureDimensionFrame(parts, viewMode === "standing" ? frontFacingDimensionSpin(shapeKind) : undefined),
    [parts, shapeKind, viewMode],
  );
  const dimensionMatrix = useMemo(() => (viewRotation ? viewRotation.clone().multiply(dimensionBox.spin) : dimensionBox.spin), [viewRotation, dimensionBox]);
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
  const printLayoutLabelParts = useMemo(() => {
    if (!printLayoutParts) return null;
    const pegs = printLayoutParts.filter(({ part }) => part.role === "peg");
    const clips = printLayoutParts.filter(({ part }) => part.role === "mountClip");
    const labels = printLayoutParts.filter(({ part }) => part.role !== "peg" && part.role !== "mountClip").map(({ part, box }) => ({ name: part.name, box }));
    if (pegs.length > 0) labels.push({ name: `pegs \u00d7${pegs.length}`, box: pegs.reduce((box, p) => box.union(p.box), new THREE.Box3()) });
    if (clips.length > 0) labels.push({ name: mountClipsLabel(clips.map(({ part }) => part)), box: clips.reduce((box, p) => box.union(p.box), new THREE.Box3()) });
    return labels;
  }, [printLayoutParts]);

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

  const explodeAxis = useMemo(() => EXPLODE_AXES[viewMode], [viewMode]);

  const newExplodeAxisFor = (role: Part["role"]): THREE.Vector3 => (ROLES_EXPLODING_AWAY_FROM_CAP.includes(role) ? explodeAxis.clone().negate() : explodeAxis.clone());

  const framingGeometry = useMemo(() => {
    const chunks = viewPartGeometries.map(({ part, geometry }) => {
      const offset = exploded ? (explodeOffsets.get(part.name) ?? 0) : 0;
      const positions = (geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
      if (offset === 0) return positions;
      const shift = newExplodeAxisFor(part.role).multiplyScalar(offset);
      const shifted = new Float32Array(positions.length);
      for (let i = 0; i < shifted.length; i += 3) {
        shifted[i] = positions[i] + shift.x;
        shifted[i + 1] = positions[i + 1] + shift.y;
        shifted[i + 2] = positions[i + 2] + shift.z;
      }
      return shifted;
    });
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

  const focusFramingGeometry = useMemo(() => {
    if (!focusRotation || !focusPath || focusPath.length < 6) return null;
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
    const FAR_RADIUS_MM = 600;
    const far1 = anchor.clone().addScaledVector(isoDirection, FAR_RADIUS_MM);
    const far2 = anchor.clone().addScaledVector(isoDirection, -FAR_RADIUS_MM);
    const positions = new Float32Array(rotatedLeadIn.length + 6);
    positions.set(rotatedLeadIn, 0);
    positions.set([far1.x, far1.y, far1.z, far2.x, far2.y, far2.z], rotatedLeadIn.length);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geometry;
  }, [focusRotation, focusPath, focusIndex]);
  useEffect(() => () => focusFramingGeometry?.dispose(), [focusFramingGeometry]);

  useEffect(() => {
    const swapped = prevResolution.current === "draft" && resolution === "final";
    prevResolution.current = resolution;
    if (!swapped) return;
    const el = frameRef.current;
    if (!el) return;
    restartCssAnimation(el, "edge-fade");
  }, [parts, resolution]);

  const dimensionsShown = showDimensions && !exploded && !focusFramingGeometry && !printLayoutParts && viewMode !== "mountSide";

  const onCanvasCreated = useThrowOnContextLoss();

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
        onCreated={onCanvasCreated}
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
                <ExplodedPart key={part.name} geometry={geometry} offset={explodeOffsets.get(part.name) ?? 0} axis={newExplodeAxisFor(part.role)} exploded={exploded} reducedMotion={reducedMotion} />
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
        {dimensionsShown && dimensionLabels && (
          <DimensionAxes axes={dimensionAxes} rotation={dimensionMatrix} labels={dimensionLabels} roundGroundLabel={shapeKind === "round"} />
        )}
        <OrbitControls ref={controlsRef} makeDefault enableDamping={false} />
      </Canvas>
      {dimensionsShown && dimensionLabels && (
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
      {printLayoutParts && (
        <ul className="visually-hidden" data-testid="print-layout-parts" aria-label="Parts on the print bed">
          {printLayoutParts.map(({ part, transform }) => (
            <li key={part.name} data-testid={`print-layout-part-${part.name}`}>
              {part.name}: rotateZ={(transform.rotateZ ?? 0).toFixed(6)}, rotateX={transform.rotateX.toFixed(6)}, x={transform.translate[0].toFixed(3)}mm, y={transform.translate[1].toFixed(3)}mm, z={transform.translate[2].toFixed(3)}mm
            </li>
          ))}
        </ul>
      )}
      <ViewControls preset={effectivePreset} onPresetChange={handlePresetChange} showMountSide={!!pegboard} />
    </div>
  );
}
