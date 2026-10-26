import { Vector2 } from "three";
import { RIM_EDGE_ALPHA } from "./edgeShader";

export const MAX_THICKEN_RADIUS = 4;
const GAP_CLOSE_PX = 2.5;
const GAP_CLOSE_STEPS = 10;

export const ThickenShader = {
  name: "ThickenShader",

  uniforms: {
    tDiffuse: { value: null },
    texel: { value: new Vector2(1 / 1024, 1 / 1024) },
    thicknessPx: { value: 1.0 },
    fineThicknessPx: { value: 0.5 },
    gapClosePx: { value: GAP_CLOSE_PX },
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
    uniform float gapClosePx;
    varying vec2 vUv;

    const int MAX_R = ${MAX_THICKEN_RADIUS};
    const int GAP_STEPS = ${GAP_CLOSE_STEPS};

    bool onRim(vec4 edge) { return abs(edge.a - ${RIM_EDGE_ALPHA.toFixed(1)}) < 0.25; }

    vec2 edgeAlong(vec2 uv, vec2 step) {
      for (int k = 1; k <= GAP_STEPS; k++) {
        vec4 edge = texture2D(tDiffuse, uv + float(k) * step * texel);
        if (edge.r > 0.5) return vec2(float(k) * length(step), onRim(edge) ? 1.0 : 0.0);
      }
      return vec2(1e3, 0.0);
    }

    bool inClosableGap(vec2 uv, float spacing) {
      bool rimHere = onRim(texture2D(tDiffuse, uv));
      vec2 axes[4];
      axes[0] = vec2(1.0, 0.0);
      axes[1] = vec2(0.0, 1.0);
      axes[2] = vec2(1.0, 1.0);
      axes[3] = vec2(1.0, -1.0);
      for (int i = 0; i < 4; i++) {
        vec2 a = edgeAlong(uv, axes[i]);
        vec2 b = edgeAlong(uv, -axes[i]);
        if (a.x + b.x <= spacing && (rimHere || a.y + b.y > 0.5)) return true;
      }
      return false;
    }

    void main() {
      float model = texture2D(tDiffuse, vUv).g;
      float nearest = 1e3;
      float nearestFine = 1e3;
      // A line pixel further away than this adds no ink (both clamps below
      // are 0 there), so its texture fetch is skipped. That leaves a circle
      // of 20-40 taps instead of the 81 of the full MAX_R square.
      float reach = max(thicknessPx, fineThicknessPx) + 0.5;
      float searchReach = reach + 0.5 * gapClosePx;
      float reachSq = searchReach * searchReach;
      int r = min(int(searchReach), MAX_R);
      for (int y = -r; y <= r; y++) {
        for (int x = -r; x <= r; x++) {
          vec2 o = vec2(float(x), float(y));
          if (dot(o, o) >= reachSq) continue;
          vec4 edge = texture2D(tDiffuse, vUv + o * texel);
          if (edge.r > 0.5) nearest = min(nearest, length(o));
          if (edge.b > 0.5) nearestFine = min(nearestFine, length(o));
        }
      }
      float mainInk = clamp(thicknessPx + 0.5 - nearest, 0.0, 1.0);
      if (mainInk < 1.0 && nearest < searchReach && inClosableGap(vUv, 2.0 * thicknessPx + 1.0 + gapClosePx)) mainInk = 1.0;
      float ink = max(mainInk, clamp(fineThicknessPx + 0.5 - nearestFine, 0.0, 1.0));
      gl_FragColor = vec4(vec3(model * (1.0 - ink)), max(model, ink));
    }
  `,
};
