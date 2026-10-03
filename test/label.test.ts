import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { CAP_THICKNESS, DEFAULT_SPEC, design } from "../src/core";
import type { CoilMesh, CoilSpec, ShapeSpec } from "../src/core";

// Issue #12 acceptance criteria: "Label text in the UI and hash; embossed
// [engraved, see label.ts's file header for the FDM justification] on the
// top cap face in the mesh", "A fit check hides the label and emits a
// warning when the text doesn't fit the cap face", "If STEP export exists,
// the label is included in STEP too", "The part stays manifold; Playwright
// screenshot with a label". These tests exercise ONLY the public
// `design()`/`exportDesign()` interface, per the testing rules in AGENTS.md. The STEP-export case lives in test/step.test.ts instead
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

// A generously-sized cap (the flange follows the wound envelope; see
// docs/design.md, Parts and printing): 6 layers of wound wire on a small 30mm core pushes the flange (and
// thus the top cap's own annulus between bore and rim) well past the core's
// own outline, leaving plenty of room for a short label at a legible height.
const ROOMY_CAP = baseSpec();
// Close to issue #9's own two-part fixture: a bigger core but few layers,
// so the flange barely grows past the core outline -- too narrow an annulus
// for ANY legible-height label. (A thin 2.5 mm cable since issue #117, and
// one layer, cap forced on, since issue #121: the cap's chamfered cable
// clips widen the margin for a 3.8 mm cable or a second layer, and then
// this label would fit.)
const TIGHT_CAP = baseSpec({ wire: { length: 6000, diameter: 2.5, type: "flex" }, coreSize: { locked: true, dimension: "outer", value: 60 }, height: { locked: true, value: 60 }, layers: { locked: true, value: 1 }, topCap: "on" });

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
    expect(d.notices.some((n) => n.severity === "problem" && n.message.includes('"USB-C 2m"') && n.message.includes("needs a top cap"))).toBe(true);
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

  describe("labelFit: how much of the label the cap can hold", () => {
    const DEFAULT_CAP = { ...DEFAULT_SPEC, topCap: "on" as const };
    const maxChars = async (spec: CoilSpec, label: string) => (await design({ ...spec, label })).labelFit?.maxChars;

    it("is absent without a label, with a blank label, and without a top cap", async () => {
      expect((await design(DEFAULT_CAP)).labelFit).toBeUndefined();
      expect((await design({ ...DEFAULT_CAP, label: "   " })).labelFit).toBeUndefined();
      expect((await design({ ...DEFAULT_CAP, topCap: "off", label: "ABC" })).labelFit).toBeUndefined();
    });

    it("a label that fits reports fits with maxChars equal to its length", async () => {
      expect((await design({ ...DEFAULT_CAP, label: "USB-C 2m" })).labelFit).toEqual({ fits: true, maxChars: 8 });
    });

    it("on the default cap, ABCDEFGHIJK holds 9 characters and the fit warning stays", async () => {
      const d = await design({ ...DEFAULT_CAP, label: "ABCDEFGHIJK" });
      expect(d.labelFit).toEqual({ fits: false, maxChars: 9 });
      expect(d.warnings.some((w) => w.toLowerCase().includes("doesn't fit"))).toBe(true);
      // The prefix it names really fits, and one more character does not.
      expect((await design({ ...DEFAULT_CAP, label: "ABCDEFGHI" })).labelFit?.fits).toBe(true);
      expect((await design({ ...DEFAULT_CAP, label: "ABCDEFGHIJ" })).labelFit?.fits).toBe(false);
    });

    it("a roomier cap holds at least 11 characters", async () => {
      const d = await design({ ...ROOMY_CAP, label: "ABCDEFGHIJK" });
      expect(d.labelFit).toEqual({ fits: true, maxChars: 11 });
    });

    it("counts a leading space in the raw text it measures", async () => {
      expect(await maxChars(DEFAULT_CAP, " ABCDEFGHIJK")).toBe(10);
    });

    it("never shrinks as the cap grows (more layers, then a bigger core)", async () => {
      const long = "ABCDEFGHIJKLMNOP";
      const byLayers: number[] = [];
      for (const ly of [1, 2, 3, 4, 6]) byLayers.push((await maxChars({ ...DEFAULT_CAP, layers: { locked: true, value: ly } }, long))!);
      const byCore: number[] = [];
      for (const size of [40, 50, 60, 80, 120]) byCore.push((await maxChars({ ...DEFAULT_CAP, coreSize: { locked: true, dimension: "outer", value: size } }, long))!);
      for (const series of [byLayers, byCore]) {
        for (let i = 1; i < series.length; i++) expect(series[i], series.join(",")).toBeGreaterThanOrEqual(series[i - 1]);
      }
    });
  });
});

// Issue #176: the cap prints room face down, so each engraved letter is a
// pocket open to the bed and its floor prints as a bridge over it. The
// bridge rule (AGENTS.md: no large bridges) allows about 2 mm, measured
// like issue #128's bridges as 2 * area / perimeter of each floor patch.
describe("label letter floors bridge at most 2 mm (issue #176)", () => {
  const BRIDGE_MAX_SPAN = 2; // mm

  /** Width (2 * area / perimeter) of each letter floor: the cap's flat, up-facing faces strictly inside the plate, as connected patches. */
  function letterFloorWidths(d: Awaited<ReturnType<typeof design>>): number[] {
    const { positions: p, indices: tris }: CoilMesh = capMesh(d);
    const zLo = d.solution.height + 0.01;
    const zHi = d.solution.height + CAP_THICKNESS - 0.01;
    const ids = new Map<string, number>();
    const weld = (v: number) => {
      const key = `${Math.round(p[v * 3] * 1e4)},${Math.round(p[v * 3 + 1] * 1e4)},${Math.round(p[v * 3 + 2] * 1e4)}`;
      let id = ids.get(key);
      if (id === undefined) ids.set(key, (id = ids.size));
      return id;
    };
    const floor: number[] = [];
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b, c] = [tris[t] * 3, tris[t + 1] * 3, tris[t + 2] * 3];
      if (![a, b, c].every((v) => p[v + 2] > zLo && p[v + 2] < zHi)) continue;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nz = ux * vy - uy * vx;
      const len = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, nz);
      if (len > 1e-6 && nz / len > 0.999) floor.push(t);
    }
    // Connected patches (sharing an edge), and each edge's use count within the floor.
    const edgeKey = (u: number, v: number) => (u < v ? `${u}:${v}` : `${v}:${u}`);
    const edgeTris = new Map<string, number[]>();
    for (const t of floor) {
      for (let k = 0; k < 3; k++) {
        const key = edgeKey(weld(tris[t + k]), weld(tris[t + ((k + 1) % 3)]));
        edgeTris.set(key, [...(edgeTris.get(key) ?? []), t]);
      }
    }
    const parent = new Map(floor.map((t) => [t, t]));
    const find = (x: number): number => (parent.get(x) === x ? x : find(parent.get(x)!));
    for (const list of edgeTris.values()) for (const t of list.slice(1)) parent.set(find(t), find(list[0]));
    const area = new Map<number, number>();
    const perimeter = new Map<number, number>();
    for (const t of floor) {
      const r = find(t);
      const [a, b, c] = [tris[t] * 3, tris[t + 1] * 3, tris[t + 2] * 3];
      area.set(r, (area.get(r) ?? 0) + Math.abs((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a])) / 2);
      for (let k = 0; k < 3; k++) {
        const [i0, i1] = [tris[t + k], tris[t + ((k + 1) % 3)]];
        if (edgeTris.get(edgeKey(weld(i0), weld(i1)))!.length !== 1) continue;
        perimeter.set(r, (perimeter.get(r) ?? 0) + Math.hypot(p[i0 * 3] - p[i1 * 3], p[i0 * 3 + 1] - p[i1 * 3 + 1]));
      }
    }
    return [...area.keys()].map((r) => (2 * area.get(r)!) / perimeter.get(r)!);
  }

  const DEFAULT_CAP = { ...DEFAULT_SPEC, topCap: "on" as const };
  const SMALL_CAP = baseSpec({ coreSize: { locked: true, dimension: "outer", value: 40 }, height: { locked: true, value: 40 }, layers: { locked: true, value: 2 }, wire: { length: 3000, diameter: 2.5, type: "usb" } });
  const LARGE_CAP = baseSpec({ coreSize: { locked: true, dimension: "outer", value: 90 }, height: { locked: true, value: 60 }, layers: { locked: true, value: 2 }, wire: { length: 5000, diameter: 5, type: "usb" } });

  it("an unlabelled cap has no faces in the floor band (the measure only sees letter floors)", async () => {
    expect(letterFloorWidths(await design(LARGE_CAP))).toEqual([]);
  });

  const CASES: Array<{ cap: string; spec: CoilSpec; label: string }> = [
    { cap: "90 mm", spec: LARGE_CAP, label: "HDMI 3m" },
    { cap: "90 mm", spec: LARGE_CAP, label: "LAN" },
    { cap: "90 mm", spec: LARGE_CAP, label: "Ethernet 5m" },
    { cap: "90 mm", spec: LARGE_CAP, label: "aux" },
    { cap: "90 mm", spec: LARGE_CAP, label: "-" },
    { cap: "default", spec: DEFAULT_CAP, label: "TV" },
    { cap: "default", spec: DEFAULT_CAP, label: "USB-C 2m" },
    { cap: "small", spec: SMALL_CAP, label: "AB" },
    { cap: "small", spec: SMALL_CAP, label: "HDMI" },
  ];
  it.each(CASES)("$cap cap, label $label", async ({ spec, label }) => {
    const d = await design({ ...spec, label });
    expect(d.labelFit?.fits).toBe(true);
    const widths = letterFloorWidths(d);
    expect(widths.length).toBeGreaterThan(0);
    expect(Math.max(...widths)).toBeLessThanOrEqual(BRIDGE_MAX_SPAN);
  });

  it("the stroke cap leaves how much text fits unchanged (labelFit.maxChars)", async () => {
    const maxChars = async (spec: CoilSpec, label: string) => (await design({ ...spec, label })).labelFit?.maxChars;
    expect(await maxChars(DEFAULT_CAP, "ABCDEFGHIJKLMNOPQRSTU")).toBe(9);
    expect(await maxChars(DEFAULT_CAP, "abcdefghijklmnopqrstuvwxyz")).toBe(15);
    // Issue #241: this two-layer cap now covers the outer end's climb outside the second layer instead of the clips.
    expect(await maxChars(LARGE_CAP, "ABCDEFGHIJKLMNOPQRSTU")).toBe(13);
    expect(await maxChars(LARGE_CAP, "abcdefghijklmnopqrstuvwxyz")).toBe(22);
    expect(await maxChars(SMALL_CAP, "ABCDEFGHIJKLMNOPQRSTU")).toBe(5);
  });
});

// Issue #176: the viewer draws the label's outline with a finer line, from the
// pocket faces the top cap mesh marks. They must be exactly the pocket's walls
// and floors: every face below the room face and within the engraving depth.
describe("the top cap marks its label pocket faces (labelTriangles)", () => {
  it("absent without a label", async () => {
    expect(capMesh(await design(ROOMY_CAP)).labelTriangles).toBeUndefined();
  });

  it("exactly the faces inside the engraving", async () => {
    const d = await design({ ...ROOMY_CAP, label: "USB-C 2m" });
    const mesh = capMesh(d);
    const top = d.solution.height + CAP_THICKNESS;
    const zOf = (t: number) => [0, 1, 2].map((k) => mesh.positions[mesh.indices[t * 3 + k] * 3 + 2] - top);
    // The engraving depth: the deepest marked vertex.
    const marked = new Set(mesh.labelTriangles);
    expect(marked.size).toBeGreaterThan(0);
    const depth = -Math.min(...[...marked].flatMap(zOf));
    expect(depth).toBeGreaterThan(0.1);
    expect(depth).toBeLessThan(CAP_THICKNESS);
    // The cap mesh also has vertices in that height band on its outer wall (it
    // cuts every edge short), so only the engraving's own area counts.
    const xy = [...marked].flatMap((t) => [0, 1, 2].map((k) => [mesh.positions[mesh.indices[t * 3 + k] * 3], mesh.positions[mesh.indices[t * 3 + k] * 3 + 1]]));
    const [x0, x1] = [Math.min(...xy.map((p) => p[0])) - 0.5, Math.max(...xy.map((p) => p[0])) + 0.5];
    const [y0, y1] = [Math.min(...xy.map((p) => p[1])) - 0.5, Math.max(...xy.map((p) => p[1])) + 0.5];
    const inArea = (t: number) => [0, 1, 2].every((k) => {
      const v = mesh.indices[t * 3 + k] * 3;
      return mesh.positions[v] >= x0 && mesh.positions[v] <= x1 && mesh.positions[v + 1] >= y0 && mesh.positions[v + 1] <= y1;
    });
    for (let t = 0; t < mesh.indices.length / 3; t++) {
      const z = zOf(t);
      const inPocket = inArea(t) && z.every((v) => v > -depth - 1e-4 && v < 1e-4) && !z.every((v) => v > -1e-4);
      expect(marked.has(t), `triangle ${t} at z ${z.map((v) => v.toFixed(3)).join(", ")}`).toBe(inPocket);
    }
  });
});
