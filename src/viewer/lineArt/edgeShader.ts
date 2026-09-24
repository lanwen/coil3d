import { Vector2 } from "three";

/**
 * Fullscreen edge-detection shader (docs/research.md §10b, "skapa" technique
 * reimplemented from scratch — no skapa source was read or copied).
 *
 * Reads a normal+depth render of the whole scene (from an overrideMaterial
 * pass) and outputs the IKEA-manual look in one shot: white fill, black
 * lines where depth or normals jump between neighbouring pixels, and alpha 0
 * wherever there is no geometry at all (so the page background shows
 * through). A pixel counts as background when its depth sample is at (or
 * past) the far clip plane, which is exactly what an un-rendered pixel reads
 * after the depth target is cleared to 1.0.
 */
export const EdgeShader = {
  name: "EdgeShader",

  uniforms: {
    tNormal: { value: null },
    tDepth: { value: null },
    texel: { value: new Vector2(1 / 1024, 1 / 1024) },
    normalThreshold: { value: 0.4 },
    depthThreshold: { value: 0.0015 },
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
    uniform sampler2D tNormal;
    uniform sampler2D tDepth;
    uniform vec2 texel;
    uniform float normalThreshold;
    uniform float depthThreshold;
    varying vec2 vUv;

    float readDepth(vec2 uv) { return texture2D(tDepth, uv).x; }
    vec3 readNormal(vec2 uv) { return normalize(texture2D(tNormal, uv).rgb * 2.0 - 1.0); }

    void main() {
      float d0 = readDepth(vUv);
      // Cleared depth is 1.0 (far plane); nothing was drawn at this texel.
      bool background = d0 >= 0.999999;

      vec3 n0 = readNormal(vUv);
      float edge = 0.0;

      vec2 offsets[4];
      offsets[0] = vec2(1.0, 0.0);
      offsets[1] = vec2(-1.0, 0.0);
      offsets[2] = vec2(0.0, 1.0);
      offsets[3] = vec2(0.0, -1.0);

      for (int i = 0; i < 4; i++) {
        vec2 uv = vUv + offsets[i] * texel;
        float d1 = readDepth(uv);
        vec3 n1 = readNormal(uv);
        float depthDelta = abs(d0 - d1);
        float normalDelta = 1.0 - dot(n0, n1);
        if (depthDelta > depthThreshold || normalDelta > normalThreshold) {
          edge = 1.0;
        }
      }

      if (background) {
        gl_FragColor = vec4(1.0, 1.0, 1.0, 0.0);
        return;
      }

      float fill = edge > 0.5 ? 0.0 : 1.0;
      gl_FragColor = vec4(vec3(fill), 1.0);
    }
  `,
};
