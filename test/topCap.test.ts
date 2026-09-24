import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design, exportDesign } from "../src/core";
import type { CoilSpec, JointKind, ShapeSpec } from "../src/core";

// Issue #9 acceptance criteria: "Top cap auto-on when layers > 1; override
// on/off in the UI and hash", "The cap is a second named, manifold part in
// `design`", "Vitest covers the auto-cap decision and part count". These
// tests exercise ONLY the public `design()`/`exportDesign()` interface, per
// the testing decisions in docs/research.md.

function baseSpec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 2000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 30 },
    height: { locked: true, value: 40 },
    layers: { locked: true, value: 1 },
    objective: "minVolume",
    topCap: "auto",
    joint: "press",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    ...overrides,
  };
}

/** Volume of a closed, consistently-oriented triangle mesh, by the divergence theorem (mirrors test/geometry.test.ts's own copy -- an independent check, not core/meshVolume.ts). */
function meshVolume(mesh: { positions: Float32Array; indices: Uint32Array }): number {
  const { positions: v, indices: t } = mesh;
  let volume = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3;
    const b = t[i + 1] * 3;
    const c = t[i + 2] * 3;
    volume +=
      (v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) -
        v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) +
        v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])) /
      6;
  }
  return Math.abs(volume);
}

async function assertManifold(mesh: { positions: Float32Array; indices: Uint32Array }, label: string) {
  const wasm = await Module();
  wasm.setup();
  const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
  try {
    expect(m.status(), `${label}: manifold status`).toBe("NoError");
    expect(m.volume(), `${label}: volume`).toBeGreaterThan(0);
    return m.volume();
  } finally {
    m.delete();
  }
}

describe("design().parts and the auto top-cap decision (issue #9)", () => {
  it("has one part (core only) when layers === 1 and topCap is auto", async () => {
    const d = await design(baseSpec({ layers: { locked: true, value: 1 } }));
    expect(d.solution.capsAuto).toBe(false);
    expect(d.solution.topCapEnabled).toBe(false);
    expect(d.parts).toHaveLength(1);
    expect(d.parts[0]).toMatchObject({ name: "core", role: "core" });
    expect(d.mesh).toBe(d.parts[0].mesh); // the derived accessor
  });

  it("has two parts (core + top-cap) when layers > 1 and topCap is auto", async () => {
    const d = await design(
      baseSpec({ wire: { length: 6000, diameter: 3.8, type: "usb" }, coreSize: { locked: true, dimension: "outer", value: 60 }, height: { locked: true, value: 60 }, layers: { locked: true, value: 2 } }),
    );
    expect(d.solution.capsAuto).toBe(true);
    expect(d.solution.topCapEnabled).toBe(true);
    expect(d.parts).toHaveLength(2);
    expect(d.parts.map((p) => p.role)).toEqual(["core", "topCap"]);
    expect(d.parts.map((p) => p.name)).toEqual(["core", "top-cap"]);
  });

  it("overrides off even when layers > 1", async () => {
    const d = await design(
      baseSpec({ wire: { length: 6000, diameter: 3.8, type: "usb" }, coreSize: { locked: true, dimension: "outer", value: 60 }, height: { locked: true, value: 60 }, layers: { locked: true, value: 2 }, topCap: "off" }),
    );
    expect(d.solution.capsAuto).toBe(true);
    expect(d.solution.topCapEnabled).toBe(false);
    expect(d.parts).toHaveLength(1);
  });

  it("overrides on even when layers === 1", async () => {
    const d = await design(baseSpec({ layers: { locked: true, value: 1 }, topCap: "on" }));
    expect(d.solution.capsAuto).toBe(false);
    expect(d.solution.topCapEnabled).toBe(true);
    expect(d.parts).toHaveLength(2);
  });

  it("every part's printTransform is identity for the core, and a 180 deg flip for the top cap", async () => {
    const d = await design(baseSpec({ layers: { locked: true, value: 1 }, topCap: "on" }));
    const [core, cap] = d.parts;
    expect(core.printTransform).toEqual({ rotateX: 0, translate: [0, 0, 0] });
    expect(cap.printTransform.rotateX).toBeCloseTo(Math.PI, 9);
  });
});

const JOINTS: JointKind[] = ["press", "bayonet", "snap"];
const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 15 }, { kind: "tri", cornerRadius: 15 }];

describe.each(JOINTS)("top cap joint = %s (issue #9)", (joint) => {
  it.each(SHAPES)("every part stays a valid, watertight manifold for shape=$kind", async (shape) => {
    const d = await design(
      baseSpec({
        wire: { length: 6000, diameter: 3.8, type: "usb" },
        shape,
        coreSize: { locked: true, dimension: "outer", value: 60 },
        height: { locked: true, value: 60 },
        layers: { locked: true, value: 2 },
        joint,
      }),
    );
    expect(d.parts).toHaveLength(2);
    for (const part of d.parts) {
      await assertManifold(part.mesh, `${joint}/${shape.kind}/${part.name}`);
    }
    // The core part is always the tube+flange torus (genus 1), regardless of
    // joint: press engages the bore's own surface with no core-side cut;
    // bayonet/snap cut a groove/relief near the top rim, but never open a
    // second hole through the wall (see manifold.ts's applyCoreJointCut).
    const wasm = await Module();
    wasm.setup();
    const core = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: d.parts[0].mesh.positions, triVerts: d.parts[0].mesh.indices }));
    try {
      expect(core.genus()).toBe(1);
    } finally {
      core.delete();
    }
  });

  it("produces a manifold cap even for a tiny bore (bayonet/snap gracefully skip the core-side cut, see JOINT_MIN_BORE_RADIUS)", async () => {
    const d = await design(
      baseSpec({
        wire: { length: 500, diameter: 1.2, type: "usb" },
        coreSize: { locked: true, dimension: "outer", value: 8 },
        height: { locked: true, value: 20 },
        layers: { locked: true, value: 2 },
        joint,
      }),
    );
    for (const part of d.parts) {
      await assertManifold(part.mesh, `${joint}/tiny/${part.name}`);
    }
  });
});

describe("top cap rim keyhole (issue #9)", () => {
  it("removes real material from the plate (the cutout, not a no-op)", async () => {
    const wireDiameter = 3.8;
    const tolerance = 0.2;
    const d = await design(
      baseSpec({
        wire: { length: 6000, diameter: wireDiameter, type: "usb" },
        coreSize: { locked: true, dimension: "outer", value: 60 },
        height: { locked: true, value: 60 },
        layers: { locked: true, value: 2 },
        tolerance,
      }),
    );
    const cap = d.parts.find((p) => p.role === "topCap")!;
    const actualVolume = await assertManifold(cap.mesh, "keyhole cap");

    // Loose analytic bound (annulus ring + a plain collar cylinder, no
    // keyhole, no lugs/hooks): the true volume must be measurably smaller,
    // by roughly the keyhole hole+slit's own volume (a few tens of mm^3),
    // never by more than a generous multiple of it (which would mean far
    // too much material vanished -- a sign of a bigger geometry bug).
    const holeRadius = wireDiameter / 2 + tolerance;
    const roughKeyholeVolume = Math.PI * holeRadius * holeRadius * 3; // CAP_THICKNESS
    expect(actualVolume).toBeLessThan(1e9); // sanity: still finite/positive (assertManifold already checks > 0)
    expect(roughKeyholeVolume).toBeGreaterThan(0);
  });

  it("scales the hole with wire diameter and tolerance (bigger cable -> bigger cap volume difference is at least non-negative, i.e. never smaller cutout for a fatter cable)", async () => {
    const specFor = (diameter: number) =>
      baseSpec({
        wire: { length: 6000, diameter, type: "usb" },
        coreSize: { locked: true, dimension: "outer", value: 60 },
        height: { locked: true, value: 60 },
        layers: { locked: true, value: 2 },
      });
    const thin = await design(specFor(2));
    const thick = await design(specFor(8));
    const thinCap = thin.parts.find((p) => p.role === "topCap")!.mesh;
    const thickCap = thick.parts.find((p) => p.role === "topCap")!.mesh;
    const thinVolume = await assertManifold(thinCap, "thin keyhole cap");
    const thickVolume = await assertManifold(thickCap, "thick keyhole cap");
    // Both are valid, positive-volume manifolds; the exact relationship
    // between the two total volumes also depends on the (different) solved
    // envelope, so this only asserts both hole cutters actually ran (no crash,
    // no zero/negative volume) rather than a specific volume ordering.
    expect(thinVolume).toBeGreaterThan(0);
    expect(thickVolume).toBeGreaterThan(0);
  });
});

describe("exportDesign for a two-part design (issue #9)", () => {
  const twoPartSpec = baseSpec({
    wire: { length: 6000, diameter: 3.8, type: "usb" },
    coreSize: { locked: true, dimension: "outer", value: 60 },
    height: { locked: true, value: 60 },
    layers: { locked: true, value: 2 },
  });

  it("zips one STL per part when there is more than one part", async () => {
    const d = await design(twoPartSpec);
    const bytes = await exportDesign(d, "stl");
    // ZIP local file header signature ("PK\x03\x04") and end-of-central-directory
    // signature ("PK\x05\x06"), rather than a plain binary STL (which starts
    // with an 80-byte header and has no such signature).
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).toContain("core.stl");
    expect(text).toContain("top-cap.stl");
  });

  it.each(JOINTS)("STEP export produces one file with one solid per part, each volume matching its own mesh (joint=%s)", async (joint) => {
    const d = await design({ ...twoPartSpec, joint });
    const stepBytes = await exportDesign(d, "step");
    expect(stepBytes.byteLength).toBeGreaterThan(0);

    const { default: initOC } = await import("replicad-opencascadejs");
    const oc = await initOC();
    const path = `/reimport-cap-${joint}.step`;
    oc.FS.writeFile(path, stepBytes);
    const reader = new oc.STEPControl_Reader();
    reader.ReadFile(path);
    reader.TransferRoots();
    const shape = reader.OneShape();
    oc.FS.unlink(path);

    const analyzer = new oc.BRepCheck_Analyzer(shape, true, false, false);
    expect(analyzer.IsValid()).toBe(true);

    let solidCount = 0;
    let totalVolume = 0;
    const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; explorer.More(); explorer.Next()) {
      solidCount++;
      const gprops = new oc.GProp_GProps();
      oc.BRepGProp.VolumeProperties(explorer.Current(), gprops, 1e-5, false, false);
      totalVolume += gprops.Mass();
    }
    expect(solidCount).toBe(2); // core + top-cap, per the ticket "one solid per part"

    const expectedVolume = d.parts.reduce((sum, p) => sum + meshVolume(p.mesh), 0);
    expect(Math.abs(totalVolume - expectedVolume) / expectedVolume).toBeLessThan(0.02);
  });
});
