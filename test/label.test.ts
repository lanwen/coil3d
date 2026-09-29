import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec, ShapeSpec } from "../src/core";

// Issue #12 acceptance criteria: "Label text in the UI and hash; embossed
// [engraved, see label.ts's file header for the FDM justification] on the
// top cap face in the mesh", "A fit check hides the label and emits a
// warning when the text doesn't fit the cap face", "If STEP export exists,
// the label is included in STEP too", "The part stays manifold; Playwright
// screenshot with a label". These tests exercise ONLY the public
// `design()`/`exportDesign()` interface, per the testing decisions in
// docs/research.md. The STEP-export case lives in test/step.test.ts instead
// (issue #32: every OCCT/STEP test is grouped there, sequential, with a
// generous timeout) -- see "roomySpec" there, which mirrors this file's
// own ROOMY_CAP.

function baseSpec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 6000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 30 },
    height: { locked: true, value: 60 },
    layers: { locked: true, value: 6 },
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

// A generously-sized cap (see docs/research.md's flange-follows-envelope
// note): 6 layers of wound wire on a small 30mm core pushes the flange (and
// thus the top cap's own annulus between bore and rim) well past the core's
// own outline, leaving plenty of room for a short label at a legible height.
const ROOMY_CAP = baseSpec();
// The same footprint as issue #9's own two-part fixture: a bigger core but
// only 2 layers, so the flange barely grows past the core outline -- too
// narrow an annulus for ANY legible-height label. (A thin 2.5 mm cable since
// issue #117: the cap's cable clip widens the margin for a 3.8 mm one, and
// then this label would fit.)
const TIGHT_CAP = baseSpec({ wire: { length: 6000, diameter: 2.5, type: "flex" }, coreSize: { locked: true, dimension: "outer", value: 60 }, height: { locked: true, value: 60 }, layers: { locked: true, value: 2 } });

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

function capMesh(d: Awaited<ReturnType<typeof design>>) {
  return d.parts.find((p) => p.role === "topCap")!.mesh;
}

describe("top cap label (issue #12)", () => {
  it("no label set: identical cap mesh whether the field is undefined or an empty/whitespace string", async () => {
    const [a, b, c] = await Promise.all([design(ROOMY_CAP), design({ ...ROOMY_CAP, label: "" }), design({ ...ROOMY_CAP, label: "   " })]);
    expect(a.warnings.some((w) => w.toLowerCase().includes("label"))).toBe(false);
    expect(capMesh(b).positions).toEqual(capMesh(a).positions);
    expect(capMesh(b).indices).toEqual(capMesh(a).indices);
    expect(capMesh(c).positions).toEqual(capMesh(a).positions);
  });

  it("label set but no top cap: warns and leaves the (single) part unaffected", async () => {
    const d = await design(baseSpec({ topCap: "off", label: "USB-C 2m" }));
    expect(d.parts).toHaveLength(1);
    expect(d.warnings.some((w) => w.includes('"USB-C 2m"') && w.toLowerCase().includes("no top cap"))).toBe(true);
  });

  it("a short label that fits: engraves real material out of the cap, stays manifold, no fit warning", async () => {
    const [plain, labelled] = await Promise.all([design(ROOMY_CAP), design({ ...ROOMY_CAP, label: "USB-C 2m" })]);
    expect(labelled.warnings.some((w) => w.toLowerCase().includes("doesn't fit"))).toBe(false);
    const plainVolume = await assertManifold(capMesh(plain), "plain cap");
    const labelledVolume = await assertManifold(capMesh(labelled), "labelled cap");
    // Engraving removes material -- never adds it, never a no-op.
    expect(labelledVolume).toBeLessThan(plainVolume);
  });

  it("a label too long for the annulus: hidden (mesh identical to no label) with a warning, not a crash", async () => {
    const longText = "This label text is way too long to ever fit on this cap";
    const [plain, labelled] = await Promise.all([design(ROOMY_CAP), design({ ...ROOMY_CAP, label: longText })]);
    expect(labelled.warnings.some((w) => w.includes(longText) && w.toLowerCase().includes("doesn't fit") && w.toLowerCase().includes("hidden"))).toBe(true);
    expect(capMesh(labelled).positions).toEqual(capMesh(plain).positions);
    expect(capMesh(labelled).indices).toEqual(capMesh(plain).indices);
  });

  it("too narrow an annulus (issue #9's own two-layer fixture): even a short label is hidden with a warning", async () => {
    const d = await design({ ...TIGHT_CAP, label: "USB-C 2m" });
    expect(d.warnings.some((w) => w.includes('"USB-C 2m"') && w.toLowerCase().includes("doesn't fit"))).toBe(true);
  });

  const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 10 }, { kind: "tri", cornerRadius: 10 }];
  it.each(SHAPES)("stays a valid, watertight manifold with a label engraved, for shape=$kind", async (shape) => {
    const d = await design({ ...ROOMY_CAP, shape, label: "USB-C 2m" });
    for (const part of d.parts) {
      await assertManifold(part.mesh, `${shape.kind}/${part.name}`);
    }
  });
});
