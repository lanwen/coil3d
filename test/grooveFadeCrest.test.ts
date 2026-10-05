import { describe, expect, it } from "vitest";
import { design, parseHash } from "../src/core";

// Issue #251: the viewer leaves out the creases among the core's fade triangles (`mesh.fadeTriangles`), so a groove's
// lines end where its full depth ends. The groove's run-in sits level while the turn above it follows the helix, so a
// fade band measured from the run-in took in the crest of that full turn, and its crest line went undrawn across the
// run-in. That crest must stay outside the fade: at least one of its two faces is not a fade triangle.

const doc = { v: 2, L: 800, d: 4, size: 60, h: 20, shape: "sq", rc: 20 };
const hash = `#s=${Buffer.from(JSON.stringify(doc), "utf-8").toString("base64url")}`;

/** The mesh's sharp edges (dihedral > 30 degrees) with the triangles on both sides, welded by position. */
function sharpEdges(mesh: { positions: Float32Array; indices: Uint32Array }) {
  const P = mesh.positions;
  const I = mesh.indices;
  const welded = new Map<string, number>();
  const vid = (v: number) => {
    const key = `${P[v * 3].toFixed(4)},${P[v * 3 + 1].toFixed(4)},${P[v * 3 + 2].toFixed(4)}`;
    const id = welded.get(key);
    if (id !== undefined) return id;
    welded.set(key, v);
    return v;
  };
  const normal = (t: number) => {
    const [a, b, c] = [I[t * 3] * 3, I[t * 3 + 1] * 3, I[t * 3 + 2] * 3];
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    return n.map((x) => x / len);
  };
  const triangles = new Map<string, number[]>();
  const ends = new Map<string, [number, number]>();
  for (let t = 0; t < I.length / 3; t++) {
    const vs = [vid(I[t * 3]), vid(I[t * 3 + 1]), vid(I[t * 3 + 2])];
    for (let e = 0; e < 3; e++) {
      const [a, b] = [vs[e], vs[(e + 1) % 3]];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      triangles.set(key, [...(triangles.get(key) ?? []), t]);
      ends.set(key, [a, b]);
    }
  }
  const edges: Array<{ angle: number; z: number; faces: [number, number] }> = [];
  for (const [key, ts] of triangles) {
    if (ts.length !== 2) continue;
    const [n0, n1] = [normal(ts[0]), normal(ts[1])];
    const dot = n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2];
    if ((Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI <= 30) continue;
    const [a, b] = ends.get(key)!;
    const [x, y, z] = [0, 1, 2].map((k) => (P[a * 3 + k] + P[b * 3 + k]) / 2);
    edges.push({ angle: (Math.atan2(y, x) * 180) / Math.PI, z, faces: [ts[0], ts[1]] });
  }
  return edges;
}

describe("groove fade (#251)", () => {
  it("leaves the crest of the first full turn out of the fade over the run-in", async () => {
    const parsed = parseHash(hash).spec;
    const core = (await design(parsed, "final")).parts.find((p) => p.role === "core")!;
    const fade = new Set(core.mesh.fadeTriangles ?? []);
    expect(fade.size).toBeGreaterThan(0);
    // The crest of the first full turn above the run-in, at its start: it rises 0.1 mm per 7.5 degrees from z 4.5 mm
    // at -50 degrees, and the run-in's own groove edges lie 0.3 mm or more below it.
    const crest = sharpEdges(core.mesh).filter((e) => e.angle > -55 && e.angle < -30 && e.z > 4.4 && e.z < 4.8);
    expect(crest.length).toBeGreaterThanOrEqual(3);
    for (const e of crest) expect(fade.has(e.faces[0]) && fade.has(e.faces[1])).toBe(false);
  });
});
