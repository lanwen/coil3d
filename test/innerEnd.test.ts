import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design, outlineOffsetAt } from "../src/core";
import type { CoilSpec, Design, ShapeSpec } from "../src/core";
import { rayHits } from "./support/rays";

// Issue #8 acceptance criteria: "The keyhole is sized from the cable diameter
// plus tolerance", "A recessed channel on the flange's inner face leads from
// the keyhole to the groove start", "The keyhole->channel->groove path
// respects the minimum bend radius; if impossible, a warning is emitted",
// "The part stays manifold". Issue #115 moved the fixing onto the cable's
// tangent chord and grows the flange margin when the chord needs more room;
// issue #117 replaced the keyhole with a clip along the cable and sweeps the
// channel along it (test/cableClip.test.ts checks the cut cross-sections);
// test/cableBend.test.ts checks the bend radius along the whole cable.
// These tests exercise ONLY the public `design()` interface, per the testing
// rules in AGENTS.md.

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
    base: "on",
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

/** The channel's floor (z) straight below each lead-in sample that lies over the flange, outside the wall, with the cable's centre height there. */
function channelFloors(d: Design): Array<{ floor: number; cableZ: number }> {
  const lead = d.innerEndLeadIn;
  const floors: Array<{ floor: number; cableZ: number }> = [];
  for (let i = 0; i < lead.length; i += 3) {
    const { offset } = outlineOffsetAt(d.flangeSpec.outline, lead[i], lead[i + 1]);
    if (offset < 1 || offset > d.flangeSpec.margin - 1) continue;
    const top = d.solution.height + 5;
    const hits = rayHits(d.mesh, [lead[i], lead[i + 1], top], [0, 0, -1]);
    floors.push({ floor: top - hits[0], cableZ: lead[i + 2] });
  }
  return floors;
}

describe("inner-end fixing: bottom flange channel and clip (issues #8, #115, #117)", () => {
  it("sizes the clip from wire diameter + tolerance, puts it on the tangent chord inside the flange rim, and leads the cable out through the rim (issue #117)", async () => {
    const wireDiameter = 4.2;
    const tolerance = 0.25;
    for (const shape of [{ kind: "round" }, { kind: "sq", cornerRadius: 15 }, { kind: "tri", cornerRadius: 15 }] as ShapeSpec[]) {
      const d = await design(baseSpec({ shape, wire: { length: 2000, diameter: wireDiameter, type: "usb" }, tolerance, coreSize: { locked: true, dimension: "outer", value: 60 } }));
      const clip = d.innerEndClip!;
      const channelRadius = (wireDiameter + tolerance) / 2;
      // The opening is narrower than the cable, so it snaps in.
      expect(clip.opening).toBeLessThan(wireDiameter);

      // Issue #115: on the straight line the cable leaves the groove start
      // along (backwards along layer 1's own tangent), give or take the
      // small sideways shift that keeps the channel clear of the wall, and on
      // a square's or triangle's flat side the gentle outward bend that brings
      // the clip to the rim by the side's middle (innerEnd.ts's `bendToRim`;
      // it reaches 1.6 mm here once the flange is wide enough to need it).
      const j = grooveStartOf(d);
      for (const at of [clip.from, clip.to]) {
        expect(distanceFromTangentLine(j, at.x, at.y), `${shape.kind}: clip off the tangent chord`).toBeLessThan((wireDiameter + tolerance) / 2 + (shape.kind === "round" ? 1 : 2));
        // Behind the groove start (the side the cable comes from), not ahead.
        expect((at.x - j.x) * j.tx + (at.y - j.y) * j.ty).toBeLessThan(0);
      }

      // Both lips inside the flange, a wall short of its rim; the cable
      // crosses the rim further along the same chord and ends outside it.
      const clipEnd = outlineOffsetAt(d.flangeSpec.outline, clip.to.x, clip.to.y);
      expect(clipEnd.offset).toBeLessThanOrEqual(d.flangeSpec.margin - channelRadius - 1 + 1e-6);
      expect(clipEnd.offset).toBeGreaterThan(channelRadius);
      expect(outlineOffsetAt(d.flangeSpec.outline, clip.rimExit.x, clip.rimExit.y).offset).toBeCloseTo(d.flangeSpec.margin, 6);
      const tailEnd = { x: d.innerEndLeadIn[0], y: d.innerEndLeadIn[1] };
      expect(outlineOffsetAt(d.flangeSpec.outline, tailEnd.x, tailEnd.y).offset).toBeGreaterThan(d.flangeSpec.margin + 5);
    }
  });

  it("the base clip's opening scales with the cable: a few percent under its diameter, never past the 45 degree overhang limit", async () => {
    // Half the old 0.25 mm diameter grid: each point is a whole design(), and the opening is smooth in the diameter.
    for (let wireDiameter = 2; wireDiameter <= 8; wireDiameter += 0.5) {
      for (const tolerance of [0.05, 0.2, 0.4, 0.8]) {
        const d = await design(baseSpec({ wire: { length: 200, diameter: wireDiameter, type: "usb" }, coreSize: { locked: false }, height: { locked: false }, topCap: "off", tolerance }), "draft");
        const opening = d.innerEndClip!.opening;
        const fraction = opening / (wireDiameter + tolerance);
        // The lips' underside overhangs by acos(fraction) from vertical.
        expect((Math.acos(fraction) * 180) / Math.PI, `d=${wireDiameter} tol=${tolerance}`).toBeLessThanOrEqual(45);
        // A modest interference: at the default tolerance and at tighter fits the cable is
        // squeezed by 8% of its diameter (a looser print only gets the overhang floor).
        if (tolerance <= 0.2) expect(wireDiameter - opening, `d=${wireDiameter} tol=${tolerance}`).toBeCloseTo(0.08 * wireDiameter, 9);
        expect(opening, `d=${wireDiameter} tol=${tolerance}`).toBeGreaterThan(0.75 * wireDiameter);
      }
    }
  });

  it("the channel is cut round the drawn cable: open from past the rim, down to the bore's bottom at the channel's depth (issue #117)", async () => {
    for (const shape of [{ kind: "round" }, { kind: "sq", cornerRadius: 15 }, { kind: "tri", cornerRadius: 15 }] as ShapeSpec[]) {
      const d = await design(baseSpec({ shape, coreSize: { locked: true, dimension: "outer", value: 60 } }));
      const lead = d.innerEndLeadIn;
      const { channelDepth } = d.innerEndClip!;
      expect(outlineOffsetAt(d.flangeSpec.outline, lead[0], lead[1]).offset, `${shape.kind}: the lead-in starts past the rim`).toBeGreaterThan(d.flangeSpec.margin);
      // Its deepest cut is the bore's bottom around the cable resting in the
      // channel: channelDepth to the cable's bottom, tolerance/2 more for the bore.
      const floors = channelFloors(d);
      expect(floors.length, `${shape.kind}: samples in the channel`).toBeGreaterThanOrEqual(10);
      expect(Math.min(...floors.map((f) => f.floor)), shape.kind).toBeCloseTo(-channelDepth - d.spec.tolerance / 2, 3);
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

  it("design() grows the flange margin to fit the lead-in, and says so", async () => {
    const d = await design(baseSpec({ wire: { length: 2000, diameter: 3.8, type: "stiff" }, coreSize: { locked: true, dimension: "outer", value: 80 } }));
    expect(d.warnings.filter((w) => /too narrow.*bend radius/i.test(w))).toEqual([]);
    expect(d.warnings.some((w) => /Flange margin increased to .* so the inner cable end can reach the groove within its 24\.7 mm bend radius/.test(w))).toBe(true);
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
    expect(d.warnings.filter((w) => /too narrow.*bend radius/i.test(w))).toEqual([]);
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
    // Issue #122: on a full-thickness plate, so the channel's own pad doesn't muddy the comparison. The core's top
    // face is flat flange there, so a ray down onto the channel's centreline meets solid at the face unless the cutout
    // is real: it must find air all the way down to the channel's floor.
    const d = await design(baseSpec({ wire: { length: 2000, diameter: 3.8, type: "usb" } }));
    const { channelDepth } = d.innerEndClip!;
    const floors = channelFloors(d);
    expect(floors.length).toBeGreaterThanOrEqual(10);
    const boreRadius = (d.spec.wire.diameter + d.spec.tolerance) / 2;
    for (const { floor, cableZ } of floors) expect(floor).toBeLessThanOrEqual(cableZ - boreRadius + 0.05);
    expect(Math.min(...floors.map((f) => f.floor))).toBeCloseTo(-channelDepth - d.spec.tolerance / 2, 3);
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
      const clip = d.innerEndClip!;
      const lead = d.innerEndLeadIn;
      const n = lead.length / 3;
      expect(n).toBeGreaterThanOrEqual(2);

      // Level from its free end through the rim and the clip, resting on the
      // channel floor: its top is flush with the flange face (issue #43), not
      // proud of it.
      const zChannel = -clip.channelDepth + d.spec.wire.diameter / 2;
      expect(lead[2] + d.spec.wire.diameter / 2).toBeLessThanOrEqual(1e-4);
      for (let i = 0; i < n; i++) {
        const dx = lead[i * 3] - lead[0];
        const dy = lead[i * 3 + 1] - lead[1];
        const toClipStart = Math.hypot(clip.to.x - lead[0], clip.to.y - lead[1]);
        if (Math.hypot(dx, dy) > toClipStart) break;
        expect(lead[i * 3 + 2], `${shape.kind}: sample ${i} level through the clip`).toBeCloseTo(zChannel, 4);
      }
      expect(clip.from.z - zChannel, "the lips start once the cable has (nearly) settled").toBeLessThanOrEqual(0.25 + 1e-6);

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
        if (outlineOffsetAt(d.flangeSpec.outline, lead[i * 3], lead[i * 3 + 1]).offset > outlineOffsetAt(d.flangeSpec.outline, clip.to.x, clip.to.y).offset + 1e-6) continue;
        expect(distanceFromTangentLine(j, lead[i * 3], lead[i * 3 + 1]), `${shape.kind}: sample ${i} off the chord`).toBeLessThan(d.spec.wire.diameter);
      }
    }
  });

  // A flat spiral needs only the cable plus 0.4 mm (4.2 mm here), so the lock sits below that to be raised.
  it("a locked height too short for one turn is raised, so layer 1 always winds and the lead-in exists", async () => {
    const d = await design(
      baseSpec({
        wire: { length: 50, diameter: 3.8, type: "usb" },
        height: { locked: true, value: 3 },
        topCap: "on",
      }),
    );
    expect(d.solution.height).toBeCloseTo(d.solution.minHeight, 6);
    expect(d.solution.layerResults[0].turns).toBeGreaterThanOrEqual(1);
    expect(d.wirePaths).toHaveLength(1);
    expect(d.innerEndLeadIn.length).toBeGreaterThanOrEqual(6);
  });

});
