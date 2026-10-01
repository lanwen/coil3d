import { Vector2 } from "three";

/**
 * "Thicken" (dilate) pass, docs/design.md, Rendering. Takes the edge pass's
 * one-pixel lines and turns every pixel within `thicknessPx` of a line pixel
 * black. Coverage falls off over the last pixel, so fractional weights work
 * and the lines come out anti-aliased before FXAA runs.
 *
 * The edge pass's fine lines (its b channel, the engraved label's outline)
 * are drawn the same way with the smaller `fineThicknessPx`.
 *
 * Output is premultiplied alpha for the transparent canvas: white fill
 * (1,1,1,1) on the model, black ink (0,0,0,coverage) where a line spreads
 * past the silhouette into the background, and (0,0,0,0) elsewhere.
 *
 * The search radius is a compile-time constant (GLSL ES 1.00 loops need
 * constant bounds). The caller clamps thicknessPx below it.
 */
export const MAX_THICKEN_RADIUS = 4;

export const ThickenShader = {
  name: "ThickenShader",

  uniforms: {
    tDiffuse: { value: null },
    texel: { value: new Vector2(1 / 1024, 1 / 1024) },
    thicknessPx: { value: 1.0 },
    fineThicknessPx: { value: 0.5 },
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
    uniform float fineThicknessPx;
    varying vec2 vUv;

    const int MAX_R = ${MAX_THICKEN_RADIUS};

    void main() {
      float model = texture2D(tDiffuse, vUv).g;
      float nearest = 1e3;
      float nearestFine = 1e3;
      for (int y = -MAX_R; y <= MAX_R; y++) {
        for (int x = -MAX_R; x <= MAX_R; x++) {
          vec2 o = vec2(float(x), float(y));
          vec4 edge = texture2D(tDiffuse, vUv + o * texel);
          if (edge.r > 0.5) nearest = min(nearest, length(o));
          if (edge.b > 0.5) nearestFine = min(nearestFine, length(o));
        }
      }
      float ink = max(clamp(thicknessPx + 0.5 - nearest, 0.0, 1.0), clamp(fineThicknessPx + 0.5 - nearestFine, 0.0, 1.0));
      gl_FragColor = vec4(vec3(model * (1.0 - ink)), max(model, ink));
    }
  `,
};
