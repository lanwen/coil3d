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
import { baseClipOpeningFraction, layoutInnerEnd, resolveChannelDepth } from "../src/core/innerEnd";
import { fuseFlange } from "../src/core/manifold";
import { outlineOffsetAt } from "../src/core/shapes";
import { bendMultiplierOf } from "../src/core/types";
import { buildWall } from "../src/core/wall";

// Issue #8 acceptance criteria: "The keyhole is sized from the cable diameter
// plus tolerance", "A recessed channel on the flange's inner face leads from
// the keyhole to the groove start", "The keyhole->channel->groove path
// respects the minimum bend radius; if impossible, a warning is emitted",
// "The part stays manifold". Issue #115 moved the fixing onto the cable's
// tangent chord and grows the flange margin when the chord needs more room;
// issue #117 replaced the keyhole with a clip along the cable and sweeps the
// channel along it (test/cableClip.test.ts checks the cut cross-sections);
// test/cableBend.test.ts checks the bend radius along the whole cable.
// These tests exercise ONLY the public `design()` interface (plus the shared
// `layoutInnerEnd` pure-math function, mirroring test/design.test.ts's own
// treatment of mount.ts), per the testing rules in AGENTS.md.

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
    // A blind pocket or channel is not a tunnel: it must never change the
    // core's topology (still one hole through the whole part -- the bore).
    expect(m.genus(), `${label}: genus (the channel and clip must not add a handle)`).toBe(1);
    return m.volume();
  } finally {
    m.delete();
  }
}

/** The real layout design() cut, re-derived from its own public fields. */
function layoutOf(d: Awaited<ReturnType<typeof design>>) {
  const bendRadius = bendMultiplierOf(d.spec.wire) * d.spec.wire.diameter;
  const channelDepth = resolveChannelDepth(d.spec.wire.diameter, d.flangeSpec.thickness);
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

describe("inner-end fixing: bottom flange channel and clip (issues #8, #115, #117)", () => {
  it("sizes the clip from wire diameter + tolerance, puts it on the tangent chord inside the flange rim, and leads the cable out through the rim (issue #117)", async () => {
    const wireDiameter = 4.2;
    const tolerance = 0.25;
    for (const shape of [{ kind: "round" }, { kind: "sq", cornerRadius: 15 }, { kind: "tri", cornerRadius: 15 }] as ShapeSpec[]) {
      const d = await design(baseSpec({ shape, wire: { length: 2000, diameter: wireDiameter, type: "usb" }, tolerance, coreSize: { locked: true, dimension: "outer", value: 60 } }));
      const layout = layoutOf(d);
      expect(layout.channelRadius).toBeCloseTo((wireDiameter + tolerance) / 2, 9);
      // The opening is narrower than the cable, so it snaps in.
      expect(layout.clipOpening).toBeLessThan(wireDiameter);

      // Issue #115: on the straight line the cable leaves the groove start
      // along (backwards along layer 1's own tangent), give or take the
      // small sideways shift that keeps the channel clear of the wall, and on
      // a square's or triangle's flat side the gentle outward bend that brings
      // the clip to the rim by the side's middle (innerEnd.ts's `bendToRim`;
      // it reaches 1.6 mm here once the flange is wide enough to need it).
      const j = grooveStartOf(d);
      for (const at of [layout.clip.from, layout.clip.to]) {
        expect(distanceFromTangentLine(j, at.x, at.y), `${shape.kind}: clip off the tangent chord`).toBeLessThan((wireDiameter + tolerance) / 2 + (shape.kind === "round" ? 1 : 2));
        // Behind the groove start (the side the cable comes from), not ahead.
        expect((at.x - j.x) * j.tx + (at.y - j.y) * j.ty).toBeLessThan(0);
      }

      // Both lips inside the flange, a wall short of its rim; the cable
      // crosses the rim further along the same chord and ends outside it.
      const clipEnd = outlineOffsetAt(d.flangeSpec.outline, layout.clip.to.x, layout.clip.to.y);
      expect(clipEnd.offset).toBeLessThanOrEqual(d.flangeSpec.margin - layout.channelRadius - 1 + 1e-6);
      expect(clipEnd.offset).toBeGreaterThan(layout.channelRadius);
      expect(outlineOffsetAt(d.flangeSpec.outline, layout.rimExit.x, layout.rimExit.y).offset).toBeCloseTo(d.flangeSpec.margin, 6);
      const tailEnd = layout.leadIn[0];
      expect(outlineOffsetAt(d.flangeSpec.outline, tailEnd.x, tailEnd.y).offset).toBeGreaterThan(d.flangeSpec.margin + 5);
    }
  });

  it("the base clip's opening scales with the cable: a few percent under its diameter, never past the 45 degree overhang limit", () => {
    for (let d = 2; d <= 8; d += 0.25) {
      for (const tolerance of [0.05, 0.2, 0.4, 0.8]) {
        const fraction = baseClipOpeningFraction(d, tolerance);
        // The lips' underside overhangs by acos(fraction) from vertical.
        expect((Math.acos(fraction) * 180) / Math.PI, `d=${d} tol=${tolerance}`).toBeLessThanOrEqual(45);
        // A modest interference: at the default tolerance and at tighter fits the cable is
        // squeezed by 8% of its diameter (a looser print only gets the overhang floor).
        const opening = fraction * (d + tolerance);
        if (tolerance <= 0.2) expect(d - opening, `d=${d} tol=${tolerance}`).toBeCloseTo(0.08 * d, 9);
        expect(opening, `d=${d} tol=${tolerance}`).toBeGreaterThan(0.75 * d);
      }
    }
  });

  it("the channel is swept around the drawn cable: every cross-section is the round bore about the cable's own centre, from above the face to past the rim (issue #117)", async () => {
    for (const shape of [{ kind: "round" }, { kind: "sq", cornerRadius: 15 }, { kind: "tri", cornerRadius: 15 }] as ShapeSpec[]) {
      const d = await design(baseSpec({ shape, coreSize: { locked: true, dimension: "outer", value: 60 } }));
      const layout = layoutOf(d);
      const { rings } = layout.channel;
      expect(rings.length).toBeGreaterThanOrEqual(10);
      expect(new Set(rings.map((r) => r.length)).size, "same vertex count everywhere").toBe(1);
      // Starts with the bore still above the flange face (zero depth)...
      expect(Math.min(...rings[0].map((p) => p.z))).toBeGreaterThan(0);
      // ...and ends with the whole bore past the rim.
      for (const p of rings[rings.length - 1]) expect(outlineOffsetAt(d.flangeSpec.outline, p.x, p.y).offset).toBeGreaterThan(d.flangeSpec.margin);
      // Its deepest cut is the bore's bottom around the cable resting in the
      // channel: channelDepth to the cable's bottom, tolerance/2 more for the bore.
      const channelDepth = resolveChannelDepth(d.spec.wire.diameter, d.flangeSpec.thickness);
      const deepest = Math.min(...rings.flat().map((p) => p.z));
      expect(deepest).toBeCloseTo(-channelDepth - d.spec.tolerance / 2, 3);
    }
  });

  it("a square/triangle's clip reaches the rim along the flat side, clear of the next corner's through-hole (issue #115)", async () => {
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

  it.each(SHAPES)("stays a valid, watertight, genus-1 manifold with the channel+clip cut for shape=$kind", async (shape) => {
    const d = await design(
      baseSpec({
        shape,
        coreSize: { locked: true, dimension: "outer", value: 60 },
      }),
    );
    await assertManifold(d.mesh, `channel+clip/${shape.kind}`);
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
    // Issue #122: on a full-thickness plate (no pads), so the channel's own
    // pad -- present only with the cut -- doesn't muddy the comparison.
    const d = await design(baseSpec({ wire: { length: 2000, diameter: 3.8, type: "usb" } }));
    const wall = buildWall(d.wallSpec);
    const flat = { ...d.flangeSpec, plateThickness: d.flangeSpec.thickness };
    const diameter = d.spec.wire.diameter;
    const cut = { wireDiameter: diameter, tolerance: d.spec.tolerance, bendRadius: bendMultiplierOf(d.spec.wire) * diameter, channelDepth: resolveChannelDepth(diameter, flat.thickness), flangeThickness: flat.thickness };
    const withoutCut = await fuseFlange(wall, flat); // no innerEnd argument -- no cutout at all
    const thick = await assertManifold(await fuseFlange(wall, flat, undefined, cut), "3.8mm core, with cutout");
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

  it("the drawn lead-in runs from past the rim, level through the clip and flush in the channel, straight along the chord to EXACTLY layer 1's first sample", async () => {
    for (const shape of SHAPES) {
      const d = await design(baseSpec({ shape, coreSize: { locked: true, dimension: "outer", value: 60 } }));
      const layout = layoutOf(d);
      const lead = d.innerEndLeadIn;
      const n = lead.length / 3;
      expect(n).toBeGreaterThanOrEqual(2);
      expect(lead[0]).toBeCloseTo(layout.leadIn[0].x, 4);
      expect(lead[1]).toBeCloseTo(layout.leadIn[0].y, 4);

      // Level from its free end through the rim and the clip, resting on the
      // channel floor: its top is flush with the flange face (issue #43), not
      // proud of it.
      const channelDepth = resolveChannelDepth(d.spec.wire.diameter, d.flangeSpec.thickness);
      const zChannel = -channelDepth + d.spec.wire.diameter / 2;
      expect(lead[2] + d.spec.wire.diameter / 2).toBeLessThanOrEqual(1e-4);
      for (let i = 0; i < n; i++) {
        const dx = lead[i * 3] - layout.leadIn[0].x;
        const dy = lead[i * 3 + 1] - layout.leadIn[0].y;
        const toClipStart = Math.hypot(layout.clip.to.x - layout.leadIn[0].x, layout.clip.to.y - layout.leadIn[0].y);
        if (Math.hypot(dx, dy) > toClipStart) break;
        expect(lead[i * 3 + 2], `${shape.kind}: sample ${i} level through the clip`).toBeCloseTo(zChannel, 4);
      }
      expect(layout.clip.from.z - zChannel, "the lips start once the cable has (nearly) settled").toBeLessThanOrEqual(0.25 + 1e-6);

      // Ends bit-for-bit at layer 1's own first sample.
      const first = d.wirePaths[0].points;
      expect(lead[(n - 1) * 3]).toBeCloseTo(first[0], 5);
      expect(lead[(n - 1) * 3 + 1]).toBeCloseTo(first[1], 5);
      expect(lead[(n - 1) * 3 + 2]).toBeCloseTo(first[2], 5);

      // A straight chord in plan view: every sample from the clip in within
      // the channel's small sideways shift of the tangent line (the
      // rest runs on out through the rim, then straight).
      const j = grooveStartOf(d);
      for (let i = 0; i < n; i++) {
        if (outlineOffsetAt(d.flangeSpec.outline, lead[i * 3], lead[i * 3 + 1]).offset > outlineOffsetAt(d.flangeSpec.outline, layout.clip.to.x, layout.clip.to.y).offset + 1e-6) continue;
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
    // The channel and clip are still cut (they don't depend on turns), but
    // there is no wound layer to visually lead into with a drawn tube --
    // the viewer only ever draws the lead-in ALONGSIDE `wirePaths[0]`
    // (CoilViewer.tsx), which is itself empty here.
    expect(d.wirePaths).toHaveLength(0);
  });
});
