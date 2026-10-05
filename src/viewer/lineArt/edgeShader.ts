import { Vector2 } from "three";

export const EdgeShader = {
  name: "EdgeShader",

  uniforms: {
    tNormal: { value: null },
    tDepth: { value: null },
    texel: { value: new Vector2(1 / 1024, 1 / 1024) },
    depthRange: { value: 1 },
    depthThreshold: { value: 1 },
    normalThreshold: { value: Math.cos((30 * Math.PI) / 180) },
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
    uniform sampler2D tNormal;
    uniform sampler2D tDepth;
    uniform vec2 texel;
    uniform float depthRange;
    uniform float depthThreshold;
    uniform float normalThreshold;
    varying vec2 vUv;

    float depthAt(vec2 uv) { return texture2D(tDepth, uv).x; }
    vec3 normalAt(vec2 uv) { return normalize(texture2D(tNormal, uv).rgb * 2.0 - 1.0); }
    float labelAt(vec2 uv) { return step(texture2D(tNormal, uv).a, 0.75); }
    // 1 on a rim's chamfer (alpha 0.9), 2 on the land between its chamfers (alpha 0.8), else 0.
    float rimAt(vec2 uv) {
      float a = texture2D(tNormal, uv).a;
      return a > 0.85 && a < 0.95 ? 1.0 : (a > 0.75 && a <= 0.85 ? 2.0 : 0.0);
    }
    // The crease between a chamfer and the plate's flat face is not drawn.
    bool chamferToFace(float a, float b) { return a + b == 1.0; }
    // On the groove's fade (alpha 0.97). A crease or depth step within it is not drawn.
    bool fadeAt(vec2 uv) { float a = texture2D(tNormal, uv).a; return a > 0.955 && a < 0.985; }
    bool quietCrease(vec2 a, vec2 b) { return fadeAt(a) && fadeAt(b); }

    void main() {
      float d0 = depthAt(vUv);
      // The depth target is cleared to 1.0 (far plane) and the far plane sits
      // past the model's bounding sphere, so only empty pixels read 1.0.
      if (d0 >= 1.0) {
        gl_FragColor = vec4(0.0);
        return;
      }

      vec2 dx = vec2(texel.x, 0.0);
      vec2 dy = vec2(0.0, texel.y);
      float dl = depthAt(vUv - dx);
      float dr = depthAt(vUv + dx);
      float dd = depthAt(vUv - dy);
      float du = depthAt(vUv + dy);

      float ink = 0.0;
      float fine = 0.0;
      float l0 = labelAt(vUv);
      float lr = labelAt(vUv + dx);
      float lu = labelAt(vUv + dy);
      if (max(max(dl, dr), max(dd, du)) >= 1.0) {
        ink = 1.0;
      } else if (max(max(l0, lr), max(lu, max(labelAt(vUv - dx), labelAt(vUv - dy)))) > 0.5) {
        // At or in the label's pockets: only the outline, one pixel where the label starts.
        if (l0 != lr || l0 != lu) fine = 1.0;
      } else {
        // Positive only on the near side of a step: the far side reads
        // negative, so each step marks one pixel, on the occluding surface.
        float lx = (dl + dr - 2.0 * d0) * depthRange;
        float ly = (dd + du - 2.0 * d0) * depthRange;
        bool f0 = fadeAt(vUv);
        bool quietX = f0 && fadeAt(vUv - dx) && fadeAt(vUv + dx);
        bool quietY = f0 && fadeAt(vUv - dy) && fadeAt(vUv + dy);
        if ((lx > depthThreshold && !quietX) || (ly > depthThreshold && !quietY)) ink = 1.0;

        vec3 n0 = normalAt(vUv);
        float k0 = rimAt(vUv);
        if ((dot(n0, normalAt(vUv + dx)) < normalThreshold && !chamferToFace(k0, rimAt(vUv + dx)) && !quietCrease(vUv, vUv + dx)) ||
            (dot(n0, normalAt(vUv + dy)) < normalThreshold && !chamferToFace(k0, rimAt(vUv + dy)) && !quietCrease(vUv, vUv + dy))) {
          ink = 1.0;
        }
      }

      gl_FragColor = vec4(ink, 1.0, fine, 1.0);
    }
  `,
};
