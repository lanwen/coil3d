import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilMesh, CoilSpec, JointKind, ShapeSpec } from "../src/core";

// Issue #180: the flat faces of the top cap (its underside around the collar and
// the cable clips, its top under the label) and of the core's flange (around
// the cable channel) must not hold needle triangles.
// After the booleans they came out as 10-40 mm long fans a thousandth of a
// millimetre wide, which the line-art renderer draws as a dotted line of
// isolated pixels on the plate.

function spec(overrides: Partial<CoilSpec>): CoilSpec {
  return {
    wire: { length: 6000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 60 },
    height: { locked: true, value: 60 },
    layers: { locked: true, value: 2 },
    objective: "minVolume",
    topCap: "on",
    joint: "press",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    mount: "none",
    plateJoint: "glue",
    ...overrides,
  };
}

/**
 * The longest side (mm) among the narrow triangles lying flat in a horizontal
 * plane: under `width` mm high over the longest side, and with at most one
 * side on the face's border. (A triangle with two sides on the border is an
 * ear of a nearly straight outline; it sits beside the drawn edge line.)
 */
function longestNeedle(mesh: CoilMesh, width: number): number {
  const { positions: P, indices: I } = mesh;
  const z = (v: number) => P[3 * v + 2];
  const flat = (t: number) => z(I[t]) === z(I[t + 1]) && z(I[t]) === z(I[t + 2]);
  const sideKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  // For each side, how many flat triangles use it: 1 means the next triangle is not in the plane, so the side is on the border.
  const uses = new Map<string, number>();
  for (let t = 0; t < I.length; t += 3) {
    if (!flat(t)) continue;
    for (let k = 0; k < 3; k++) uses.set(sideKey(I[t + k], I[t + ((k + 1) % 3)]), (uses.get(sideKey(I[t + k], I[t + ((k + 1) % 3)])) ?? 0) + 1);
  }
  let longest = 0;
  for (let t = 0; t < I.length; t += 3) {
    if (!flat(t)) continue;
    const ids = [I[t], I[t + 1], I[t + 2]];
    const v = ids.map((i) => [P[3 * i], P[3 * i + 1]]);
    const side = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const max = Math.max(side(v[1], v[2]), side(v[0], v[2]), side(v[0], v[1]));
    const twiceArea = Math.abs((v[1][0] - v[0][0]) * (v[2][1] - v[0][1]) - (v[1][1] - v[0][1]) * (v[2][0] - v[0][0]));
    const border = [0, 1, 2].filter((k) => uses.get(sideKey(ids[k], ids[(k + 1) % 3])) === 1).length;
    if (twiceArea / max < width && border < 2) longest = Math.max(longest, max);
  }
  return longest;
}

const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 12 }, { kind: "tri", cornerRadius: 12 }];
const JOINTS: JointKind[] = ["press", "snap", "bayonet"];

describe("issue #180: no needle triangles in the flat faces of the top cap and the core's flange", () => {
  const cases = SHAPES.flatMap((shape) => JOINTS.map((joint) => ({ name: `${shape.kind}, ${joint}`, spec: spec({ shape, joint }) })));
  cases.push({ name: "round, press, with a label", spec: spec({ label: "USB-C 2m" }) });

  // A needle is under 0.02 mm wide (a corner of the outline that is a hair off
  // straight is wider). Before the fix they ran 23-53 mm; the pass keeps every
  // edge of the flat faces under 10 mm and the worst needle that is left is 9 mm.
  const LONGEST_OK = 12;

  it.each(cases)("$name", async (c) => {
    const d = await design(c.spec);
    const cap = d.parts.find((p) => p.role === "topCap")!;
    const core = d.parts.find((p) => p.role === "core")!;
    expect(longestNeedle(cap.mesh, 0.02), "longest needle triangle in the cap, mm").toBeLessThan(LONGEST_OK);
    expect(longestNeedle(core.mesh, 0.02), "longest needle triangle in the core, mm").toBeLessThan(LONGEST_OK);
  });
});
