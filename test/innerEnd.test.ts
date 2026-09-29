import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec, ShapeSpec } from "../src/core";
// innerEnd.ts's layout is the SAME shared function every backend (manifold.ts,
// step/build.ts) and the wound-cable schematic (wire.ts) cut/draw from --
// calling it here on design()'s own PUBLIC `flangeSpec`/`spec` (not a
// reimplementation) verifies the actual layout that was cut, the same
// "vitest check through design()" convention test/design.test.ts already
// uses for mount.ts's `layoutKeyholeMount`.
import { layoutInnerEnd, resolveChannelDepth } from "../src/core/innerEnd";
import { fuseFlange } from "../src/core/manifold";
import { outlineOffsetAt } from "../src/core/shapes";
import { bendMultiplierOf } from "../src/core/types";
import { buildWall } from "../src/core/wall";

// Issue #8 acceptance criteria: "The keyhole is sized from the cable diameter
// plus tolerance", "A recessed channel on the flange's inner face leads from
// the keyhole to the groove start", "The keyhole->channel->groove path
// respects the minimum bend radius; if impossible, a warning is emitted",
// "The part stays manifold". Issue #115 moved the keyhole onto the cable's
// tangent chord (the channel is straight now) and grows the flange margin
// when the chord needs more room; test/cableBend.test.ts checks the bend
// radius along the whole cable.
// These tests exercise ONLY the public `design()` interface (plus the shared
// `layoutInnerEnd` pure-math function, mirroring test/design.test.ts's own
// treatment of mount.ts), per the testing decisions in docs/research.md.

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
    mount: "none",
    plateJoint: "glue",
    ...overrides,
  };
}

async function assertManifold(mesh: { positions: Float32Array; indices: Uint32Array }, label: string): Promise<number> {
  const wasm = await Module();
  wasm.setup();
  const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
  try {
    expect(m.status(), `${label}: manifold status`).toBe("NoError");
    expect(m.volume(), `${label}: volume`).toBeGreaterThan(0);
    // A blind pocket/keyhole is not a tunnel: it must never change the
    // core's topology (still one hole through the whole part -- the bore).
    expect(m.genus(), `${label}: genus (a rim keyhole must not add a handle)`).toBe(1);
    return m.volume();
  } finally {
    m.delete();
  }
}

/** The real layout design() cut, re-derived from its own public fields. */
function layoutOf(d: Awaited<ReturnType<typeof design>>) {
  const bendRadius = bendMultiplierOf(d.spec.wire) * d.spec.wire.diameter;
  const channelDepth = resolveChannelDepth(d.spec.wire.diameter, d.flangeSpec.thickness, d.spec.mount);
  return layoutInnerEnd(d.flangeSpec.outline, d.flangeSpec.margin, d.spec.wire.diameter, d.spec.tolerance, bendRadius, channelDepth);
}

/** Layer 1's first sample and unit xy tangent (the groove start the lead-in aims at). */
function grooveStartOf(d: Awaited<ReturnType<typeof design>>) {
  const p = d.wirePaths[0].points;
  const len = Math.hypot(p[3] - p[0], p[4] - p[1]);
  return { x: p[0], y: p[1], z: p[2], tx: (p[3] - p[0]) / len, ty: (p[4] - p[1]) / len };
}

/** Distance of (x, y) from the line through `j` along its tangent. */
function distanceFromTangentLine(j: { x: number; y: number; tx: number; ty: number }, x: number, y: number): number {
  return Math.abs((x - j.x) * j.ty - (y - j.y) * j.tx);
}

describe("inner-end fixing: bottom rim keyhole and channel (issues #8, #115)", () => {
  it("sizes the keyhole from wire diameter + tolerance, and puts it on the tangent chord inside the flange rim", async () => {
    const wireDiameter = 4.2;
    const tolerance = 0.25;
    for (const shape of [{ kind: "round" }, { kind: "sq", cornerRadius: 15 }, { kind: "tri", cornerRadius: 15 }] as ShapeSpec[]) {
      const d = await design(baseSpec({ shape, wire: { length: 2000, diameter: wireDiameter, type: "usb" }, tolerance, coreSize: { locked: true, dimension: "outer", value: 60 } }));
      const layout = layoutOf(d);
      expect(layout.holeRadius).toBeCloseTo(wireDiameter / 2 + tolerance, 9);

      // Issue #115: on the straight line the cable leaves the groove start
      // along (backwards along layer 1's own tangent), give or take the
      // small sideways shift that keeps the channel clear of the wall.
      const j = grooveStartOf(d);
      expect(distanceFromTangentLine(j, layout.hole.x, layout.hole.y), `${shape.kind}: keyhole off the tangent chord`).toBeLessThan((wireDiameter + tolerance) / 2 + 1);
      // Behind the groove start (the side the cable comes from), not ahead.
      expect((layout.hole.x - j.x) * j.tx + (layout.hole.y - j.y) * j.ty).toBeLessThan(0);

      // Inside the flange, a skin short of its rim; the slit opens on the rim.
      const hole = outlineOffsetAt(d.flangeSpec.outline, layout.hole.x, layout.hole.y);
      expect(hole.offset).toBeLessThanOrEqual(d.flangeSpec.margin - layout.holeRadius - 1 + 1e-6);
      expect(hole.offset).toBeGreaterThan(layout.holeRadius);
      expect(outlineOffsetAt(d.flangeSpec.outline, layout.edge.x, layout.edge.y).offset).toBeCloseTo(d.flangeSpec.margin, 6);
    }
  });

  it("cuts the recessed channel from the keyhole along the chord: straight on a round core, a gentle arc (within the bend radius) on a square/triangle", async () => {
    for (const shape of [{ kind: "round" }, { kind: "sq", cornerRadius: 15 }, { kind: "tri", cornerRadius: 15 }] as ShapeSpec[]) {
      const d = await design(baseSpec({ shape, coreSize: { locked: true, dimension: "outer", value: 60 } }));
      const layout = layoutOf(d);
      const path = layout.channelPath;
      expect(path.length).toBeGreaterThanOrEqual(2);
      expect(path[0].x).toBeCloseTo(layout.hole.x, 9);
      expect(path[0].y).toBeCloseTo(layout.hole.y, 9);
      const bendRadius = bendMultiplierOf(d.spec.wire) * d.spec.wire.diameter;
      for (let i = 1; i + 1 < path.length; i++) {
        const [a, b, c] = [path[i - 1], path[i], path[i + 1]];
        const ab = Math.hypot(b.x - a.x, b.y - a.y);
        const bc = Math.hypot(c.x - b.x, c.y - b.y);
        const turn = Math.abs(Math.atan2((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x), (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)));
        if (shape.kind === "round") expect(turn, "round: straight").toBeLessThan(1e-6);
        else expect((turn / ((ab + bc) / 2)) * bendRadius, `${shape.kind}: channel bend`).toBeLessThanOrEqual(1);
      }
      // Its outline is channelWidth wide at the keyhole end.
      const ribbon = layout.channelRibbon;
      expect(Math.hypot(ribbon[0].x - ribbon[ribbon.length - 1].x, ribbon[0].y - ribbon[ribbon.length - 1].y)).toBeCloseTo(layout.channelWidth, 6);
    }
  });

  it("a square/triangle's keyhole reaches the rim along the flat side, clear of the next corner's through-hole (issue #115)", async () => {
    for (const shape of [{ kind: "sq", cornerRadius: 10 }, { kind: "tri", cornerRadius: 10 }] as ShapeSpec[]) {
      const d = await design(baseSpec({ shape, coreSize: { locked: false }, height: { locked: false }, mount: "through" }));
      expect(d.warnings.some((w) => /through-hole\(s\) skipped/.test(w)), `${shape.kind}: ${d.warnings.join(" | ")}`).toBe(false);
    }
  });

  it("does not warn about the bend radius for an ordinary design", async () => {
    const d = await design(baseSpec());
    expect(d.warnings.some((w) => /bends tighter|too narrow for the inner cable end/i.test(w))).toBe(false);
  });

  it("warns when the flange margin is too narrow for the lead-in, and says how wide it must be", () => {
    // design() grows the margin itself (next test), so this checks the
    // shared `layoutInnerEnd` function directly with a deliberately
    // too-narrow margin.
    const outline = { n: 4, apothem: 30, cornerRadius: 30 };
    const layout = layoutInnerEnd(outline, 4 /* mm, deliberately narrow */, 3.8, 0.2, 15.2);
    expect(layout.requiredMargin).toBeGreaterThan(4);
    expect(layout.warning).toMatch(/too narrow.*bend radius/i);
    expect(layout.warning).toContain(layout.requiredMargin.toFixed(1));
    // At the required margin it fits, with no warning.
    expect(layoutInnerEnd(outline, layout.requiredMargin + 1e-6, 3.8, 0.2, 15.2).warning).toBeUndefined();
  });

  it("design() grows the flange margin to fit the lead-in, and says so", async () => {
    const d = await design(baseSpec({ wire: { length: 2000, diameter: 3.8, type: "stiff" }, coreSize: { locked: true, dimension: "outer", value: 80 } }));
    const layout = layoutOf(d);
    expect(layout.warning).toBeUndefined();
    expect(d.flangeSpec.margin).toBeGreaterThanOrEqual(layout.requiredMargin - 1e-9);
    expect(d.warnings.some((w) => /Flange margin increased to .* so the inner cable end can reach the groove within its 38\.0 mm bend radius/.test(w))).toBe(true);
    await assertManifold(d.mesh, "stiff-cable core");
  });

  it("a thick cable still gets a valid layout and manifold", async () => {
    const d = await design(
      baseSpec({
        wire: { length: 2000, diameter: 8, type: "stiff" },
        coreSize: { locked: true, dimension: "outer", value: 60 },
        height: { locked: true, value: 40 },
        layers: { locked: true, value: 1 },
      }),
    );
    expect(layoutOf(d).warning).toBeUndefined();
    await assertManifold(d.mesh, "thick-cable core");
  });

  const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 15 }, { kind: "tri", cornerRadius: 15 }];

  it.each(SHAPES)("stays a valid, watertight, genus-1 manifold with the keyhole+channel cut for shape=$kind", async (shape) => {
    const d = await design(
      baseSpec({
        shape,
        coreSize: { locked: true, dimension: "outer", value: 60 },
      }),
    );
    await assertManifold(d.mesh, `keyhole+channel/${shape.kind}`);
  });

  it("removes real material from the core (the cutout, not a no-op)", async () => {
    // Issue #43: the flange's own thickness now tracks the wire diameter
    // too (a bigger cable also wants a thicker flange for a flush first
    // layer), so comparing two designs at different diameters (the
    // previous approach here) no longer isolates the cutout's own effect --
    // most of the volume delta would just be the thicker flange. Instead,
    // build the SAME wall/flange one design() actually produced (via its
    // own public `wallSpec`/`flangeSpec`) and call the exported
    // `fuseFlange` a second time with no `innerEnd` cutter at all, so the
    // only difference between the two meshes is the cutout itself.
    const d = await design(baseSpec({ wire: { length: 2000, diameter: 3.8, type: "usb" } }));
    const wall = buildWall(d.wallSpec);
    const withoutCut = await fuseFlange(wall, d.flangeSpec); // no innerEnd argument -- no cutout at all
    const thick = await assertManifold(d.mesh, "3.8mm core, with cutout");
    const thin = await assertManifold(withoutCut, "3.8mm core, no cutout (reference)");
    expect(thin - thick).toBeGreaterThan(20); // a few tens of mm^3, comfortably more than mesh noise
  });

  // Test-audit report, C-C: this used to also have "the mount's own recess
  // (issue #13) grows the flange thickness further (issue #43), so the
  // channel still reaches its ideal depth". Its thickness assertion
  // (keyhole > none, core=100/height=60) duplicated
  // test/design.test.ts's own "bumps the flange's thickness and margin (and
  // warns)..." on the identical spec, and its manifold check on the same
  // round/100/60/usb keyhole spec duplicated test/geometry.test.ts's issue
  // #43 single-piece-manifold sweep. The one thing only this test checked --
  // that the "channel is only ... mm deep" warning must NOT fire, for either
  // design -- moved into design.test.ts's test alongside those same
  // assertions.

  it("the drawn lead-in runs from the keyhole, lying flush in the channel, straight along the chord to EXACTLY layer 1's first sample", async () => {
    for (const shape of SHAPES) {
      const d = await design(baseSpec({ shape, coreSize: { locked: true, dimension: "outer", value: 60 } }));
      const layout = layoutOf(d);
      const lead = d.innerEndLeadIn;
      const n = lead.length / 3;
      expect(n).toBeGreaterThanOrEqual(2);

      // Starts at the keyhole, resting on the channel floor: its top is flush
      // with the flange face (issue #43), not proud of it.
      const channelDepth = resolveChannelDepth(d.spec.wire.diameter, d.flangeSpec.thickness, d.spec.mount);
      expect(lead[0]).toBeCloseTo(layout.hole.x, 4);
      expect(lead[1]).toBeCloseTo(layout.hole.y, 4);
      expect(lead[2]).toBeCloseTo(-channelDepth + d.spec.wire.diameter / 2, 4);
      expect(lead[2] + d.spec.wire.diameter / 2).toBeLessThanOrEqual(1e-4);

      // Ends bit-for-bit at layer 1's own first sample.
      const first = d.wirePaths[0].points;
      expect(lead[(n - 1) * 3]).toBeCloseTo(first[0], 5);
      expect(lead[(n - 1) * 3 + 1]).toBeCloseTo(first[1], 5);
      expect(lead[(n - 1) * 3 + 2]).toBeCloseTo(first[2], 5);

      // A straight chord in plan view: every sample within the channel's
      // small sideways shift of the tangent line.
      const j = grooveStartOf(d);
      for (let i = 0; i < n; i++) {
        expect(distanceFromTangentLine(j, lead[i * 3], lead[i * 3 + 1]), `${shape.kind}: sample ${i} off the chord`).toBeLessThan(d.spec.wire.diameter);
      }
    }
  });

  it("is empty when layer 1 has no turns (nothing to lead into)", async () => {
    const d = await design(
      baseSpec({
        wire: { length: 50, diameter: 3.8, type: "usb" },
        height: { locked: true, value: 5 }, // usable height (minus margins) is below one pitch
      }),
    );
    expect(d.solution.layerResults[0]?.turns ?? 0).toBe(0);
    // The channel/keyhole are still cut (they don't depend on turns), but
    // there is no wound layer to visually lead into with a drawn tube --
    // the viewer only ever draws the lead-in ALONGSIDE `wirePaths[0]`
    // (CoilViewer.tsx), which is itself empty here.
    expect(d.wirePaths).toHaveLength(0);
  });
});
