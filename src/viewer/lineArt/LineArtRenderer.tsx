import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { EdgeShader } from "./edgeShader";
import { MAX_THICKEN_RADIUS, ThickenShader } from "./thickenShader";

// A 3/4 "assembly manual" view: the coil stands on its flange (z up) and is
// seen from about 32 degrees above, so the open top end and the bore show.
const VIEW_DIR = new THREE.Vector3(1, -1, 0.9).normalize();
const UP = new THREE.Vector3(0, 0, 1);
// The model's projected bounds fill this fraction of the canvas's tighter axis.
const FILL = 0.75;
// Line weight (thicken radius, CSS px) scales gently with the model's
// on-screen diagonal (docs/research.md §10b), clamped so it stays a thin pen
// line on small canvases and never fuses the groove rings on large ones.
const LINE_WEIGHT_PER_DIAGONAL_PX = 1 / 500;
const MIN_LINE_WEIGHT = 1.0;
const MAX_LINE_WEIGHT = 1.6;
// A depth step counts as an occlusion edge when it exceeds this many
// line-pass pixels' worth of world-space distance.
const DEPTH_STEP_PX = 4;

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

export interface LineArtRendererProps {
  /** The coil geometry to frame and outline. */
  geometry: THREE.BufferGeometry;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}

/**
 * The IKEA line-art post pipeline (issue #3, docs/research.md §10b):
 *
 *   normal+depth pass -> edge shader -> thicken (dilate) -> OutputPass
 *   (colour-space conversion) -> FXAA -> screen
 *
 * Drives its own render targets and passes inside a `useFrame` with a
 * priority, which takes over R3F's render loop while mounted. The canvas
 * renders on demand (the pipeline is heavy on software GL), so every change
 * made here outside R3F's own props calls `invalidate()`.
 */
export function LineArtRenderer({ geometry, controlsRef }: LineArtRendererProps) {
  const { gl, scene, size, invalidate } = useThree();
  const camera = useThree((s) => s.camera) as THREE.OrthographicCamera;

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

  // --- Resize: keep every target and texel uniform matched to the
  // drawing-buffer size. ---
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
    invalidate();
  }, [gl, size, targets, passes, invalidate]);

  // --- Reframe: on every geometry or canvas-size change, point the camera
  // along VIEW_DIR, fit the frustum to the model's projected vertices, and
  // recompute the line weight from the projected bounds. ---
  useEffect(() => {
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere;
    if (!sphere || sphere.radius <= 0) return;
    const r = sphere.radius;
    const aspect = size.width > 0 && size.height > 0 ? size.width / size.height : 1;

    camera.up.copy(UP);
    camera.position.copy(sphere.center).addScaledVector(VIEW_DIR, 2 * r);
    camera.lookAt(sphere.center);
    camera.updateMatrixWorld(true);

    // Projected bounds of the actual vertices, in camera space.
    const pos = geometry.getAttribute("position");
    const inverse = camera.matrixWorldInverse;
    const v = new THREE.Vector3();
    const bounds = new THREE.Box2();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(inverse);
      bounds.expandByPoint(new THREE.Vector2(v.x, v.y));
    }
    const mid = bounds.getCenter(new THREE.Vector2());
    const extent = bounds.getSize(new THREE.Vector2());

    // Slide the camera sideways so the projected bounds are centred on its
    // axis; orbit then pivots around the model's visual middle.
    const shift = new THREE.Vector3(mid.x, mid.y, 0).applyQuaternion(camera.quaternion);
    camera.position.add(shift);
    const target = sphere.center.clone().add(shift);

    const halfHeight = Math.max(extent.y / 2, extent.x / 2 / aspect) / FILL;
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.zoom = 1;
    // Distance 2r to the centre, so the bounding sphere (and every orbit of
    // it) sits strictly between near and far and never reads as background.
    camera.near = r * 0.5;
    camera.far = r * 3.5;
    camera.updateProjectionMatrix();

    const controls = controlsRef.current;
    if (controls) {
      controls.target.copy(target);
      controls.update();
    }

    const cssPerWorld = size.height / (2 * halfHeight);
    const diagonalCss = Math.hypot(extent.x, extent.y) * cssPerWorld;
    const weight = THREE.MathUtils.clamp(diagonalCss * LINE_WEIGHT_PER_DIAGONAL_PX, MIN_LINE_WEIGHT, MAX_LINE_WEIGHT);
    passes.thickenPass.uniforms.thicknessPx.value = Math.min(
      weight * linePixelRatio(gl.getPixelRatio()),
      MAX_THICKEN_RADIUS - 0.5,
    );
    invalidate();
  }, [geometry, size.width, size.height, camera, controlsRef, gl, passes, invalidate]);

  // --- Hit-testing: read the thicken pass's alpha under the pointer so orbit
  // only starts on the outlined model, not on the transparent background. ---
  useEffect(() => {
    const el = gl.domElement;
    const pixel = new Uint8Array(4);

    function alphaAt(clientX: number, clientY: number): number {
      const ratio = linePixelRatio(gl.getPixelRatio());
      const rect = el.getBoundingClientRect();
      const px = Math.floor((clientX - rect.left) * ratio);
      const py = targets.thicken.height - 1 - Math.floor((clientY - rect.top) * ratio);
      if (px < 0 || py < 0 || px >= targets.thicken.width || py >= targets.thicken.height) return 0;
      gl.readRenderTargetPixels(targets.thicken, px, py, 1, 1, pixel);
      return pixel[3];
    }

    function onPointerDown(e: PointerEvent) {
      const controls = controlsRef.current;
      if (controls) controls.enabled = alphaAt(e.clientX, e.clientY) > 0;
    }

    function onPointerUp() {
      const controls = controlsRef.current;
      if (controls) controls.enabled = true;
    }

    el.addEventListener("pointerdown", onPointerDown, { capture: true });
    window.addEventListener("pointerup", onPointerUp, { capture: true });
    return () => {
      el.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("pointerup", onPointerUp, { capture: true });
    };
  }, [gl, controlsRef, targets]);

  useFrame(() => {
    // Recomputed per frame (cheap) because orbit zoom changes the pixel size.
    const pxH = targets.normalDepth.height;
    const pixelWorld = (camera.top - camera.bottom) / camera.zoom / pxH;
    const edgeUniforms = passes.edgePass.uniforms;
    edgeUniforms.depthRange.value = camera.far - camera.near;
    edgeUniforms.depthThreshold.value = DEPTH_STEP_PX * pixelWorld;

    const prevOverride = scene.overrideMaterial;
    const prevClearAlpha = gl.getClearAlpha();
    gl.setClearAlpha(0);
    gl.setRenderTarget(targets.normalDepth);
    gl.clear(true, true, false);
    scene.overrideMaterial = normalMaterial;
    gl.render(scene, camera);
    scene.overrideMaterial = prevOverride;

    edgeUniforms.tNormal.value = targets.normalDepth.texture;
    edgeUniforms.tDepth.value = targets.normalDepth.depthTexture;
    passes.edgePass.render(gl, targets.edge, targets.normalDepth, 0, false);
    passes.thickenPass.render(gl, targets.thicken, targets.edge, 0, false);
    passes.outputPass.render(gl, targets.output, targets.thicken, 0, false);
    passes.fxaaPass.render(gl, targets.output, targets.output, 0, false); // renderToScreen: writes the canvas
    gl.setClearAlpha(prevClearAlpha);
  }, 1);

  return null;
}
