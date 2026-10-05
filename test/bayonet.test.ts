import Module from "manifold-3d";
import type { ManifoldToplevel } from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilMesh, CoilSpec, Design, ShapeSpec } from "../src/core";

// Issue #167's twist lock needs the whole collar to turn about the bore. The cable's inner end now stands in the
// bore on a rib (issue #254, centre-held ends), which the collar would run into on its turn, so a bayonet request is
// built as the press-fit collar, with a notice, whatever the shape and size.

function spec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 6000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 60 },
    height: { locked: true, value: 60 },
    layers: { locked: true, value: 2 },
    objective: "minVolume",
    topCap: "on",
    joint: "bayonet",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    base: "on",
    mount: "none",
    plateJoint: "glue",
    ...overrides,
  };
}

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

type Manifold = InstanceType<ManifoldToplevel["Manifold"]>;
const toManifold = (mesh: CoilMesh): Manifold => new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
const volumes = (d: Design) => d.parts.map((p) => toManifold(p.mesh)).map((m) => [m.volume(), m.delete()][0] as number);

describe("a requested twist lock is built as the press-fit collar (issues #167, #254)", () => {
  it.each<{ label: string; overrides: Partial<CoilSpec> }>([
    { label: "round core", overrides: {} },
    { label: "square core", overrides: { shape: { kind: "sq", cornerRadius: 15 } as ShapeSpec } },
    { label: "triangle core", overrides: { shape: { kind: "tri", cornerRadius: 12 } as ShapeSpec, coreSize: { locked: true, dimension: "outer", value: 113 } } },
    { label: "bare core", overrides: { base: "off" } },
  ])("$label: builds exactly the press-fit parts, warns, and keeps joint=bayonet in the spec", async ({ overrides }) => {
    const [bay, press] = await Promise.all([design(spec(overrides)), design(spec({ ...overrides, joint: "press" }))]);
    expect(bay.spec.joint).toBe("bayonet");
    expect(bay.parts.map((p) => p.role)).toEqual(["core", "topCap"]);
    expect(bay.warnings.join("\n")).toMatch(/twist lock can't turn/);
    expect(press.warnings.join("\n")).not.toMatch(/twist lock/i);
    expect(volumes(bay)).toEqual(volumes(press));
  });

  it("says nothing about the twist lock when there is no top cap", async () => {
    const d = await design(spec({ shape: { kind: "sq", cornerRadius: 15 }, topCap: "off" }));
    expect(d.warnings.join("\n")).not.toMatch(/twist lock/i);
  });
});

describe("every part of a bayonet request is one solid at any core size (issue #201)", () => {
  const sizes = [28.31, 28.37, 28.88, 34.5, 36, 40.25];

  it.each(sizes)("outer size %f mm", async (size) => {
    const d = await design(spec({ coreSize: { locked: true, dimension: "outer", value: size }, height: { locked: true, value: 60 } }));
    for (const part of d.parts) {
      const m = toManifold(part.mesh);
      try {
        expect(m.status(), part.role).toBe("NoError");
        const pieces = m.decompose();
        expect(pieces.length, `${part.role}: one connected solid`).toBe(1);
        pieces.forEach((p) => p.delete());
      } finally {
        m.delete();
      }
    }
  });
});
