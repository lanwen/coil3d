import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec } from "../src/core";
import { layoutMountPlate, openGridClipHalfExtents, skadisClipHalfExtents } from "../src/core/mountPlate";
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
    expect(skadis.halfUp).toBeCloseTo(6, 6);
    expect(skadis.halfSide).toBeCloseTo(3.05, 6);
    const openGrid = openGridClipHalfExtents();
    expect(openGrid.halfUp).toBeGreaterThan(0);
    expect(openGrid.halfSide).toBeGreaterThan(0);
  });

  it("staggers adjacent columns by the given amount, on the real SKÅDIS grid (issue #14 PR review round 2)", () => {
    const flangeOutline = makeOutline("round", 200, 100);
    const boreOutline = makeOutline("round", 174, 87);
    const pitch = 40;
    const stagger = 20;
    const layout = layoutMountPlate(flangeOutline, boreOutline, pitch, 3.05, 6, stagger);
    expect(layout.clips.length).toBeGreaterThan(0);

    // Group clips by their |side| (column), then compare the "up" phase
    // between the nearest column (|k|=1, staggered) and the next one out
    // (|k|=2, unstaggered relative to the centre) -- their row sets should
    // differ by exactly `stagger` mod `pitch`, not coincide.
    const bySide = new Map<number, number[]>();
    for (const c of layout.clips) {
      const side = Math.round(Math.abs(c.x) / pitch) * pitch; // nearest column, round core so axisDeg=0 (x is the pure side coordinate)
      const ups = bySide.get(side) ?? [];
      ups.push(Math.round(c.y));
      bySide.set(side, ups);
    }
    const col1 = new Set(bySide.get(pitch) ?? []); // |k|=1 (odd -> staggered)
    const col2 = new Set(bySide.get(2 * pitch) ?? []); // |k|=2 (even -> unstaggered)
    expect(col1.size).toBeGreaterThan(0);
    expect(col2.size).toBeGreaterThan(0);
    // The two columns' own row sets must NOT coincide (that would mean the
    // stagger was silently dropped)...
    const overlap = [...col1].some((u) => col2.has(u));
    expect(overlap).toBe(false);
    // ...and every row in the staggered column really does sit `stagger` mm
    // away from a row in the unstaggered column (mod pitch), not some
    // unrelated offset.
    for (const u of col1) {
      const nearestInCol2 = [...col2].some((v) => Math.abs(Math.abs(u - v) - stagger) < 1);
      expect(nearestInCol2).toBe(true);
    }
  });

  it("only the single lowest row (smallest up) is left unchamfered ('plain')", () => {
    const flangeOutline = makeOutline("sq", 200, 30);
    const boreOutline = makeOutline("sq", 174, 24);
    const layout = layoutMountPlate(flangeOutline, boreOutline, 40, 3.05, 6, 20);
    // Project back to "up" using the layout's own axisDeg (mount.ts's
    // bestAxisDeg convention -- shapes.ts's regular n-gon puts a square's
    // CORNERS on the axes, so its cheapest/flat-side axis, and thus
    // axisDeg, is generally NOT 0; test/design.test.ts's own `project`
    // helper uses this identical formula for the keyhole mount).
    const a = (layout.axisDeg! * Math.PI) / 180;
    const upVec = { x: Math.sin(a), y: Math.cos(a) };
    const upOf = (c: { x: number; y: number }) => Math.round((c.x * upVec.x + c.y * upVec.y) * 1000);

    const plainUps = new Set(layout.clips.filter((c) => c.plain).map(upOf));
    const minUp = Math.min(...layout.clips.map(upOf));
    // Every plain clip sits at the global minimum "up" (within rounding); no clip below that minimum is left chamfered.
    for (const u of plainUps) expect(u).toBe(minUp);
    expect(layout.clips.some((c) => c.plain)).toBe(true);
    expect(layout.clips.some((c) => !c.plain)).toBe(true); // this flange is tall enough for more than one row
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
    const { halfSide, halfUp } = skadisClipHalfExtents();
    const layout = layoutMountPlate(flangeOutline, d.flangeSpec.boreOutline, 40, halfSide, halfUp);
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
