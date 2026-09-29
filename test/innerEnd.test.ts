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
import { layoutInnerEnd } from "../src/core/innerEnd";
import { fuseFlange } from "../src/core/manifold";
import { pointAt } from "../src/core/shapes";
import { bendMultiplierOf } from "../src/core/types";
import { buildWall } from "../src/core/wall";

// Issue #8 acceptance criteria: "The keyhole is sized from the cable diameter
// plus tolerance, and placed at the groove start angle", "A recessed radial
// channel on the flange's inner face leads from the keyhole to the groove
// start", "The keyhole->channel->groove path respects the minimum bend
// radius; if impossible, a warning is emitted", "The part stays manifold".
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

describe("inner-end fixing: bottom rim keyhole and channel (issue #8)", () => {
  it("sizes the keyhole from wire diameter + tolerance, and places it at the groove-start angle (t=0)", async () => {
    const wireDiameter = 4.2;
    const tolerance = 0.25;
    const d = await design(baseSpec({ wire: { length: 2000, diameter: wireDiameter, type: "usb" }, tolerance }));

    const bendRadius = bendMultiplierOf(d.spec.wire) * wireDiameter;
    const layout = layoutInnerEnd(d.flangeSpec.outline, d.flangeSpec.margin, wireDiameter, tolerance, bendRadius);

    expect(layout.holeRadius).toBeCloseTo(wireDiameter / 2 + tolerance, 9);

    // The groove-start point is exactly the wall's own outer surface at
    // t=0, offset 0 -- the same reference point the top cap's own rim
    // keyhole uses (manifold.ts's buildKeyholeCutter), and the point the
    // wall's helix actually starts winding from (wall.ts).
    const grooveStart = pointAt(d.flangeSpec.outline, 0, 0);
    expect(layout.groove.x).toBeCloseTo(grooveStart.x, 9);
    expect(layout.groove.y).toBeCloseTo(grooveStart.y, 9);

    // The keyhole sits strictly between the groove start and the flange's
    // true outer edge, on the same ray (see innerEnd.ts's file header).
    const edge = pointAt(d.flangeSpec.outline, 0, d.flangeSpec.margin);
    expect(layout.edge.x).toBeCloseTo(edge.x, 9);
    expect(layout.edge.y).toBeCloseTo(edge.y, 9);
    const distGrooveToHole = Math.hypot(layout.hole.x - layout.groove.x, layout.hole.y - layout.groove.y);
    const distGrooveToEdge = Math.hypot(edge.x - layout.groove.x, edge.y - layout.groove.y);
    expect(distGrooveToHole).toBeGreaterThan(0);
    expect(distGrooveToHole).toBeLessThan(distGrooveToEdge);
  });

  it("cuts a recessed channel from the keyhole to the groove start (a real, gap-free centreline)", async () => {
    const d = await design(baseSpec());
    const bendRadius = bendMultiplierOf(d.spec.wire) * d.spec.wire.diameter;
    const layout = layoutInnerEnd(d.flangeSpec.outline, d.flangeSpec.margin, d.spec.wire.diameter, d.spec.tolerance, bendRadius);

    expect(layout.channelPath.length).toBeGreaterThanOrEqual(2);
    // Starts at the keyhole itself, ends tangent into the winding direction
    // near the groove start (innerEnd.ts's fillet construction).
    expect(layout.channelPath[0].x).toBeCloseTo(layout.hole.x, 9);
    expect(layout.channelPath[0].y).toBeCloseTo(layout.hole.y, 9);
    const last = layout.channelPath[layout.channelPath.length - 1];
    const distLastToGroove = Math.hypot(last.x - layout.groove.x, last.y - layout.groove.y);
    expect(distLastToGroove).toBeLessThanOrEqual(layout.channelRadius + 1e-6);

    // No gaps: consecutive samples never jump farther than the channel's
    // own radius scale (a real, continuous polyline, not scattered points).
    for (let i = 1; i < layout.channelPath.length; i++) {
      const a = layout.channelPath[i - 1];
      const b = layout.channelPath[i];
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(Math.max(1, layout.channelRadius) * 2 + 1);
    }
  });

  it("does not warn about the bend radius for an ordinary design (a tighter-than-ideal-but-still-curved fillet is normal, not an error)", async () => {
    const d = await design(baseSpec());
    expect(d.warnings.some((w) => /unrelieved sharp corner/i.test(w))).toBe(false);
  });

  it("warns when the flange margin can't even clear the keyhole from the groove start (an unrelieved sharp corner)", async () => {
    // design()'s own solver naturally grows the flange margin along with
    // the wire diameter (the wound layer's own radial offset), so a solved
    // design rarely lands in the genuinely "impossible" case -- this checks
    // the shared `layoutInnerEnd` function directly with a deliberately
    // too-narrow margin, the same way test/design.test.ts's own "warns
    // (without crashing) ... a margin it already knows is too narrow" case
    // exercises mount.ts's `layoutKeyholeMount`.
    const outline = { n: 4, apothem: 30, cornerRadius: 30 };
    const layout = layoutInnerEnd(outline, 2 /* mm, deliberately narrow */, 10 /* mm wire */, 0.2, 40);
    expect(layout.warning).toMatch(/unrelieved sharp corner/i);
    expect(layout.channelRadius).toBe(0);
  });

  it("design()'s own solved margin usually clears the keyhole (channelRadius > 0) even for a fairly thick cable", async () => {
    const d = await design(
      baseSpec({
        wire: { length: 2000, diameter: 8, type: "stiff" },
        coreSize: { locked: true, dimension: "outer", value: 60 },
        height: { locked: true, value: 40 },
        layers: { locked: true, value: 1 },
      }),
    );
    const bendRadius = bendMultiplierOf(d.spec.wire) * d.spec.wire.diameter;
    const layout = layoutInnerEnd(d.flangeSpec.outline, d.flangeSpec.margin, d.spec.wire.diameter, d.spec.tolerance, bendRadius);
    expect(layout.warning).toBeUndefined();
    expect(layout.channelRadius).toBeGreaterThan(0);
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

  it("the wound-cable schematic's lead-in starts at the keyhole and ends EXACTLY at layer 1's own first sample (issue #68)", async () => {
    const d = await design(baseSpec());
    expect(d.innerEndLeadIn.length).toBeGreaterThanOrEqual(6); // at least 2 samples (x,y,z)

    const bendRadius = bendMultiplierOf(d.spec.wire) * d.spec.wire.diameter;
    const layout = layoutInnerEnd(d.flangeSpec.outline, d.flangeSpec.margin, d.spec.wire.diameter, d.spec.tolerance, bendRadius);

    expect(d.innerEndLeadIn[0]).toBeCloseTo(layout.hole.x, 5);
    expect(d.innerEndLeadIn[1]).toBeCloseTo(layout.hole.y, 5);
    expect(d.innerEndLeadIn[2]).toBe(0); // flat, cut into the flange's inner (z=0) face

    // Issue #68: the lead-in no longer just gets CLOSE to the groove start
    // (the fillet's own tangent point, a few mm short of layer 1's real
    // centerline) -- a second Hermite bridge (wire.ts's `buildInnerEndLeadIn`)
    // closes that gap exactly, so the lead-in's own last sample is now
    // BIT-FOR-BIT `wirePaths[0]`'s own first sample.
    const n = d.innerEndLeadIn.length / 3;
    const lastX = d.innerEndLeadIn[(n - 1) * 3];
    const lastY = d.innerEndLeadIn[(n - 1) * 3 + 1];
    const lastZ = d.innerEndLeadIn[(n - 1) * 3 + 2];
    const firstTurn = d.wirePaths[0];
    expect(lastX).toBeCloseTo(firstTurn.points[0], 5);
    expect(lastY).toBeCloseTo(firstTurn.points[1], 5);
    expect(lastZ).toBeCloseTo(firstTurn.points[2], 5);
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
