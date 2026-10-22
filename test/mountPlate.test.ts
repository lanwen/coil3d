import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec, ShapeSpec } from "../src/core";
import { pegHoleRadius } from "./support/mountPlate";

// Issue #14 acceptance criteria: mount=opengrid (the hidden placeholder; the
// SKÅDIS mount used the same plate until issue #207) produces a separate
// "mount plate" part that glues or snaps onto the bottom flange's wall face,
// fits inside the flange outline, respects the hanging axis, warns when the
// flange is too small for at least 2 clips, and stays manifold in every
// export. These tests exercise ONLY the public `design()` interface (the layout both
// geometry backends cut from, read from design().mountLayout), per the
// testing rules in AGENTS.md.

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

describe("the mount plate's layout through design() (issues #14, #115)", () => {
  it("the plate's own outline always fits strictly inside the flange's outline", async () => {
    const d = await design(baseSpec({ mount: "opengrid", coreSize: { locked: true, dimension: "outer", value: 100 } }));
    const plate = d.mountLayout!.plate!;
    expect(plate.outline.apothem).toBeLessThan(d.flangeSpec.outline.apothem + d.flangeSpec.margin);
    expect(plate.clips.length).toBeGreaterThan(0);
  });

  it("places clip columns symmetric about the shape's own best axis (round)", async () => {
    const d = await design(baseSpec({ mount: "opengrid" }));
    const plate = d.mountLayout!.plate!;
    expect(plate.axisDeg).toBe(0);
    // Round: axisDeg=0 means "up" is literal +Y, so every clip's x is a pure "side" coordinate, symmetric about x=0.
    const xs = plate.clips.map((c) => c.x).sort((a, b) => a - b);
    for (let i = 0; i < xs.length / 2; i++) {
      expect(xs[i]).toBeCloseTo(-xs[xs.length - 1 - i], 6);
    }
  });

  it("uses the shape's own best axis for a triangle, the same one the keyhole mount hangs on", async () => {
    const shape: ShapeSpec = { kind: "tri", cornerRadius: 15 };
    const plate = await design(baseSpec({ mount: "opengrid", shape }));
    const keyhole = await design(baseSpec({ mount: "keyhole", shape }));
    expect(plate.mountLayout!.plate!.axisDeg).toBeCloseTo(keyhole.mountAxisDeg!, 9);
  });

  // The pin hole's reach: a hole whose edge touched the cable's bore would tunnel into the channel. Issue #115: the
  // pre-fix edge-distance check let a pin position inside the channel through (a stiff 8 mm cable on a big square core).
  it.each([
    { shape: { kind: "round" } as ShapeSpec, size: 60 },
    { shape: { kind: "sq", cornerRadius: 15 } as ShapeSpec, size: 60 },
    { shape: { kind: "sq", cornerRadius: 15 } as ShapeSpec, size: 140 },
    { shape: { kind: "tri", cornerRadius: 15 } as ShapeSpec, size: 80 },
    { shape: { kind: "tri", cornerRadius: 15 } as ShapeSpec, size: 140 },
  ])("never puts a pin hole in the inner-end channel: $shape.kind core, $size mm", async ({ shape, size }) => {
    for (const wire of [
      { length: 2000, diameter: 3.8, type: "usb" as const },
      { length: 2000, diameter: 8, type: "stiff" as const },
    ]) {
      const d = await design(baseSpec({ shape, wire, topCap: "off", base: "on", mount: "opengrid", coreSize: { locked: true, dimension: "outer", value: size } }), "draft");
      const anchors = d.mountLayout!.plate!.anchors;
      expect(anchors.length).toBe(2);
      const lead = d.innerEndLeadIn;
      const reach = (wire.diameter + d.spec.tolerance) / 2 + pegHoleRadius(d.spec.tolerance);
      for (const a of anchors) {
        for (let i = 0; i < lead.length; i += 3) {
          if (lead[i + 2] >= 0) continue;
          expect(Math.hypot(a.x - lead[i], a.y - lead[i + 1]), `${wire.diameter} mm cable`).toBeGreaterThanOrEqual(reach);
        }
      }
    }
  });
});

describe("design() clip mount plate (issue #14)", () => {
  it("defaults to no mount plate part for mount=none/keyhole", async () => {
    const none = await design(baseSpec());
    expect(none.parts.map((p) => p.role)).not.toContain("mountPlate");
    const keyhole = await design(baseSpec({ mount: "keyhole" }));
    expect(keyhole.parts.map((p) => p.role)).not.toContain("mountPlate");
  });

  it("adds a separate, named mount-plate part for mount=opengrid", async () => {
    const d = await design(baseSpec({ mount: "opengrid" }));
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
    const skadis = await design(baseSpec({ mount: "opengrid", wire: thinWire }));
    expect(skadis.flangeSpec.thickness).toBeGreaterThan(none.flangeSpec.thickness);
    expect(skadis.warnings.some((w) => /flange thickness increased/i.test(w))).toBe(true);
  });

  it("a snap plate joint still builds, as the printable pin + glue joint, with a warning (issue #106)", async () => {
    const snap = await design(baseSpec({ mount: "opengrid", plateJoint: "snap" }));
    const glue = await design(baseSpec({ mount: "opengrid", plateJoint: "glue" }));
    expect(snap.warnings.some((w) => /snap tabs can't print without supports/i.test(w))).toBe(true);
    expect(glue.warnings.some((w) => /snap tabs/i.test(w))).toBe(false);
    const plateOf = (d: typeof snap) => d.parts.find((p) => p.role === "mountPlate")!.mesh.positions;
    expect(plateOf(snap)).toEqual(plateOf(glue));
  });

  it("mount=skadis builds rim clips, not a plate (issue #207)", async () => {
    const d = await design(baseSpec({ mount: "skadis" }));
    expect(d.parts.find((p) => p.role === "mountPlate")).toBeUndefined();
    expect(d.parts.filter((p) => p.role === "mountClip").length).toBe(3);
  });

  // Issue #120: `requiredMountPlateMargin` (mountPlate.ts) grows the flange
  // margin to fit at least 2 clips, exactly like `requiredFlangeMargin`
  // already does for the keyhole mount (e2e/mount.spec.ts's "a tiny, sharp
  // core still fits the mount by growing the flange ... never a silent
  // skip") -- a tiny, LOCKED core used to skip the plate entirely (this
  // test's own pre-fix name/assertions); now it gets a flange grown just
  // wide enough instead.
  it("still fits the plate (no silent skip) on a tiny, locked core by growing the flange margin, warned about", async () => {
    // A thin 1.5 mm cable, so the round core's bend-limit floor (issue #195) stays under 12 mm.
    const tiny: Partial<CoilSpec> = { wire: { length: 2000, diameter: 1.5, type: "usb" }, coreSize: { locked: true, dimension: "outer", value: 12 }, height: { locked: true, value: 20 } };
    const none = await design(baseSpec({ ...tiny, mount: "none" }));
    const d = await design(baseSpec({ ...tiny, mount: "opengrid" }));
    expect(d.flangeSpec.margin).toBeGreaterThan(none.flangeSpec.margin);
    expect(d.warnings.some((w) => /margin increased.*openGrid/i.test(w))).toBe(true);
    expect(d.warnings.some((w) => /too small to fit/i.test(w))).toBe(false);
    const plate = d.parts.find((p) => p.role === "mountPlate");
    expect(plate).toBeDefined();
    expect(d.mountLayout!.plate!.clips.length).toBeGreaterThanOrEqual(2);
  });

  it("mountAxisDeg is surfaced for the clip mount plate too, matching mountPlate.ts's own layout.axisDeg", async () => {
    const d = await design(baseSpec({ mount: "opengrid", shape: { kind: "tri", cornerRadius: 15 } }));
    expect(d.mountAxisDeg).not.toBeUndefined();
    expect(d.mountAxisDeg).toBeCloseTo(d.mountLayout!.plate!.axisDeg!, 9);
  });

  it.each([
    { label: "opengrid glue, sq", mount: "opengrid" as const, plateJoint: "glue" as const, shape: { kind: "sq", cornerRadius: 15 } as const },
    { label: "opengrid glue, tri", mount: "opengrid" as const, plateJoint: "glue" as const, shape: { kind: "tri", cornerRadius: 15 } as const },
    { label: "opengrid glue, round", mount: "opengrid" as const, plateJoint: "glue" as const, shape: { kind: "round" } as const },
    { label: "opengrid snap, round", mount: "opengrid" as const, plateJoint: "snap" as const, shape: { kind: "round" } as const },
  ])("$label: every part (core + mount-plate) is a single valid, watertight manifold", async ({ mount, plateJoint, shape }) => {
    const d = await design(baseSpec({ mount, plateJoint, shape }));
    expect(d.parts.map((p) => p.role)).toContain("mountPlate");
    for (const part of d.parts) {
      await volumeCheck(part.mesh, `${mount}/${plateJoint}/${shape.kind} ${part.name}`);
    }
  });

  it.each(["opengrid", "skadis"] as const)("keeps the core part's own genus at 1 (still a single tunnel through the solid) with the %s mount's cuts", async (mount) => {
    const d = await design(baseSpec({ mount }));
    const wasm = await Module();
    wasm.setup();
    const core = d.parts.find((p) => p.role === "core")!;
    const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: core.mesh.positions, triVerts: core.mesh.indices }));
    expect(m.genus()).toBe(1);
    expect(m.decompose().length).toBe(1);
    m.delete();
  });
});
