import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { Resolution } from "../../core";
import { EdgeShader } from "./edgeShader";
import { MAX_THICKEN_RADIUS, ThickenShader } from "./thickenShader";
import { directionAndUpOf, getPreset, presetQuaternion, type PresetId } from "./presets";

export type Projection = "ortho" | "perspective";

// Test-only instrumentation (issue #72 AC: "a sequence of rapid edits
// produces exactly one framing tween at the end (instrumented)"). Counts
// how many parameter-change scale tweens have actually STARTED (see the
// geometry-change effect below) -- nothing in this app reads it outside
// e2e/smooth-param-changes.spec.ts, which polls it off `window` the same
// way any other Playwright check reads app state through the DOM.
// Test-only instrumentation (issue #84 AC: "a long drag reaches >= 180 deg
// of azimuth"). `OrbitControls.getAzimuthalAngle()` itself only ever returns
// a value wrapped to (-pi, pi], which can't tell a Playwright test how FAR a
// drag actually orbited once it crosses that wrap point -- so this instead
// accumulates the UNWRAPPED total rotation (see the self-healing block in
// the render loop below), correcting each frame's raw reading back onto the
// same continuous number line before adding it to the running total.
// Nothing in this app reads it outside e2e/line-art.spec.ts, which polls it
// off `window` the same way e2e/smooth-param-changes.spec.ts already does
// for __framingTweenCount above.
// Test-only seam (issue #110): drives a full orbit directly instead of
// simulating a mouse drag, for tests that only care about the CAMERA'S
// resulting azimuth, not the pointer path that produces it -- the drag path
// itself (does a drag actually orbit the camera, does it reach the right
// OrbitControls STATE) is already covered by e2e/line-art.spec.ts's own
// orbit tests (issue #84). Nothing in this app reads it outside
// e2e/dimensions.spec.ts's issue #93 rigidity test, which used to drive 24
// steps of a full orbit via `page.mouse.move` and now calls this instead.
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

// The model's projected bounds fill this fraction of the canvas's tighter
// axis by default; a caller can ask for a tighter (larger) fraction, e.g.
// CoilViewer biases this up a little while exploded (issue #15, issue #9
// review: "consider a slight camera reframe while exploded" -- the joint
// features read clearer when the frame doesn't also reserve room around them).
export const DEFAULT_FILL = 0.75;
// Scene layers drawn on top of the line-art pipeline instead of through it
// (issue #69's dimension axes, see the render loop below): lines before FXAA,
// labels after it.
export const DIMENSION_LINE_LAYER = 1;
export const DIMENSION_LABEL_LAYER = 2;
// The model's depth (the normal+depth pass's depth texture) while the
// DIMENSION_LINE_LAYER overlay draws, as a shader uniform: the dimension
// lines are drawn without a depth test and dim themselves where the model
// hides them (issue #93).
export const MODEL_DEPTH_UNIFORM: { value: THREE.Texture | null } = { value: null };
// Line weight (thicken radius, CSS px) scales gently with the model's
// on-screen diagonal (docs/research.md §10b), clamped so it stays a thin pen
// line on small canvases and never fuses the groove rings on large ones.
const LINE_WEIGHT_PER_DIAGONAL_PX = 1 / 500;
const MIN_LINE_WEIGHT = 1.0;
const MAX_LINE_WEIGHT = 1.6;
// A depth step counts as an occlusion edge when it exceeds this many
// line-pass pixels' worth of world-space distance.
const DEPTH_STEP_PX = 4;
// Perspective camera's fixed field of view is SOLVED per fit (see
// applyFraming) to make the given half-height fill the frame at the fit's
// own distance -- this is just the seed used before the first real fit.
const DEFAULT_PERSPECTIVE_FOV = 35;

// User zoom clamp (issue #48): wheel/pinch zoom is bounded to this multiple
// of the CURRENT fitted framing, on both projections, so it's never
// possible to zoom the model away to an unreadable speck or blow it up past
// where nothing on screen still reads. Ortho's own `camera.zoom` is already
// exactly 1 at "fitted" (applyFraming always resets it there), so these
// bounds apply to `OrbitControls.min/maxZoom` directly and never need
// recomputing as the design's own scale changes. Perspective has no such
// camera-native "zoom" -- OrbitControls instead dollies a PERSPECTIVE
// camera by moving it along the view direction, clamped by `min/
// maxDistance` -- so those are set in WORLD units, relative to the fit's own
// `2 * fit.r` distance (applyFraming's own camera-distance convention): a
// SMALLER distance shows the model BIGGER, so ZOOM_LIMIT_MAX (zoomed in)
// maps to the CLOSEST distance and vice versa. Applied every settled frame
// (see the self-healing block in the render loop below), not just once,
// because `OrbitControls` swaps in a fresh instance -- losing anything set
// on the old one -- whenever the resolved default camera changes (the same
// reason that block already re-asserts `controls.target` every frame).
const ZOOM_LIMIT_MIN = 0.3;
const ZOOM_LIMIT_MAX = 4;

// Camera transition durations (issue #15), `prefers-reduced-motion` skips
// both entirely (see LineArtRendererProps.reducedMotion): presets slerp the
// VIEW (a real rotation, docs/research.md §10b/"dual persp/ortho camera rig
// ... preset views with slerp transitions"); parameter edits only ease the
// FIT (center/radius/half-height) toward the new geometry's own bounds --
// the view direction never moves for those.
const ORIENT_TWEEN_MS = 500;
const SCALE_TWEEN_MS = 400;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// How many extra animation frames a one-shot camera change (an instant
// preset/projection snap, or a fresh mount/resize fit) asks for beyond its
// own single `invalidate()`. A single isolated render, with nothing else
// re-invalidating before or after it, isn't reliably picked up by every
// headless-Chromium screenshot pipeline (observed with SwiftShader software
// rendering under `frameloop="demand"`): the WebGL draw call itself is
// correct (verified against the canvas's own `toDataURL()`), but the OS-
// level compositor snapshot Playwright's element screenshots go through can
// still return a stale frame. A short burst of consecutive frames -- the
// same thing a continuously-invalidating tween (ExplodedPart's damp loop,
// or this file's own orientAnim/scaleAnim) gets for free every time -- gives
// the compositor several chances to catch up instead of just one.
const SETTLE_KICK_FRAMES = 4;

function kickInvalidate(invalidate: () => void) {
  invalidate();
  let remaining = SETTLE_KICK_FRAMES;
  const tick = () => {
    invalidate();
    remaining -= 1;
    if (remaining > 0) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * Pixels per CSS pixel for the edge and thicken passes. On a 1x screen they
 * run at 2x and OutputPass box-filters the result down, so thin lines come
 * out smooth instead of stair-stepped. On a 2x-or-better screen, native.
 */
function linePixelRatio(dpr: number): number {
  return dpr >= 2 ? dpr : 2 * dpr;
}

function disableBlendAndDepth(material: THREE.ShaderMaterial) {
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.NoBlending;
  material.transparent = false;
}

function isOrthographic(camera: THREE.Camera): camera is THREE.OrthographicCamera {
  return (camera as THREE.OrthographicCamera).isOrthographicCamera === true;
}

/**
 * A camera framing target, in world units: `center` is where the orbit
 * target sits, `r` is the model's own bounding-sphere radius (drives near/
 * far and the perspective camera's distance), and `halfHeight`/`extent*` are
 * the projected-bounds fit (docs/research.md §10b's auto-refit), computed
 * for a SPECIFIC view direction -- see computeFit.
 */
interface Fit {
  center: THREE.Vector3;
  r: number;
  halfHeight: number;
  extentX: number;
  extentY: number;
}

// Below this relative difference in scale and centre, two fits are treated
// as "the same view" and applied instantly rather than tweened -- see the
// geometry-change effect's own doc comment (the issue #7 draft -> final
// resolution bump is the case this exists for).
const FIT_EQUAL_TOLERANCE = 0.01;

function fitsNearlyEqual(a: Fit, b: Fit): boolean {
  const scaleRef = Math.max(a.halfHeight, b.halfHeight, 1e-6);
  return Math.abs(a.halfHeight - b.halfHeight) / scaleRef < FIT_EQUAL_TOLERANCE && a.center.distanceTo(b.center) / scaleRef < FIT_EQUAL_TOLERANCE;
}

/**
 * The camera framing fit for `geometry`, looking along `direction` (a unit
 * vector, orbit target -> camera) with `up` resolving roll: the model's
 * bounding-sphere radius, plus the projected bounds of every vertex, fit to
 * `fill` of the canvas's tighter axis.
 *
 * Pure math, no THREE.Camera involved (unlike the pre-#15 version of this
 * reframe, which mutated the live camera to compute this): a rotation-only
 * "looking along `direction`" frame is built directly, so this can be
 * called freely for orientations no camera currently has -- e.g. every
 * frame of a preset's slerp, or to compute a tween's "to" fit before the
 * view has actually turned there.
 *
 * `projection` matters here, not just in applyFraming: ortho's bounds are a
 * flat, depth-independent box (the parallel-projected footprint), but a
 * perspective camera's frustum must additionally clear whichever vertex
 * sits CLOSEST to the camera (foreshortening makes it project bigger than
 * the flat box alone implies) -- so for "perspective" this also walks every
 * vertex's real view-space depth at the fit's own camera position (the
 * bounds' centre plus 2r along `direction`, exactly where applyFraming puts it)
 * and tracks the largest half-angle any vertex actually needs, guaranteeing
 * nothing clips regardless of the model's own depth extent.
 */
function computeFit(geometry: THREE.BufferGeometry, direction: THREE.Vector3, up: THREE.Vector3, aspect: number, fill: number, projection: Projection): Fit | null {
  geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere;
  if (!sphere || sphere.radius <= 0) return null;

  // Rotation-only "camera" basis looking along `direction`: X/Y bounds
  // projected through it don't depend on how far along `direction` the
  // camera actually sits (only Z/depth would), so this is safe to use
  // before any camera exists at this orientation.
  const rotation = new THREE.Matrix4().lookAt(direction, new THREE.Vector3(0, 0, 0), up);
  const inverse = rotation.clone().transpose(); // orthonormal: inverse === transpose
  const distance = 2 * sphere.radius; // matches applyFraming's own camera-distance convention

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

  // Perspective only: the largest tan(half-angle) any vertex needs at its
  // own real depth, seen from where applyFraming puts the camera (off the
  // bounds' centre, not the sphere's: a lopsided geometry, like the model
  // plus its dimension axes on one side, sits off the sphere's centre).
  let maxTan = 0;
  if (projection === "perspective") {
    const cameraPosition = sphere.center.clone().add(shift).addScaledVector(direction, distance);
    for (let i = 0; i < pos.count; i++) {
      const view = v.fromBufferAttribute(pos, i).sub(cameraPosition).applyMatrix4(inverse);
      const depth = -view.z; // the camera looks down its own local -Z
      if (depth > 1e-6) maxTan = Math.max(maxTan, Math.abs(view.y) / depth, Math.abs(view.x) / (depth * aspect));
    }
  }

  // Perspective's halfHeight is defined so applyFraming's own
  // `fov = 2*atan(halfHeight/distance)` reproduces `tan(fov/2) = maxTan/fill`
  // exactly -- i.e. "the world half-height a fov solved this way would show
  // AT `distance`", the same quantity ortho's halfHeight already is.
  const halfHeight = projection === "perspective" ? distance * (maxTan / fill) : Math.max(extent.y / 2, extent.x / 2 / aspect) / fill;

  return {
    center: sphere.center.clone().add(shift),
    r: sphere.radius,
    halfHeight,
    extentX: extent.x,
    extentY: extent.y,
  };
}

/**
 * Points `camera` at `fit` along `direction`/`up`, sizing its frustum (ortho:
 * left/right/top/bottom; perspective: fov, solved so the SAME `fit.
 * halfHeight` fills the frame at this fit's distance -- see the pixel-
 * conversion note below) and recomputes the line-art pen weight from the
 * ACTUAL projected bounds (issue #15: "line-art thickness must stay correct
 * in perspective too"), valid for either projection because of that solve.
 */
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
  // Distance 2r to the centre, so the bounding sphere sits strictly between
  // near and far and never reads as background (matches the pre-#15 ortho
  // camera's own convention -- kept for perspective too, so near/far and the
  // fov solve below share one distance).
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

  // cssPerWorld is exact for ortho (constant across depth) and, by
  // construction, for perspective too: its fov was just solved so
  // `fit.halfHeight` maps to exactly `size.height/2` px at `distance`.
  const cssPerWorld = size.height / (2 * fit.halfHeight);
  const diagonalCss = Math.hypot(fit.extentX, fit.extentY) * cssPerWorld;
  const weight = THREE.MathUtils.clamp(diagonalCss * LINE_WEIGHT_PER_DIAGONAL_PX, MIN_LINE_WEIGHT, MAX_LINE_WEIGHT);
  thickenPass.uniforms.thicknessPx.value = Math.min(weight * linePixelRatio(gl.getPixelRatio()), MAX_THICKEN_RADIUS - 0.5);

  void projection; // kept in the signature for callers' clarity; behaviour above is driven by `camera`'s own type.
}

/**
 * The direction/up `camera` is CURRENTLY looking from, read off its own live
 * transform. Used both by the projection toggle below (re-fitting the
 * incoming camera to whatever the OUTGOING one is actually looking at) and,
 * every idle frame (see the render loop's own self-healing block), to keep
 * `settledDirection`/`settledUp` themselves in sync with a manual orbit-drag
 * -- issue #84: without that, any reframe that recomputes a fit from
 * `settledDirection.current` (a parameter edit's scale tween, toggling
 * exploded/print-layout view, a resize) would silently snap the camera back
 * to wherever it was BEFORE the drag, discarding it. Skipped while a preset
 * transition is actively running (that tween is deliberately driving the
 * camera itself; see the render loop for the guard).
 */
function currentOrientationOf(camera: THREE.Camera, target: THREE.Vector3): { direction: THREE.Vector3; up: THREE.Vector3 } {
  const offset = new THREE.Vector3().subVectors(camera.position, target);
  const direction = offset.lengthSq() > 1e-12 ? offset.normalize() : new THREE.Vector3(0, 0, 1);
  return { direction, up: camera.up.clone() };
}

export interface LineArtRendererProps {
  /** The coil geometry to frame and outline. */
  geometry: THREE.BufferGeometry;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
  /** Perspective/orthographic (issue #15 AC); toggling preserves on-screen scale. */
  projection: Projection;
  /** Which standard view to slerp toward (issue #15 AC). */
  preset: PresetId;
  /** How much of the canvas's tighter axis the fit targets -- see DEFAULT_FILL. */
  fill?: number;
  /** `prefers-reduced-motion`: every transition below becomes instant. */
  reducedMotion: boolean;
  /** The resolution `geometry` was built at (issue #72). Defaults to
   * "final" for callers that never show anything else (e.g. the guide's
   * `CoilScene`, always a one-shot final render). Once a real final has
   * been framed, a later "draft" geometry change is ignored FOR FRAMING
   * PURPOSES ONLY -- it's still drawn (CoilViewer keeps rendering whatever
   * mesh `useDesignPreview` currently shows), but never moves or tweens the
   * camera, so a slow-build fallback draft never has to un-tween back off
   * again once the real final arrives. See the geometry-change effect below. */
  resolution?: Resolution;
}

/**
 * The IKEA line-art post pipeline (issue #3, docs/research.md §10b):
 *
 *   normal+depth pass -> edge shader -> thicken (dilate) -> OutputPass
 *   (colour-space conversion) -> FXAA -> screen
 *
 * Owns BOTH camera objects (ortho + perspective, issue #15) itself and
 * activates whichever `projection` asks for via R3F's own default-camera
 * slot, so `<OrbitControls>` (owned by CoilViewer) keeps working unchanged --
 * it always follows R3F's current default camera.
 *
 * Drives its own render targets and passes inside a `useFrame` with a
 * priority, which takes over R3F's render loop while mounted. The canvas
 * renders on demand (the pipeline is heavy on software GL), so every change
 * made here outside R3F's own props calls `invalidate()`.
 */
export function LineArtRenderer({ geometry, controlsRef, projection, preset, fill = DEFAULT_FILL, reducedMotion, resolution = "final" }: LineArtRendererProps) {
  const { gl, scene, size, invalidate, set } = useThree();

  const orthoCamera = useMemo(() => {
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);
    camera.up.set(0, 0, 1);
    // Tells R3F's own resize handling (updateCamera in @react-three/fiber's
    // web.ts) to keep its hands off: unmarked, it resets an ortho camera's
    // frustum to the canvas's raw PIXEL dimensions (left=-width/2 etc.) on
    // every resize -- overwriting our own world-unit frustum from
    // applyFraming with something wildly different in scale. A resize (the
    // sidebar's Kanit webfont finishing late enough to reflow the canvas by
    // a few px is a real, if narrow, example) that lands between one of our
    // own effects and R3F's would otherwise leave the LIVE camera in that
    // pixel-sized state until something else happened to re-fit it.
    (camera as unknown as { manual: boolean }).manual = true;
    return camera;
  }, []);
  const perspectiveCamera = useMemo(() => {
    const camera = new THREE.PerspectiveCamera(DEFAULT_PERSPECTIVE_FOV, 1, 0.1, 10000);
    camera.up.set(0, 0, 1);
    (camera as unknown as { manual: boolean }).manual = true; // see orthoCamera's own comment above
    return camera;
  }, []);
  const activeCamera = projection === "ortho" ? orthoCamera : perspectiveCamera;

  const normalMaterial = useMemo(() => new THREE.MeshNormalMaterial({ side: THREE.DoubleSide }), []);

  const targets = useMemo(() => {
    const depthTexture = new THREE.DepthTexture(1, 1);
    depthTexture.type = THREE.FloatType;
    const nearest = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
    // Half-float normals: 8-bit quantisation is too coarse for the crease test.
    const normalDepth = new THREE.WebGLRenderTarget(1, 1, { ...nearest, type: THREE.HalfFloatType, depthTexture });
    const edge = new THREE.WebGLRenderTarget(1, 1, nearest);
    // Linear, so OutputPass's lookups at screen-pixel centres average the
    // supersampled texels (a 2x2 box filter at 2x).
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

  // --- Orientation/fit bookkeeping. `settled*` is the last fully-settled
  // (non-animating) state; the two anim refs, when set, are progressed once
  // per frame below and cleared on completion. ---
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
  // Unwrapped azimuth bookkeeping for __orbitAzimuthDeg (see its own doc
  // comment above) -- `raw` is the last wrapped reading, so the next one can
  // be corrected back onto the same continuous number line before adding it
  // to `cumulativeDeg`.
  const azimuthTracking = useRef<{ raw: number; cumulativeDeg: number } | null>(null);

  // __orbitByDeg's own doc comment above explains why this exists. Rotates
  // the live camera azimuthally by `deltaDeg` around the current orbit
  // target, using the exact same up-aligning quaternion trick
  // `OrbitControls.update()` itself uses internally (see its own source) to
  // convert to/from a Y-up spherical basis regardless of this app's Z-up
  // cameras -- so the result is indistinguishable, to every other piece of
  // code that reads the camera (including __orbitAzimuthDeg above), from a
  // real drag having rotated it by the same amount. Re-registered whenever
  // `activeCamera` changes identity (a projection toggle) so it always acts
  // on whichever camera is actually live.
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

  // --- Resize (and mount): keep every target/texel uniform matched to the
  // drawing-buffer size, and re-fit instantly (a viewport resize isn't a
  // "parameter change" worth tweening). Deliberately NOT keyed on geometry/
  // preset/projection -- those each own their own effect below, so they
  // don't fight this one (an instant snap would undo their tweens/matches). ---
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
    kickInvalidate(invalidate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, size.width, size.height, targets, passes]);

  // --- Parameter changes (issue #15 AC "tweened parameter changes"):
  // whenever the geometry itself changes (a new design), ease the FIT
  // (center/radius/half-height) from wherever it was to the new geometry's
  // own bounds. The view direction never moves here -- see the preset
  // effect below for that. First mount snaps instantly (nothing to tween
  // from yet); so does reduced motion, and so does a geometry swap whose
  // fit barely moved -- notably the issue #7 draft -> final resolution bump
  // (same design, just a denser mesh): its own bounding sphere isn't
  // bit-identical to the draft's, so every geometry change would otherwise
  // kick off a (nearly imperceptible, but real, non-zero-duration) tween
  // even when nothing a user would call "a parameter change" happened,
  // which made e2e screenshots taken shortly after load flaky depending on
  // exactly when the final mesh settled relative to the screenshot.
  //
  // Issue #72: once something has actually been framed, a `resolution !==
  // "final"` geometry change is skipped entirely here (it's still DRAWN --
  // CoilViewer keeps rendering whatever mesh useDesignPreview currently
  // shows -- just never used to move the camera). Without this, a slow
  // build's fallback draft (useDesignPreview.ts's DRAFT_FALLBACK_MS) would
  // tween the camera to ITS OWN (often slightly different) bounds, only to
  // tween again moments later once the real final replaced it -- visibly
  // "growing" the model in two steps instead of the one clean tween AC
  // #72 asks for. Skipping means `settledFit`/`from` below always still
  // reflects the last FINAL fit, so that later final's own tween starts
  // from the right place regardless of whether a draft was ever shown in
  // between. The very first geometry (whatever resolution it happens to be
  // -- there's nothing better to show yet) still frames instantly, same as
  // before, via the `!mountedGeometry.current` branch below. ---
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
      recordFramingTween(); // test-only instrumentation, see its own doc comment
    }
    kickInvalidate(invalidate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, resolution]);

  // --- Preset views (issue #15 AC "slerped camera transitions"): slerp the
  // orientation quaternion from wherever the view currently is to the
  // preset's. Reduced motion jumps straight there. ---
  useEffect(() => {
    if (!mountedPreset.current) {
      mountedPreset.current = true;
      return; // the initial orientation refs already match this preset -- nothing to animate.
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
    kickInvalidate(invalidate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);

  // --- Projection toggle (issue #15 AC "preserves on-screen scale"):
  // re-fits the INCOMING camera to the same `fill` the outgoing one was
  // last fit to, looking from wherever the outgoing camera actually
  // currently is (a manual orbit-drag moves the live camera without
  // touching `settledDirection`/`settledUp`, so those would silently
  // discard it here otherwise). This is deliberately a fresh `computeFit`,
  // not a direct read-and-copy of the outgoing camera's own on-screen
  // scale: perspective's own fit (see computeFit's doc comment) already
  // pads for foreshortening on a model with real depth, which a flat
  // scale-copy doesn't account for and isn't safely invertible back out of
  // either (earlier version of this effect: ortho -> perspective ->
  // ortho drifted a real, visible amount because of exactly that). Fitting
  // both directions through the SAME `fill` keeps the toggle visually
  // continuous (no jarring zoom jump) AND makes it exactly reversible.
  // Skipped on mount (the resize effect above already framed the initial
  // camera; there is no "outgoing" camera to read from yet). ---
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
    kickInvalidate(invalidate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projection]);

  useFrame(() => {
    // Self-healing orbit target + zoom limits (issue #48): drei's
    // OrbitControls swaps in a fresh THREE.OrbitControls instance (its own
    // target/zoom bounds reset to the defaults) whenever the resolved
    // default camera changes (see the projection effect's own comment),
    // which can lag a frame behind our `set({ camera })` call below.
    // Re-asserting all of this here, every frame, is cheap and guarantees
    // whichever instance is ACTUALLY active never drifts from this
    // component's own `settledFit` bookkeeping -- including the zoom clamp,
    // which (for perspective) is expressed in world units relative to the
    // CURRENT fit's own distance, so it has to be re-derived here too, not
    // just set once.
    if (controlsRef.current && settledFit.current) {
      controlsRef.current.target.copy(settledFit.current.center);
      controlsRef.current.minZoom = ZOOM_LIMIT_MIN;
      controlsRef.current.maxZoom = ZOOM_LIMIT_MAX;
      const fittedDistance = 2 * settledFit.current.r;
      controlsRef.current.minDistance = fittedDistance / ZOOM_LIMIT_MAX;
      controlsRef.current.maxDistance = fittedDistance / ZOOM_LIMIT_MIN;

      // See __orbitAzimuthDeg's own doc comment above.
      const raw = controlsRef.current.getAzimuthalAngle();
      const prev = azimuthTracking.current;
      let delta = prev ? raw - prev.raw : 0;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      else if (delta < -Math.PI) delta += 2 * Math.PI;
      const cumulativeDeg = (prev?.cumulativeDeg ?? 0) + THREE.MathUtils.radToDeg(delta);
      azimuthTracking.current = { raw, cumulativeDeg };
      if (typeof window !== "undefined") window.__orbitAzimuthDeg = cumulativeDeg;

      // Issue #84: keep `settledDirection`/`settledUp` following a manual
      // orbit-drag (see currentOrientationOf's own doc comment) whenever
      // nothing else is actively driving the camera itself. Skipped during
      // EITHER tween, not just `orientAnim`: `controls.target` above is only
      // re-synced to `settledFit.current.center`, which a running
      // `scaleAnim` hasn't reached yet (it's still easing toward it from
      // `scaleAnim.from.center`) -- reading direction against that
      // not-yet-current target here would derive a bogus value from the gap
      // between the two centers and feed it straight back into the very
      // `applyFraming` call the scaleAnim block below makes this same
      // frame. Both tweens already commit the right value to these refs
      // themselves once they settle (or, for scaleAnim, never touch
      // direction at all -- it doesn't animate one).
      if (!orientAnim.current && !scaleAnim.current) {
        const { direction, up } = currentOrientationOf(activeCamera, controlsRef.current.target);
        settledDirection.current.copy(direction);
        settledUp.current.copy(up);
      }
    }

    // Progress a preset's orientation slerp, if one is running.
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
        // A scale tween started alongside (the framing geometry changed with
        // the preset, issue #86) aimed at the OLD direction's fit; this one
        // already framed the live geometry from the new direction.
        scaleAnim.current = null;
        settledDirection.current = direction;
        settledUp.current = up;
        if (fit) settledFit.current = fit;
        kickInvalidate(invalidate); // see kickInvalidate's own doc comment
      } else {
        invalidate();
      }
    }

    // Progress a parameter-change scale tween, if one is running (and no
    // orientation slerp is active right now -- that one already refits
    // every frame against the live direction, which supersedes this).
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
        kickInvalidate(invalidate); // see kickInvalidate's own doc comment
      } else {
        invalidate();
      }
    }

    // Recomputed per frame (cheap) because orbit zoom/dolly changes the
    // pixel size, for either projection.
    const pxH = targets.normalDepth.height;
    const edgeUniforms = passes.edgePass.uniforms;
    let pixelWorld: number;
    if (isOrthographic(activeCamera)) {
      pixelWorld = (activeCamera.top - activeCamera.bottom) / activeCamera.zoom / pxH;
    } else {
      const target = controlsRef.current?.target ?? activeCamera.position;
      const distance = activeCamera.position.distanceTo(target);
      pixelWorld = (2 * distance * Math.tan(THREE.MathUtils.degToRad(activeCamera.fov) / 2)) / pxH;
    }
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
    // Overlay layers (issue #69's dimension axes): kept out of the
    // normal+depth pass above (the camera only sees layer 0 there), so the
    // edge detector never outlines them. Lines go in before FXAA (smoothed
    // like the model's own lines), labels straight onto the canvas after it.
    const prevAutoClear = gl.autoClear;
    gl.autoClear = false;
    activeCamera.layers.set(DIMENSION_LINE_LAYER);
    MODEL_DEPTH_UNIFORM.value = targets.normalDepth.depthTexture;
    gl.setRenderTarget(targets.output);
    gl.clearDepth();
    gl.render(scene, activeCamera);
    passes.fxaaPass.render(gl, targets.output, targets.output, 0, false); // renderToScreen: writes the canvas
    activeCamera.layers.set(DIMENSION_LABEL_LAYER);
    gl.setRenderTarget(null);
    gl.clearDepth();
    gl.render(scene, activeCamera);
    activeCamera.layers.set(0);
    gl.autoClear = prevAutoClear;
    gl.setClearAlpha(prevClearAlpha);
  }, 1);

  return null;
}
