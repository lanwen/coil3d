import { Vector2 } from "three";

export const MAX_THICKEN_RADIUS = 4;

export const ThickenShader = {
  name: "ThickenShader",

  uniforms: {
    tDiffuse: { value: null },
    texel: { value: new Vector2(1 / 1024, 1 / 1024) },
    thicknessPx: { value: 1.0 },
    fineThicknessPx: { value: 0.5 },
  },

  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,

  fragmentShader: `
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
      // A line pixel further away than this adds no ink (both clamps below
      // are 0 there), so its texture fetch is skipped. That leaves a circle
      // of 20-40 taps instead of the 81 of the full MAX_R square.
      float reach = max(thicknessPx, fineThicknessPx) + 0.5;
      float reachSq = reach * reach;
      int r = min(int(reach), MAX_R);
      for (int y = -r; y <= r; y++) {
        for (int x = -r; x <= r; x++) {
          vec2 o = vec2(float(x), float(y));
          if (dot(o, o) >= reachSq) continue;
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
