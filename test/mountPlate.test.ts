import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec } from "../src/core";
import { layoutMountPlate, mountPlateLayoutFor, openGridClipHalfExtents, skadisClipHalfExtents } from "../src/core/mountPlate";
import { bestAxisDeg } from "../src/core/mount";
import { makeOutline, offsetOutline } from "../src/core/shapes";

// Issue #14 acceptance criteria: mount=skadis|opengrid produce a separate
// "mount plate" part that glues or snaps onto the bottom flange's wall face,
// fits inside the flange outline, respects the hanging axis, warns when the
// flange is too small for at least 2 clips, and stays manifold in every
// export. These tests exercise ONLY the public `design()` interface plus
// mountPlate.ts's own layout function (the same shared function both
// geometry backends cut from -- mirrors test/design.test.ts's own treatment
// of mount.ts's `layoutKeyholeMount`), per docs/research.md's testing
// decisions.

function baseSpec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 2000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 100 },
    height: { locked: true, value: 60 },
    layers: { locked: true, value: 1 },
    objective: "minVolume",
    topCap: "auto",
    joint: "press",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    mount: "none",
    plateJoint: "glue",
    ...overrides,
  };
}

async function volumeCheck(mesh: { positions: Float32Array; indices: Uint32Array }, label: string) {
  const wasm = await Module();
  wasm.setup();
  const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
  const status = m.status();
  const pieces = m.decompose();
  const pieceCount = pieces.length;
  for (const p of pieces) p.delete();
  const volume = m.volume();
  m.delete();
  expect(status, `${label}: manifold status`).toBe("NoError");
  // Every part must be genuinely ONE connected solid, not a valid-looking
  // compound with a disconnected "ghost" fragment left over from an
  // un-embedded boolean seam (issue #14 PR: caught by decompose(), not by
  // status()/genus() alone -- see constants.ts's MOUNT_PLATE_EMBED).
  expect(pieceCount, `${label}: connected components`).toBe(1);
  expect(volume, `${label}: volume`).toBeGreaterThan(0);
  return volume;
}

describe("mountPlate.ts layout math (issue #14)", () => {
  it("the plate's own outline always fits strictly inside the flange's outline", () => {
    const flangeOutline = makeOutline("round", 120, 60);
    const boreOutline = makeOutline("round", 94, 47);
    const layout = layoutMountPlate(flangeOutline, boreOutline, 40, 6, 3.05);
    expect(layout.outline.apothem).toBeLessThan(flangeOutline.apothem);
    expect(layout.clips.length).toBeGreaterThan(0);
  });

  it("warns and produces no clips when the flange is too small for at least 2", () => {
    const flangeOutline = makeOutline("round", 20, 10);
    const boreOutline = makeOutline("round", 14, 7);
    const layout = layoutMountPlate(flangeOutline, boreOutline, 40, 6, 3.05);
    expect(layout.clips).toHaveLength(0);
    expect(layout.warning).toMatch(/too small/i);
  });

  it("places clip columns symmetric about the shape's own best axis (round)", () => {
    const flangeOutline = makeOutline("round", 120, 60);
    const boreOutline = makeOutline("round", 94, 47);
    const layout = layoutMountPlate(flangeOutline, boreOutline, 40, 6, 3.05);
    expect(layout.axisDeg).toBe(0);
    // Round: axisDeg=0 means "up" is literal +Y, so every clip's x is a pure "side" coordinate, symmetric about x=0.
    const xs = layout.clips.map((c) => c.x).sort((a, b) => a - b);
    for (let i = 0; i < xs.length / 2; i++) {
      expect(xs[i]).toBeCloseTo(-xs[xs.length - 1 - i], 6);
    }
  });

  it("uses the shape's own bestAxisDeg for a triangle, matching mount.ts's keyhole convention", () => {
    const outer = makeOutline("tri", 120, 30);
    const boreOutline = makeOutline("tri", 94, 24);
    const layout = layoutMountPlate(outer, boreOutline, 40, 6, 3.05);
    expect(layout.axisDeg).toBeCloseTo(bestAxisDeg(boreOutline, 0), 9);
  });

  it("skadis/openGrid half-extents come from the actual geometry data, not a hand-maintained duplicate", () => {
    const skadis = skadisClipHalfExtents();
    expect(skadis.halfUp).toBeCloseTo(5.5, 6);
    expect(skadis.halfSide).toBeCloseTo(2.9, 6);
    const openGrid = openGridClipHalfExtents();
    expect(openGrid.halfUp).toBeGreaterThan(0);
    expect(openGrid.halfSide).toBeGreaterThan(0);
  });

  it("SKÅDIS columns sit half a pitch off-centre, so a 100 mm core still gets 2 clips 40 mm apart (issue #106)", () => {
    const layout = mountPlateLayoutFor("skadis", makeOutline("round", 60, 30), makeOutline("round", 40, 20));
    const xs = [...new Set(layout.clips.map((c) => Math.round(c.x * 1000) / 1000))].sort((a, b) => a - b);
    expect(xs).toEqual([-20, 20]);
  });
});

describe("design() clip mount plate (issue #14)", () => {
  it("defaults to no mount plate part for mount=none/keyhole", async () => {
    const none = await design(baseSpec());
    expect(none.parts.map((p) => p.role)).not.toContain("mountPlate");
    const keyhole = await design(baseSpec({ mount: "keyhole" }));
    expect(keyhole.parts.map((p) => p.role)).not.toContain("mountPlate");
  });

  it("adds a separate, named mount-plate part for mount=skadis", async () => {
    const d = await design(baseSpec({ mount: "skadis" }));
    const plate = d.parts.find((p) => p.role === "mountPlate");
    expect(plate).toBeDefined();
    expect(plate!.name).toBe("mount-plate");
    // Issue #43: at this default 3.8mm cable diameter, the flange's own
    // channel-depth-driven baseline thickness (design.ts) already clears
    // the plate's own anchor-hole minimum (MIN_FLANGE_THICKNESS_FOR_GLUE_PLATE,
    // 3.9mm < the ~5.3mm baseline), so the plate no longer has to bump
    // thickness -- or warn -- on top of it. See the next test for a thin
    // enough cable that the plate's own minimum still bites.
    expect(d.warnings.some((w) => /flange thickness increased/i.test(w))).toBe(false);
  });

  it("still bumps the flange thickness (and warns) for a thin cable whose channel-depth baseline alone wouldn't clear the plate's own anchor-hole minimum", async () => {
    const thinWire = { length: 500, diameter: 0.5, type: "usb" as const };
    const none = await design(baseSpec({ mount: "none", wire: thinWire }));
    const skadis = await design(baseSpec({ mount: "skadis", wire: thinWire }));
    expect(skadis.flangeSpec.thickness).toBeGreaterThan(none.flangeSpec.thickness);
    expect(skadis.warnings.some((w) => /flange thickness increased/i.test(w))).toBe(true);
  });

  it("an old snap-joint link still builds, as the printable pin + glue joint, with a warning (issue #106)", async () => {
    const snap = await design(baseSpec({ mount: "skadis", plateJoint: "snap" }));
    const glue = await design(baseSpec({ mount: "skadis", plateJoint: "glue" }));
    expect(snap.warnings.some((w) => /snap tabs can't print without supports/i.test(w))).toBe(true);
    expect(glue.warnings.some((w) => /snap tabs/i.test(w))).toBe(false);
    const plateOf = (d: typeof snap) => d.parts.find((p) => p.role === "mountPlate")!.mesh.positions;
    expect(plateOf(snap)).toEqual(plateOf(glue));
  });

  it("adds a mount-plate part for mount=opengrid too (placeholder connector geometry -- see constants.ts's TODO)", async () => {
    const d = await design(baseSpec({ mount: "opengrid" }));
    expect(d.parts.find((p) => p.role === "mountPlate")).toBeDefined();
  });

  it("warns and skips the plate (no mountPlate part) when the flange is too small for at least 2 clips", async () => {
    const d = await design(baseSpec({ mount: "skadis", coreSize: { locked: true, dimension: "outer", value: 12 }, height: { locked: true, value: 20 } }));
    expect(d.parts.find((p) => p.role === "mountPlate")).toBeUndefined();
    expect(d.warnings.some((w) => /too small to fit at least 2 clips/i.test(w))).toBe(true);
  });

  it("mountAxisDeg is surfaced for the clip mount plate too, matching mountPlate.ts's own layout.axisDeg", async () => {
    const d = await design(baseSpec({ mount: "skadis", shape: { kind: "tri", cornerRadius: 15 } }));
    expect(d.mountAxisDeg).not.toBeUndefined();
    const flangeOutline = offsetOutline(d.flangeSpec.outline, d.flangeSpec.margin);
    const layout = mountPlateLayoutFor("skadis", flangeOutline, d.flangeSpec.boreOutline);
    expect(d.mountAxisDeg).toBeCloseTo(layout.axisDeg!, 9);
  });

  it.each([
    { label: "skadis glue, round", mount: "skadis" as const, plateJoint: "glue" as const, shape: { kind: "round" } as const },
    { label: "skadis snap, round", mount: "skadis" as const, plateJoint: "snap" as const, shape: { kind: "round" } as const },
    { label: "skadis glue, sq", mount: "skadis" as const, plateJoint: "glue" as const, shape: { kind: "sq", cornerRadius: 15 } as const },
    { label: "skadis glue, tri", mount: "skadis" as const, plateJoint: "glue" as const, shape: { kind: "tri", cornerRadius: 15 } as const },
    { label: "opengrid glue, round", mount: "opengrid" as const, plateJoint: "glue" as const, shape: { kind: "round" } as const },
    { label: "opengrid snap, round", mount: "opengrid" as const, plateJoint: "snap" as const, shape: { kind: "round" } as const },
  ])("$label: every part (core + mount-plate) is a single valid, watertight manifold", async ({ mount, plateJoint, shape }) => {
    const d = await design(baseSpec({ mount, plateJoint, shape }));
    expect(d.parts.map((p) => p.role)).toContain("mountPlate");
    for (const part of d.parts) {
      await volumeCheck(part.mesh, `${mount}/${plateJoint}/${shape.kind} ${part.name}`);
    }
  });

  it("keeps the core part's own genus at 1 (still a single tunnel through the solid) even with the plate's alignment cut", async () => {
    const d = await design(baseSpec({ mount: "skadis" }));
    const wasm = await Module();
    wasm.setup();
    const core = d.parts.find((p) => p.role === "core")!;
    const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: core.mesh.positions, triVerts: core.mesh.indices }));
    expect(m.genus()).toBe(1);
    m.delete();
  });
});
