import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useStore, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { CoilMesh, Resolution } from "../../core";
import { EdgeShader } from "./edgeShader";
import { MAX_THICKEN_RADIUS, ThickenShader } from "./thickenShader";
import { directionAndUpOf, getPreset, presetQuaternion, type PresetId } from "./presets";

export type Projection = "ortho" | "perspective";

declare global {
  interface Window {
    __framingTweenCount?: number;
    __orbitAzimuthDeg?: number;
    __orbitByDeg?: (deltaDeg: number) => void;
  }
}
function recordFramingTween() {
  if (typeof window !== "undefined") window.__framingTweenCount = (window.__framingTweenCount ?? 0) + 1;
}

export const DEFAULT_FILL = 0.75;

export const DIMENSION_LINE_LAYER = 1;
export const DIMENSION_LABEL_LAYER = 2;
export const MODEL_DEPTH_UNIFORM: { value: THREE.Texture | null } = { value: null };

const LINE_WEIGHT_PER_DIAGONAL_PX = 1 / 500;
const MIN_LINE_WEIGHT = 1.0;
const MAX_LINE_WEIGHT = 1.6;
const FINE_LINE_WEIGHT = 0.8;
const DEPTH_STEP_PX = 4;

const DEFAULT_PERSPECTIVE_FOV = 35;
const ZOOM_LIMIT_MIN = 0.3;
const ZOOM_LIMIT_MAX = 4;

const ORIENT_TWEEN_MS = 500;
const SCALE_TWEEN_MS = 400;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

const SETTLE_KICK_FRAMES = 4;

export function kickInvalidate(invalidate: () => void, onDone?: () => void) {
  invalidate();
  let remaining = SETTLE_KICK_FRAMES;
  const tick = () => {
    invalidate();
    remaining -= 1;
    if (remaining > 0) requestAnimationFrame(tick);
    else onDone?.();
  };
  requestAnimationFrame(tick);
}

function linePixelRatio(dpr: number): number {
  return Math.max(2, dpr);
}

const FACE_KIND_ATTRIBUTE = "faceKind";
const FACE_KIND_LABEL = 1;
const FACE_KIND_CHAMFER = 2;
const FACE_KIND_LAND = 3;
const FACE_KIND_FADE = 4;

export function markFaceKinds(geometry: THREE.BufferGeometry, mesh: CoilMesh) {
  const groups: Array<[Uint32Array | undefined, number]> = [
    [mesh.labelTriangles, FACE_KIND_LABEL],
    [mesh.rimTriangles?.chamfer, FACE_KIND_CHAMFER],
    [mesh.rimTriangles?.land, FACE_KIND_LAND],
    [mesh.fadeTriangles, FACE_KIND_FADE],
  ];
  if (groups.every(([triangles]) => !triangles?.length)) return;
  const kinds = new Float32Array(geometry.getAttribute("position").count);
  for (const [triangles, kind] of groups) for (const t of triangles ?? []) kinds.fill(kind, t * 3, t * 3 + 3);
  geometry.setAttribute(FACE_KIND_ATTRIBUTE, new THREE.BufferAttribute(kinds, 1));
}

function createNormalMaterial(): THREE.MeshNormalMaterial {
  const material = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
  (material as unknown as { defaultAttributeValues: Record<string, number[]> }).defaultAttributeValues = { [FACE_KIND_ATTRIBUTE]: [0] };
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace("void main() {", `attribute float ${FACE_KIND_ATTRIBUTE};\nvarying float vFaceKind;\nvoid main() {\n\tvFaceKind = ${FACE_KIND_ATTRIBUTE};`);
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "varying float vFaceKind;\nvoid main() {")
      .replace(/}\s*$/, "\tgl_FragColor.a = vFaceKind > 3.5 ? 0.97 : vFaceKind > 2.5 ? 0.8 : vFaceKind > 1.5 ? 0.9 : vFaceKind > 0.5 ? 0.5 : 1.0;\n}\n");
  };
  material.customProgramCacheKey = () => "lineArtNormal";
  return material;
}

function disableBlendAndDepth(material: THREE.ShaderMaterial) {
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.NoBlending;
  material.transparent = false;
}

function keepFrustumFromResizeHandler(camera: THREE.Camera) {
  (camera as unknown as { manual: boolean }).manual = true;
}

function worldSizeOfPixel(camera: THREE.OrthographicCamera | THREE.PerspectiveCamera, target: THREE.Vector3 | undefined, heightPx: number): number {
  if (isOrthographic(camera)) return (camera.top - camera.bottom) / camera.zoom / heightPx;
  const distance = camera.position.distanceTo(target ?? camera.position);
  return (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / heightPx;
}

function isOrthographic(camera: THREE.Camera): camera is THREE.OrthographicCamera {
  return (camera as THREE.OrthographicCamera).isOrthographicCamera === true;
}

interface Fit {
  center: THREE.Vector3;
  r: number;
  halfHeight: number;
  extentX: number;
  extentY: number;
}

const FIT_EQUAL_TOLERANCE = 0.01;

function fitsNearlyEqual(a: Fit, b: Fit): boolean {
  const scaleRef = Math.max(a.halfHeight, b.halfHeight, 1e-6);
  return Math.abs(a.halfHeight - b.halfHeight) / scaleRef < FIT_EQUAL_TOLERANCE && a.center.distanceTo(b.center) / scaleRef < FIT_EQUAL_TOLERANCE;
}

function computeFit(geometry: THREE.BufferGeometry, direction: THREE.Vector3, up: THREE.Vector3, aspect: number, fill: number, projection: Projection): Fit | null {
  geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere;
  if (!sphere || sphere.radius <= 0) return null;

  const rotation = new THREE.Matrix4().lookAt(direction, new THREE.Vector3(0, 0, 0), up);
  const inverse = rotation.clone().transpose();
  const distance = 2 * sphere.radius;

  const pos = geometry.getAttribute("position");
  const v = new THREE.Vector3();
  const bounds = new THREE.Box2();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const flat = v.clone().sub(sphere.center).applyMatrix4(inverse);
    bounds.expandByPoint(new THREE.Vector2(flat.x, flat.y));
  }
  const mid = bounds.getCenter(new THREE.Vector2());
  const extent = bounds.getSize(new THREE.Vector2());
  const shift = new THREE.Vector3(mid.x, mid.y, 0).applyMatrix4(rotation);

  let maxTan = 0;
  if (projection === "perspective") {
    const cameraPosition = sphere.center.clone().add(shift).addScaledVector(direction, distance);
    for (let i = 0; i < pos.count; i++) {
      const view = v.fromBufferAttribute(pos, i).sub(cameraPosition).applyMatrix4(inverse);
      const distanceAhead = -view.z;
      if (distanceAhead > 1e-6) maxTan = Math.max(maxTan, Math.abs(view.y) / distanceAhead, Math.abs(view.x) / (distanceAhead * aspect));
    }
  }

  const halfHeight = projection === "perspective" ? distance * (maxTan / fill) : Math.max(extent.y / 2, extent.x / 2 / aspect) / fill;

  return {
    center: sphere.center.clone().add(shift),
    r: sphere.radius,
    halfHeight,
    extentX: extent.x,
    extentY: extent.y,
  };
}

function applyFraming(
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
  projection: Projection,
  fit: Fit,
  direction: THREE.Vector3,
  up: THREE.Vector3,
  aspect: number,
  size: { width: number; height: number },
  controls: OrbitControlsImpl | null,
  thickenPass: ShaderPass,
  gl: THREE.WebGLRenderer,
) {
  const distance = 2 * fit.r;
  camera.position.copy(fit.center).addScaledVector(direction, distance);
  camera.up.copy(up);
  camera.near = fit.r * 0.5;
  camera.far = fit.r * 3.5;

  if (isOrthographic(camera)) {
    camera.left = -fit.halfHeight * aspect;
    camera.right = fit.halfHeight * aspect;
    camera.top = fit.halfHeight;
    camera.bottom = -fit.halfHeight;
    camera.zoom = 1;
  } else {
    camera.aspect = aspect;
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(fit.halfHeight / distance));
  }
  camera.lookAt(fit.center);
  camera.updateProjectionMatrix();

  if (controls) {
    controls.target.copy(fit.center);
    controls.update();
  }

  const cssPerWorld = size.height / (2 * fit.halfHeight);
  const diagonalCss = Math.hypot(fit.extentX, fit.extentY) * cssPerWorld;
  const weight = THREE.MathUtils.clamp(diagonalCss * LINE_WEIGHT_PER_DIAGONAL_PX, MIN_LINE_WEIGHT, MAX_LINE_WEIGHT);
  thickenPass.uniforms.thicknessPx.value = Math.min(weight * linePixelRatio(gl.getPixelRatio()), MAX_THICKEN_RADIUS - 0.5);
  thickenPass.uniforms.fineThicknessPx.value = FINE_LINE_WEIGHT * linePixelRatio(gl.getPixelRatio());

  void projection;
}

function currentOrientationOf(camera: THREE.Camera, target: THREE.Vector3): { direction: THREE.Vector3; up: THREE.Vector3 } {
  const offset = new THREE.Vector3().subVectors(camera.position, target);
  const direction = offset.lengthSq() > 1e-12 ? offset.normalize() : new THREE.Vector3(0, 0, 1);
  return { direction, up: camera.up.clone() };
}

export interface LineArtRendererProps {
  geometry: THREE.BufferGeometry;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
  projection: Projection;
  preset: PresetId;
  fill?: number;
  reducedMotion: boolean;
  resolution?: Resolution;
  onSettledChange?: (settled: boolean) => void;
}

export function LineArtRenderer({ geometry, controlsRef, projection, preset, fill = DEFAULT_FILL, reducedMotion, resolution = "final", onSettledChange }: LineArtRendererProps) {
  const { gl, scene, size, invalidate, set, get } = useThree();
  const store = useStore();
  const settled = useRef(false);
  const pendingKicks = useRef(0);

  function publishSettled(next: boolean) {
    if (!onSettledChange || settled.current === next) return;
    settled.current = next;
    onSettledChange(next);
  }

  function kick() {
    pendingKicks.current += 1;
    publishSettled(false);
    kickInvalidate(invalidate, () => (pendingKicks.current -= 1));
  }

  useLayoutEffect(() => publishSettled(false), [geometry, resolution, preset, projection, fill, size.width, size.height]);

  useEffect(() => {
    if (!onSettledChange) return;
    const original = get().invalidate;
    set({
      invalidate: (frames) => {
        publishSettled(false);
        original(frames);
      },
    });
    const unsubscribe = store.subscribe(() => publishSettled(false));
    return () => {
      unsubscribe();
      set({ invalidate: original });
    };
  }, []);

  const orthoCamera = useMemo(() => {
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);
    camera.up.set(0, 0, 1);
    keepFrustumFromResizeHandler(camera);
    return camera;
  }, []);
  const perspectiveCamera = useMemo(() => {
    const camera = new THREE.PerspectiveCamera(DEFAULT_PERSPECTIVE_FOV, 1, 0.1, 10000);
    camera.up.set(0, 0, 1);
    keepFrustumFromResizeHandler(camera);
    return camera;
  }, []);
  const activeCamera = projection === "ortho" ? orthoCamera : perspectiveCamera;

  const normalMaterial = useMemo(createNormalMaterial, []);

  const targets = useMemo(() => {
    const depthTexture = new THREE.DepthTexture(1, 1);
    depthTexture.type = THREE.FloatType;
    const nearest = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
    const normalDepth = new THREE.WebGLRenderTarget(1, 1, { ...nearest, type: THREE.HalfFloatType, depthTexture });
    const edge = new THREE.WebGLRenderTarget(1, 1, nearest);
    const thicken = new THREE.WebGLRenderTarget(1, 1);
    const output = new THREE.WebGLRenderTarget(1, 1);
    return { normalDepth, edge, thicken, output };
  }, []);

  const passes = useMemo(() => {
    const edgePass = new ShaderPass(EdgeShader);
    const thickenPass = new ShaderPass(ThickenShader);
    const outputPass = new OutputPass();
    const fxaaPass = new ShaderPass(FXAAShader);
    disableBlendAndDepth(edgePass.material);
    disableBlendAndDepth(thickenPass.material);
    disableBlendAndDepth(outputPass.material);
    disableBlendAndDepth(fxaaPass.material);
    fxaaPass.renderToScreen = true;
    return { edgePass, thickenPass, outputPass, fxaaPass };
  }, []);

  useEffect(
    () => () => {
      Object.values(targets).forEach((t) => t.dispose());
      Object.values(passes).forEach((p) => p.dispose());
      normalMaterial.dispose();
    },
    [targets, passes, normalMaterial],
  );

  const initialDirection = useRef(getPreset(preset).direction.clone());
  const initialUp = useRef(getPreset(preset).upHint.clone());
  const settledDirection = useRef(initialDirection.current.clone());
  const settledUp = useRef(initialUp.current.clone());
  const settledFit = useRef<Fit | null>(null);
  const orientAnim = useRef<{ from: THREE.Quaternion; to: THREE.Quaternion; start: number; duration: number } | null>(null);
  const scaleAnim = useRef<{ from: Fit; to: Fit; start: number; duration: number } | null>(null);
  const mountedGeometry = useRef(false);
  const mountedProjection = useRef(false);
  const mountedPreset = useRef(false);
  const prevProjection = useRef(projection);
  const azimuthTracking = useRef<{ raw: number; cumulativeDeg: number } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.__orbitByDeg = (deltaDeg: number) => {
      const controls = controlsRef.current;
      if (!controls) return;
      const target = controls.target;
      const yUp = new THREE.Vector3(0, 1, 0);
      const quat = new THREE.Quaternion().setFromUnitVectors(activeCamera.up, yUp);
      const quatInverse = quat.clone().invert();
      const offset = activeCamera.position.clone().sub(target).applyQuaternion(quat);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      spherical.theta += THREE.MathUtils.degToRad(deltaDeg);
      offset.setFromSpherical(spherical).applyQuaternion(quatInverse);
      activeCamera.position.copy(target).add(offset);
      activeCamera.lookAt(target);
      controls.update();
      invalidate();
    };
    return () => {
      if (typeof window !== "undefined") delete window.__orbitByDeg;
    };
  }, [activeCamera, controlsRef, invalidate]);

  function aspectOf() {
    return size.width > 0 && size.height > 0 ? size.width / size.height : 1;
  }

  useEffect(() => {
    const dpr = gl.getPixelRatio();
    const w = Math.max(1, Math.round(size.width * dpr));
    const h = Math.max(1, Math.round(size.height * dpr));
    const lineRatio = linePixelRatio(dpr);
    const lw = Math.max(1, Math.round(size.width * lineRatio));
    const lh = Math.max(1, Math.round(size.height * lineRatio));
    targets.normalDepth.setSize(lw, lh);
    targets.edge.setSize(lw, lh);
    targets.thicken.setSize(lw, lh);
    targets.output.setSize(w, h);
    passes.edgePass.uniforms.texel.value.set(1 / lw, 1 / lh);
    passes.thickenPass.uniforms.texel.value.set(1 / lw, 1 / lh);
    passes.fxaaPass.uniforms.resolution.value.set(1 / w, 1 / h);

    const fit = computeFit(geometry, settledDirection.current, settledUp.current, aspectOf(), fill, projection);
    if (fit) {
      applyFraming(activeCamera, projection, fit, settledDirection.current, settledUp.current, aspectOf(), size, controlsRef.current, passes.thickenPass, gl);
      settledFit.current = fit;
    }
    kick();
  }, [gl, size.width, size.height, targets, passes]);

  useEffect(() => {
    if (mountedGeometry.current && resolution !== "final") return;

    const toFit = computeFit(geometry, settledDirection.current, settledUp.current, aspectOf(), fill, projection);
    if (!toFit) return;
    const from = settledFit.current;
    if (!mountedGeometry.current || reducedMotion || (from && fitsNearlyEqual(from, toFit))) {
      mountedGeometry.current = true;
      applyFraming(activeCamera, projection, toFit, settledDirection.current, settledUp.current, aspectOf(), size, controlsRef.current, passes.thickenPass, gl);
      settledFit.current = toFit;
      orientAnim.current = null;
      scaleAnim.current = null;
    } else {
      scaleAnim.current = { from: from ?? toFit, to: toFit, start: performance.now(), duration: SCALE_TWEEN_MS };
      recordFramingTween();
    }
    kick();
  }, [geometry, resolution]);

  useEffect(() => {
    if (!mountedPreset.current) {
      mountedPreset.current = true;
      return;
    }
    const from = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(settledDirection.current, new THREE.Vector3(), settledUp.current));
    const to = presetQuaternion(preset);
    if (reducedMotion) {
      const { direction, up } = directionAndUpOf(to);
      const fit = computeFit(geometry, direction, up, aspectOf(), fill, projection);
      settledDirection.current = direction;
      settledUp.current = up;
      if (fit) {
        applyFraming(activeCamera, projection, fit, direction, up, aspectOf(), size, controlsRef.current, passes.thickenPass, gl);
        settledFit.current = fit;
      }
      orientAnim.current = null;
    } else {
      orientAnim.current = { from, to, start: performance.now(), duration: ORIENT_TWEEN_MS };
    }
    kick();
  }, [preset]);

  useEffect(() => {
    const activated = projection === "ortho" ? orthoCamera : perspectiveCamera;
    if (mountedProjection.current && prevProjection.current !== projection) {
      const fromCamera = prevProjection.current === "ortho" ? orthoCamera : perspectiveCamera;
      const target = settledFit.current?.center.clone() ?? fromCamera.position.clone();
      const { direction, up } = currentOrientationOf(fromCamera, target);
      const fit = computeFit(geometry, direction, up, aspectOf(), fill, projection);
      if (fit) {
        applyFraming(activated, projection, fit, direction, up, aspectOf(), size, controlsRef.current, passes.thickenPass, gl);
        settledDirection.current = direction;
        settledUp.current = up;
        settledFit.current = fit;
      }
      orientAnim.current = null;
      scaleAnim.current = null;
    }
    mountedProjection.current = true;
    prevProjection.current = projection;
    set({ camera: activated });
    kick();
  }, [projection]);

  function reassertTargetAndZoomLimits(controls: OrbitControlsImpl, fit: Fit) {
    controls.target.copy(fit.center);
    controls.minZoom = ZOOM_LIMIT_MIN;
    controls.maxZoom = ZOOM_LIMIT_MAX;
    const fittedDistance = 2 * fit.r;
    controls.minDistance = fittedDistance / ZOOM_LIMIT_MAX;
    controls.maxDistance = fittedDistance / ZOOM_LIMIT_MIN;
  }

  function publishUnwrappedAzimuth(controls: OrbitControlsImpl) {
    const wrapped = controls.getAzimuthalAngle();
    const prev = azimuthTracking.current;
    let delta = prev ? wrapped - prev.raw : 0;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    else if (delta < -Math.PI) delta += 2 * Math.PI;
    const cumulativeDeg = (prev?.cumulativeDeg ?? 0) + THREE.MathUtils.radToDeg(delta);
    azimuthTracking.current = { raw: wrapped, cumulativeDeg };
    if (typeof window !== "undefined") window.__orbitAzimuthDeg = cumulativeDeg;
  }

  function drawDimensionOverlays() {
    const prevAutoClear = gl.autoClear;
    gl.autoClear = false;
    activeCamera.layers.set(DIMENSION_LINE_LAYER);
    MODEL_DEPTH_UNIFORM.value = targets.normalDepth.depthTexture;
    gl.setRenderTarget(targets.output);
    gl.clearDepth();
    gl.render(scene, activeCamera);
    passes.fxaaPass.render(gl, targets.output, targets.output, 0, false);
    activeCamera.layers.set(DIMENSION_LABEL_LAYER);
    gl.setRenderTarget(null);
    gl.clearDepth();
    gl.render(scene, activeCamera);
    activeCamera.layers.set(0);
    gl.autoClear = prevAutoClear;
  }

  useFrame(() => {
    if (controlsRef.current && settledFit.current) {
      reassertTargetAndZoomLimits(controlsRef.current, settledFit.current);
      publishUnwrappedAzimuth(controlsRef.current);

      if (!orientAnim.current && !scaleAnim.current) {
        const { direction, up } = currentOrientationOf(activeCamera, controlsRef.current.target);
        settledDirection.current.copy(direction);
        settledUp.current.copy(up);
      }
    }

    const orient = orientAnim.current;
    if (orient) {
      const t = THREE.MathUtils.clamp((performance.now() - orient.start) / orient.duration, 0, 1);
      const eased = easeInOutCubic(t);
      const q = new THREE.Quaternion().slerpQuaternions(orient.from, orient.to, eased);
      const { direction, up } = directionAndUpOf(q);
      const fit = computeFit(geometry, direction, up, aspectOf(), fill, projection);
      if (fit) applyFraming(activeCamera, projection, fit, direction, up, aspectOf(), size, controlsRef.current, passes.thickenPass, gl);
      if (t >= 1) {
        orientAnim.current = null;
        scaleAnim.current = null;
        settledDirection.current = direction;
        settledUp.current = up;
        if (fit) settledFit.current = fit;
        kick();
      } else {
        invalidate();
      }
    }

    const scale = scaleAnim.current;
    if (scale && !orient) {
      const t = THREE.MathUtils.clamp((performance.now() - scale.start) / scale.duration, 0, 1);
      const eased = easeInOutCubic(t);
      const fit: Fit = {
        center: scale.from.center.clone().lerp(scale.to.center, eased),
        r: THREE.MathUtils.lerp(scale.from.r, scale.to.r, eased),
        halfHeight: THREE.MathUtils.lerp(scale.from.halfHeight, scale.to.halfHeight, eased),
        extentX: THREE.MathUtils.lerp(scale.from.extentX, scale.to.extentX, eased),
        extentY: THREE.MathUtils.lerp(scale.from.extentY, scale.to.extentY, eased),
      };
      applyFraming(activeCamera, projection, fit, settledDirection.current, settledUp.current, aspectOf(), size, controlsRef.current, passes.thickenPass, gl);
      if (t >= 1) {
        scaleAnim.current = null;
        settledFit.current = scale.to;
        kick();
      } else {
        invalidate();
      }
    }

    const pxH = targets.normalDepth.height;
    const edgeUniforms = passes.edgePass.uniforms;
    const pixelWorld = worldSizeOfPixel(activeCamera, controlsRef.current?.target, pxH);
    edgeUniforms.depthRange.value = activeCamera.far - activeCamera.near;
    edgeUniforms.depthThreshold.value = DEPTH_STEP_PX * pixelWorld;

    const prevOverride = scene.overrideMaterial;
    const prevClearAlpha = gl.getClearAlpha();
    gl.setClearAlpha(0);
    gl.setRenderTarget(targets.normalDepth);
    gl.clear(true, true, false);
    scene.overrideMaterial = normalMaterial;
    gl.render(scene, activeCamera);
    scene.overrideMaterial = prevOverride;

    edgeUniforms.tNormal.value = targets.normalDepth.texture;
    edgeUniforms.tDepth.value = targets.normalDepth.depthTexture;
    passes.edgePass.render(gl, targets.edge, targets.normalDepth, 0, false);
    passes.thickenPass.render(gl, targets.thicken, targets.edge, 0, false);
    passes.outputPass.render(gl, targets.output, targets.thicken, 0, false);
    drawDimensionOverlays();
    gl.setClearAlpha(prevClearAlpha);

    const framePending = orientAnim.current || scaleAnim.current || get().internal.frames > 1;
    if (resolution === "final" && pendingKicks.current === 0 && !framePending) publishSettled(true);
  }, 1);

  return null;
}
