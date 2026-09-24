import { Vector2 } from "three";

/**
 * "Thicken" (dilate) pass, docs/research.md §10b: a pixel turns black if any
 * black line pixel from the edge pass lies within `thicknessPx` screen
 * pixels of it. `thicknessPx` is recomputed by the caller on every camera
 * reframe (see LineArtRenderer.reframe), not every frame, so line weight
 * reads as constant at a given zoom/model size instead of growing with
 * resolution or shrinking as the model fills more of the screen.
 *
 * The search radius is a fixed compile-time constant (MAX_R) so the shader
 * stays valid GLSL ES 1.00 (loop bounds must be constant); thicknessPx only
 * narrows which of those samples count, via the `dist > thicknessPx` guard.
 * Ceil the JS-side value against MAX_R before assigning the uniform.
 */
export const MAX_THICKEN_RADIUS = 6;

export const ThickenShader = {
  name: "ThickenShader",

  uniforms: {
    tDiffuse: { value: null },
    texel: { value: new Vector2(1 / 1024, 1 / 1024) },
    thicknessPx: { value: 1.0 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 texel;
    uniform float thicknessPx;
    varying vec2 vUv;

    const int MAX_R = ${MAX_THICKEN_RADIUS};

    void main() {
      vec4 center = texture2D(tDiffuse, vUv);
      float fill = center.r;
      float alpha = center.a;

      for (int y = -MAX_R; y <= MAX_R; y++) {
        for (int x = -MAX_R; x <= MAX_R; x++) {
          if (x == 0 && y == 0) continue;
          float dist = length(vec2(float(x), float(y)));
          if (dist > thicknessPx) continue;
          vec2 uv = vUv + vec2(float(x), float(y)) * texel;
          vec4 s = texture2D(tDiffuse, uv);
          // A line pixel (alpha>0, dark) within range spreads black onto us,
          // including out into background (alpha 0) pixels, which is how a
          // visible-width outline forms against the transparent backdrop.
          if (s.a > 0.0 && s.r < 0.5) {
            fill = 0.0;
            alpha = 1.0;
          }
        }
      }

      gl_FragColor = vec4(vec3(fill), alpha);
    }
  `,
};
