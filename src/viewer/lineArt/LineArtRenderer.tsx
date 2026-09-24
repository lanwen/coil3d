import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { EdgeShader } from "./edgeShader";
import { MAX_THICKEN_RADIUS, ThickenShader } from "./thickenShader";

// docs/research.md §10b: thickness = k * devicePixelRatio / diagonal(projected
// bounding box). k is tuned by eye against the acceptance goal ("thin, even
// black lines", not the spike's too-thick outlines) — see the screenshot
// baselines this ticket adds.
const THICKNESS_K = 32;
const MIN_THICKNESS_PX = 0.6;
// Capped well under MAX_THICKEN_RADIUS: a coil with many tightly-packed
// helical turns projects a small diagonal even though it has lots of fine
// detail, and the raw k/diagonal formula would otherwise ask for a dilate
// radius wide enough to fuse every turn into a solid black mass (the exact
// failure this ticket replaces). Capping trades "on-screen weight tracks
// footprint exactly" for "never fuses adjacent detail" — see the long/many-
// turn screenshot baseline.
const MAX_THICKNESS_PX = Math.min(1.8, MAX_THICKEN_RADIUS);

// A fixed 3/4 "IKEA manual" viewing direction. Orbiting away from it doesn't
// need a reframe: the camera is fitted to the model's bounding *sphere*, so
// every rotation stays inside the frustum without recomputing on each frame.
const VIEW_DIR = new THREE.Vector3(0.6, 0.55, 0.75).normalize();
const FRAME_MARGIN = 1.15;

function disableBlendAndDepth(material: THREE.ShaderMaterial | THREE.RawShaderMaterial) {
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.NoBlending;
  material.transparent = false;
}

export interface LineArtRendererProps {
  /** The coil geometry to frame and outline. Null while nothing is designed yet. */
  geometry: THREE.BufferGeometry | null;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}

/**
 * The IKEA line-art post pipeline (issue #3, docs/research.md §10b — the
 * "skapa" technique reimplemented from the written description only, no
 * skapa source was read):
 *
 *   normal+depth pass -> edge shader -> thicken (dilate) -> OutputPass
 *   (colour-space conversion) -> FXAA -> screen
 *
 * Drives its own render targets and `Pass` instances directly (a hand-rolled
 * composer) inside a `useFrame` with a priority, which hands this component
 * full control of the render loop for as long as it is mounted.
 */
export function LineArtRenderer({ geometry, controlsRef }: LineArtRendererProps) {
  const { gl, scene, camera, size } = useThree();
  const orthoCamera = camera as THREE.OrthographicCamera;

  const normalMaterial = useMemo(() => new THREE.MeshNormalMaterial({ side: THREE.DoubleSide }), []);

  const targets = useMemo(() => {
    const depthTexture = new THREE.DepthTexture(1, 1);
    depthTexture.type = THREE.FloatType;
    const normalDepth = new THREE.WebGLRenderTarget(1, 1, { depthTexture });
    const edge = new THREE.WebGLRenderTarget(1, 1);
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
    return { edgePass, thickenPass, outputPass, fxaaPass };
  }, []);

  useEffect(
    () => () => {
      targets.normalDepth.dispose();
      targets.edge.dispose();
      targets.thicken.dispose();
      targets.output.dispose();
      passes.edgePass.dispose();
      passes.thickenPass.dispose();
      passes.outputPass.dispose();
      passes.fxaaPass.dispose();
      normalMaterial.dispose();
    },
    [targets, passes, normalMaterial],
  );

  // --- Resize: keep every target and the FXAA/edge/thicken texel uniforms
  // matched to the drawing-buffer size. ---
  useEffect(() => {
    const dpr = gl.getPixelRatio();
    const w = Math.max(1, Math.round(size.width * dpr));
    const h = Math.max(1, Math.round(size.height * dpr));

    targets.normalDepth.setSize(w, h);
    targets.edge.setSize(w, h);
    targets.thicken.setSize(w, h);
    targets.output.setSize(w, h);

    const texel = new THREE.Vector2(1 / w, 1 / h);
    passes.edgePass.uniforms.texel.value.copy(texel);
    passes.thickenPass.uniforms.texel.value.copy(texel);
    passes.fxaaPass.uniforms.resolution.value.set(1 / w, 1 / h);
  }, [gl, size, targets, passes]);

  // --- Reframe: refit the orthographic camera to the model, and recompute
  // the dilate thickness from the freshly-projected screen-space bounds.
  // Runs once per geometry or canvas-size change, not per frame/orbit — see
  // docs/research.md §10b and the shader files for why that is the point. ---
  useEffect(() => {
    if (!geometry) return;
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box || box.isEmpty()) return;

    const center = new THREE.Vector3();
    box.getCenter(center);
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    const radius = Math.max(1e-3, sphere.radius);

    orthoCamera.position.copy(center).addScaledVector(VIEW_DIR, radius * 4);
    orthoCamera.up.set(0, 1, 0);
    orthoCamera.lookAt(center);

    const aspect = size.width > 0 && size.height > 0 ? size.width / size.height : 1;
    const halfHeight = radius * FRAME_MARGIN;
    orthoCamera.left = -halfHeight * aspect;
    orthoCamera.right = halfHeight * aspect;
    orthoCamera.top = halfHeight;
    orthoCamera.bottom = -halfHeight;
    orthoCamera.near = radius * 0.01;
    orthoCamera.far = radius * 8;
    orthoCamera.updateProjectionMatrix();
    orthoCamera.updateMatrixWorld(true);

    const controls = controlsRef.current;
    if (controls) {
      controls.target.copy(center);
      controls.update();
    }

    // Project the 8 box corners to find the on-screen bounds diagonal.
    const dpr = gl.getPixelRatio();
    const pxW = Math.max(1, Math.round(size.width * dpr));
    const pxH = Math.max(1, Math.round(size.height * dpr));

    // Crease sensitivity in world units, converted to the depth buffer's
    // normalized range for the *current* near/far span (which changes with
    // model size), so a groove reads the same regardless of coil size.
    //
    // Scaled off the world-space size of one screen pixel (the orthographic
    // frustum's height divided by the canvas height in device pixels), not
    // off the model's own bounding-box size: the edge test only ever compares
    // *adjacent pixels*, so the right yardstick for "is this a real depth
    // step" is a few pixels' worth of world-space distance, regardless of how
    // big or how elongated the model is. Tying it to overall model size
    // instead over- or under-shoots for oblong coils (a wound-up long cord
    // has a bounding radius dominated by its length, not its much smaller
    // diameter): too tight and the near-silhouette depth gradient on the
    // curved wall flags almost every pixel as an edge (a solid-black
    // render); too loose and fine groove creases drop out into dashed lines.
    const pixelWorldSize = (orthoCamera.top - orthoCamera.bottom) / pxH;
    const worldEps = pixelWorldSize * 3;
    passes.edgePass.uniforms.depthThreshold.value = worldEps / (orthoCamera.far - orthoCamera.near);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const corner = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      corner.set(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      );
      corner.project(orthoCamera);
      const px = ((corner.x + 1) / 2) * pxW;
      const py = ((1 - corner.y) / 2) * pxH;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    const diagonalPx = Math.max(1, Math.hypot(maxX - minX, maxY - minY));
    const thickness = (THICKNESS_K * dpr) / diagonalPx;
    passes.thickenPass.uniforms.thicknessPx.value = THREE.MathUtils.clamp(
      thickness,
      MIN_THICKNESS_PX,
      MAX_THICKNESS_PX,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, size.width, size.height, orthoCamera, controlsRef, gl, passes]);

  // --- Hit-testing: read the thicken pass's alpha at the pointer so orbit
  // only starts when the pointer is actually over the outlined model. ---
  useEffect(() => {
    const el = gl.domElement;
    const dpr = gl.getPixelRatio();
    const pixel = new Uint8Array(4);

    function alphaAt(clientX: number, clientY: number): number {
      const rect = el.getBoundingClientRect();
      const px = Math.round((clientX - rect.left) * dpr);
      const pyTop = Math.round((clientY - rect.top) * dpr);
      const h = targets.thicken.height;
      const py = h - 1 - pyTop;
      if (px < 0 || py < 0 || px >= targets.thicken.width || py >= h) return 0;
      gl.readRenderTargetPixels(targets.thicken, px, py, 1, 1, pixel);
      return pixel[3];
    }

    function onPointerDown(e: PointerEvent) {
      const controls = controlsRef.current;
      if (!controls) return;
      controls.enabled = alphaAt(e.clientX, e.clientY) > 0;
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
    const prevOverride = scene.overrideMaterial;

    gl.setRenderTarget(targets.normalDepth);
    gl.clear(true, true, false);
    scene.overrideMaterial = normalMaterial;
    gl.render(scene, camera);
    scene.overrideMaterial = prevOverride;

    passes.edgePass.uniforms.tNormal.value = targets.normalDepth.texture;
    passes.edgePass.uniforms.tDepth.value = targets.normalDepth.depthTexture;
    passes.edgePass.render(gl, targets.edge, targets.normalDepth, 0, false);

    passes.thickenPass.render(gl, targets.thicken, targets.edge, 0, false);
    passes.outputPass.render(gl, targets.output, targets.thicken, 0, false);

    passes.fxaaPass.renderToScreen = true;
    gl.setRenderTarget(null);
    gl.clear(true, true, false);
    passes.fxaaPass.render(gl, targets.output, targets.output, 0, false);
  }, 1);

  return null;
}
