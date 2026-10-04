import { Vector2 } from "three";

/**
 * Fullscreen edge-detection shader (docs/design.md, Rendering: the "skapa"
 * technique, reimplemented).
 *
 * Reads one normal+depth render of the scene and marks three kinds of line,
 * each exactly one pixel wide (the thicken pass sets the final weight):
 *
 * - Silhouette: a model pixel with an empty (depth = 1, cleared) neighbour.
 *   This is the outer contour against the transparent background.
 * - Occlusion: a pixel on the near side of a depth step. Uses the signed
 *   second difference of linear depth, not the first difference. A surface
 *   seen at a grazing angle has a steep but smooth depth ramp, so a
 *   first-difference test fires across a wide band there (the black
 *   "crescent" artifacts). A real step breaks the ramp, and only then does the
 *   second difference get large. The threshold is in world units, a few
 *   screen pixels' worth, so it tracks zoom.
 * - Crease: the view-space normal turns by more than a set angle between this
 *   pixel and its right or upper neighbour. The viewer splits vertex normals at
 *   hard edges (toCreasedNormals), so a crease is a clean jump in the normal
 *   buffer at any zoom, and smooth curves never reach the threshold.
 *
 * The engraved label (issue #176) is the exception: its letters are a few
 * millimetres tall, so the pocket walls and floors would fuse the usual lines
 * into solid blobs. The normal+depth pass marks the label's pocket faces with
 * alpha 0.5 (see LineArtRenderer's `FACE_KIND_ATTRIBUTE`). Around them only the
 * pocket's outline is marked, in its own channel, and the thicken pass draws
 * it with a finer pen.
 *
 * The chamfers on the rim of the flange and the cap (issue #229) are small
 * enough that an IKEA drawing leaves them out. The same pass marks a chamfer
 * with alpha 0.9 and the vertical land between a rim's two chamfers with 0.8,
 * and the crease between the two is not drawn. What remains is the line where
 * the plate's face meets its rim, as on a plate with square edges, and the
 * silhouette.
 *
 * Where the core's groove fades out (alpha 0.97), its edges turn gradually
 * shallower and would cross the crease angle in broken dashes. The creases
 * within the fade are not drawn, so each groove line ends where the groove's
 * full depth ends.
 *
 * Output: r = ink (1 on a line pixel), g = model coverage, b = fine ink (the
 * label's outline), a = 1. The thicken pass turns that into the final white
 * fill, black line and alpha.
 */
export const EdgeShader = {
  name: "EdgeShader",

  uniforms: {
    tNormal: { value: null },
    tDepth: { value: null },
    texel: { value: new Vector2(1 / 1024, 1 / 1024) },
    /** far - near of the orthographic camera: converts [0,1] depth to world units. */
    depthRange: { value: 1 },
    /** Minimum depth second difference (world units) that counts as a step. */
    depthThreshold: { value: 1 },
    /** Cosine of the minimum normal turn that counts as a crease. */
    normalThreshold: { value: Math.cos((30 * Math.PI) / 180) },
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
    // On the groove's fade (alpha 0.97). A crease within it is not drawn.
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
        if (max(lx, ly) > depthThreshold) ink = 1.0;

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
