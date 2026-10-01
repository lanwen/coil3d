import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilMesh, CoilSpec, JointKind, ShapeSpec } from "../src/core";

// Issue #172: the seated top cap sits on the core's rim and doesn't run into
// it, for every joint and shape. Both parts' meshes share the assembly frame,
// so the cap as drawn is the cap seated: their faces may touch, but nothing
// may overlap.

function spec(overrides: Partial<CoilSpec>): CoilSpec {
  return {
    wire: { length: 4000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 60 },
    height: { locked: true, value: 50 },
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

const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 12 }, { kind: "tri", cornerRadius: 12 }];
const JOINTS: JointKind[] = ["press", "snap", "bayonet"];
const SIZES: Array<{ label: string; overrides: Partial<CoilSpec> }> = [
  { label: "40 mm", overrides: { coreSize: { locked: true, dimension: "outer", value: 40 }, height: { locked: true, value: 40 }, wire: { length: 3000, diameter: 2.5, type: "usb" } } },
  { label: "60 mm", overrides: {} },
  { label: "90 mm", overrides: { coreSize: { locked: true, dimension: "outer", value: 90 }, height: { locked: true, value: 60 }, wire: { length: 5000, diameter: 5, type: "usb" } } },
];

const CASES: Array<{ name: string; spec: CoilSpec }> = [];
for (const shape of SHAPES) {
  for (const joint of JOINTS) {
    for (const size of SIZES) CASES.push({ name: `${shape.kind}, ${joint}, ${size.label}`, spec: spec({ shape, joint, ...size.overrides }) });
  }
  // A bore too small for the snap's core-side relief: the cap gets the plain press collar.
  CASES.push({
    name: `${shape.kind}, snap, tiny bore`,
    spec: spec({
      shape: shape.kind === "round" ? shape : { kind: shape.kind, cornerRadius: 6 },
      joint: "snap",
      coreSize: { locked: true, dimension: "outer", value: shape.kind === "tri" ? 14 : 10 },
      height: { locked: true, value: 20 },
      wire: { length: 500, diameter: 1.2, type: "usb" },
    }),
  });
}

type Wasm = Awaited<ReturnType<typeof Module>>;
let wasmPromise: Promise<Wasm> | undefined;
const getWasm = () =>
  (wasmPromise ??= Module().then((w) => {
    w.setup();
    return w;
  }));

async function solid(mesh: CoilMesh) {
  const wasm = await getWasm();
  return new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
}

describe("issue #172: the seated top cap does not run into the core", () => {
  it.each(CASES)("$name", async (c) => {
    const d = await design(c.spec);
    const core = await solid(d.parts.find((p) => p.role === "core")!.mesh);
    const cap = await solid(d.parts.find((p) => p.role === "topCap")!.mesh);
    const hit = core.intersect(cap);
    try {
      const { min, max } = hit.boundingBox();
      const where = hit.isEmpty() ? "" : `, z ${min[2].toFixed(2)}..${max[2].toFixed(2)} (rim at ${d.solution.height})`;
      // A little tessellation noise aside.
      expect(hit.volume(), `cap/core overlap, mm^3${where}`).toBeLessThan(0.1);
    } finally {
      for (const m of [core, cap, hit]) m.delete();
    }
  });
});
