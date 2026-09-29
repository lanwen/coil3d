// Issue #71 (keyhole mount: rotation option + a verified screw-catching
// notch) and issue #70 (a new through-hole screw mount). These tests
// exercise ONLY the core's public interface (`design`) plus mount.ts's own
// exported layout functions -- the SAME shared, pure functions BOTH geometry
// backends (manifold.ts, step/build.ts) cut from, per this repo's own
// "one shared layout, several consumers" convention (see mount.ts's file
// header) -- and, for the keyhole undercut, manifold-3d used as an
// independent verification tool against the ACTUAL built mesh (slicing it,
// per the ticket's own ask to "check the actual mesh... rather than trusting
// the parameters"), never a re-implementation of the cut.

import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec } from "../src/core";
import {
  DEFAULT_THROUGH_HOLE_DIAMETER,
  SCREW_MOUNT_HEAD_DIAMETER,
  SCREW_MOUNT_HEAD_HEIGHT,
  SCREW_MOUNT_RECESS_DEPTH,
  SCREW_MOUNT_SHANK_DIAMETER,
  SCREW_MOUNT_SLOT_DEPTH,
  SCREW_MOUNT_UNDERCUT_DEPTH,
  THROUGH_MOUNT_COUNTERBORE_MARGIN,
} from "../src/core/constants";
import { layoutKeyholeMount, layoutThroughHoleMount, requiredThroughMountMargin } from "../src/core/mount";
import { layoutInnerEnd } from "../src/core/innerEnd";
import { makeOutline, offsetOutline, radiusAtAngle } from "../src/core/shapes";
import { bendMultiplierOf } from "../src/core/types";

function baseSpec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 2000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 50 },
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

// --- Issue #71: keyhole rotation -----------------------------------------

describe("keyhole mount rotation (issue #71)", () => {
  // Test-audit report, C-B (B1+B2): this describe used to also have a
  // "bestAxisDeg re-centres its search on keyholeRotation instead of literal
  // vertical" test that called `bestAxisDeg` directly, and the test below
  // derived its `expectedAxis` for `layout.axisDeg`/`d.mountAxisDeg` the same
  // way -- so both checks were really `bestAxisDeg` agreeing with itself.
  // Moved onto the public `design()` boundary: `layoutKeyholeMount`'s own
  // axis must equal `design()`'s surfaced `d.mountAxisDeg` (the real
  // cross-backend contract this repo cares about -- what design() reports
  // is what the cutters actually use), and the "genuine mirror axis" check
  // (a square's own natural axes are 45 degrees apart -- mount.ts's file
  // header) now reads `d.mountAxisDeg` itself, not a value the helper under
  // test produced.
  it("design()'s mountAxisDeg follows spec.keyholeRotation (0 vs 45 place the 2-slot mount on a different axis), agrees with layoutKeyholeMount's own axis, and the mount still fits (still hangs level)", async () => {
    const axes: Record<number, number> = {};
    for (const kr of [0, 45] as const) {
      const d = await design(baseSpec({ shape: { kind: "sq", cornerRadius: 15 }, coreSize: { locked: true, dimension: "outer", value: 100 }, mount: "keyhole", keyholeRotation: kr }));
      expect(d.warnings.some((w) => /too narrow/i.test(w))).toBe(false);
      const layout = layoutKeyholeMount(d.flangeSpec.outline, d.flangeSpec.boreOutline, d.flangeSpec.margin, kr);
      expect(layout.slots).toHaveLength(2); // this flange is well above the 2-slot threshold, for every rotation
      // The real cross-backend contract: design()'s own surfaced axis is
      // what the mount layout actually used.
      expect(d.mountAxisDeg).not.toBeUndefined();
      expect(layout.axisDeg).toBeCloseTo(d.mountAxisDeg!, 6);
      // Both rotations still land on one of the shape's own genuine mirror
      // axes (see candidateAxisDegs's own doc comment) -- a multiple of 45
      // degrees for this square.
      expect(d.mountAxisDeg! % 45).toBeCloseTo(0, 6);
      axes[kr] = d.mountAxisDeg!;

      // Still hangs level regardless of rotation: each slot's own channel
      // points literally up (mount.ts's WALL_UP convention -- see
      // design.test.ts's own "hangs level" coverage for the un-rotated case).
      for (const slot of layout.slots) {
        expect(slot.shankEnd.x).toBeCloseTo(slot.head.x, 9);
        expect(slot.shankEnd.y).toBeGreaterThan(slot.head.y);
      }
    }
    expect(axes[45]).not.toBeCloseTo(axes[0], 6); // rotation actually changed which axis got used
  });
});

// --- Issue #71: the undercut, verified against the ACTUAL built mesh -----

describe("keyhole mount undercut (issue #71): verified against the built mesh, not just parameters", () => {
  it("head hole >= head diameter, slot width strictly between shank and head diameters, and the undercut is wider than the slot and >= head height deep", async () => {
    const d = await design(baseSpec({ mount: "keyhole" }));
    const layout = layoutKeyholeMount(d.flangeSpec.outline, d.flangeSpec.boreOutline, d.flangeSpec.margin, 0);
    expect(layout.slots).toHaveLength(1); // a 50mm round core stays under the 2-slot threshold
    const slot = layout.slots[0];

    const wasm = await Module();
    wasm.setup();
    const manifold = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: d.mesh.positions, triVerts: d.mesh.indices }));

    /** Point-in-polygon (even-odd), across every contour a slice returns -- used to measure how far the VOID (the mount's own cut) extends from a known interior point, along one axis. */
    const inside = (polys: [number, number][][], x: number, y: number): boolean => {
      let odd = false;
      for (const poly of polys) {
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const [xi, yi] = poly[i];
          const [xj, yj] = poly[j];
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
        }
      }
      return odd;
    };

    /** Width of the void (the cut) at `(cx, cy, z)`, measured along the x axis (the slot's own channel runs along y -- see mount.ts's `makeSlotAt` convention -- so x is the perpendicular/"across the slot" direction) -- a bisection against the SOLID material's own cross-section at that z: the void's edge is where material starts. */
    const voidWidthAlongX = (z: number, cx: number, cy: number): number => {
      const cs = manifold.slice(z);
      const polys = cs.toPolygons() as unknown as [number, number][][];
      expect(inside(polys, cx, cy)).toBe(false); // sanity: the query point really is inside the cut (no material there)
      const extent = (sign: number): number => {
        let lo = 0;
        let hi = 20; // mm, comfortably past any screw-mount radius
        for (let i = 0; i < 40; i++) {
          const mid = (lo + hi) / 2;
          if (!inside(polys, cx + sign * mid, cy)) lo = mid;
          else hi = mid;
        }
        return lo;
      };
      return extent(1) + extent(-1);
    };

    const zBase = -d.flangeSpec.thickness;
    const zSlotMid = zBase + SCREW_MOUNT_SLOT_DEPTH / 2;
    const zUndercutStart = zBase + SCREW_MOUNT_SLOT_DEPTH + 0.15; // clear of the two levels' own hairline overlap (SCREW_MOUNT_LEVEL_OVERLAP)
    const zUndercutEnd = zBase + SCREW_MOUNT_RECESS_DEPTH - 0.1;
    const zUndercutMid = (zUndercutStart + zUndercutEnd) / 2;

    // Head hole (the wide, screw-head insertion circle): full head width at
    // the shallow level -- must be at least the head diameter.
    const headWidth = voidWidthAlongX(zSlotMid, slot.head.x, slot.head.y);
    expect(headWidth).toBeGreaterThanOrEqual(SCREW_MOUNT_HEAD_DIAMETER - 1e-6);

    // Slot (shank-rest end, shallow level): strictly between the shank and
    // head diameters -- narrow enough the head can't pull back out through
    // it, wide enough the shank travels freely.
    const slotWidth = voidWidthAlongX(zSlotMid, slot.shankEnd.x, slot.shankEnd.y);
    expect(slotWidth).toBeGreaterThan(SCREW_MOUNT_SHANK_DIAMETER);
    expect(slotWidth).toBeLessThan(SCREW_MOUNT_HEAD_DIAMETER);

    // Undercut (same shank-rest XY position, but at the DEEPER level):
    // wider than the slot, and at least head-diameter, across the WHOLE
    // depth span (checked at start/mid/end, not just one point), so the
    // head is genuinely captured there, not just at a single depth.
    expect(SCREW_MOUNT_UNDERCUT_DEPTH).toBeGreaterThanOrEqual(SCREW_MOUNT_HEAD_HEIGHT);
    for (const z of [zUndercutStart, zUndercutMid, zUndercutEnd]) {
      const undercutWidth = voidWidthAlongX(z, slot.shankEnd.x, slot.shankEnd.y);
      expect(undercutWidth).toBeGreaterThan(slotWidth);
      expect(undercutWidth).toBeGreaterThanOrEqual(SCREW_MOUNT_HEAD_DIAMETER - 1e-6);
    }

    manifold.delete();
  });
});

// --- Issue #70: through-hole mount ----------------------------------------

/** No real inner-end channel to avoid -- a stand-in far from the flange that never collides, for tests that aren't exercising the collision-avoidance behaviour itself. */
const noChannel = { hole: { x: 1e9, y: 1e9 }, holeRadius: 0, channelRibbon: [] };

describe("through-hole mount layout (issue #70)", () => {

  it("places one hole per corner for square/triangle, at the corner's own widest point", () => {
    for (const shape of [
      { kind: "sq" as const, n: 4 },
      { kind: "tri" as const, n: 3 },
    ]) {
      const outline = makeOutline(shape.kind, 100, 15);
      const boreOutline = makeOutline(shape.kind, 90, 12);
      const margin = requiredThroughMountMargin(outline, boreOutline, DEFAULT_THROUGH_HOLE_DIAMETER) + 1;
      const layout = layoutThroughHoleMount(outline, boreOutline, margin, DEFAULT_THROUGH_HOLE_DIAMETER, noChannel);
      expect(layout.holes).toHaveLength(shape.n);
      expect(layout.warning).toBeUndefined();
    }
  });

  it("evenly spaces 4 holes on a round flange (falls back to 3 only when 4 doesn't fit)", () => {
    const outline = makeOutline("round", 100, 50);
    const boreOutline = makeOutline("round", 90, 45);
    const margin = requiredThroughMountMargin(outline, boreOutline, DEFAULT_THROUGH_HOLE_DIAMETER) + 1;
    const layout = layoutThroughHoleMount(outline, boreOutline, margin, DEFAULT_THROUGH_HOLE_DIAMETER, noChannel);
    expect(layout.holes).toHaveLength(4);
    // Evenly spaced: every hole sits at the SAME radius, 90 degrees apart.
    const radii = layout.holes.map((h) => Math.hypot(h.x, h.y));
    for (const r of radii) expect(r).toBeCloseTo(radii[0], 6);
  });

  it("keeps every hole outside the wall's own outer surface (never undermining it) and inside the flange's own outer edge", () => {
    const outline = makeOutline("round", 100, 50);
    const boreOutline = makeOutline("round", 90, 45);
    const margin = requiredThroughMountMargin(outline, boreOutline, DEFAULT_THROUGH_HOLE_DIAMETER) + 1;
    const layout = layoutThroughHoleMount(outline, boreOutline, margin, DEFAULT_THROUGH_HOLE_DIAMETER, noChannel);
    for (const h of layout.holes) {
      const r = Math.hypot(h.x, h.y);
      expect(r - layout.counterboreRadius).toBeGreaterThan(outline.apothem); // clear of the wall's own outer surface, not just the bore
      expect(r + layout.counterboreRadius).toBeLessThan(outline.apothem + margin); // inside the flange's own outer edge
    }
  });

  it("requiredThroughMountMargin grows to fit a bigger hole diameter", () => {
    const outline = makeOutline("round", 40, 20);
    const boreOutline = makeOutline("round", 34, 17);
    const small = requiredThroughMountMargin(outline, boreOutline, 3);
    const big = requiredThroughMountMargin(outline, boreOutline, 8);
    expect(big).toBeGreaterThan(small);
  });

  it("design() bumps the flange margin/thickness (and warns) to fit the through-hole mount, and every hole is placed with no warning on a comfortably large core", async () => {
    const none = await design(baseSpec({ shape: { kind: "sq", cornerRadius: 15 }, coreSize: { locked: true, dimension: "outer", value: 100 } }));
    const d = await design(baseSpec({ shape: { kind: "sq", cornerRadius: 15 }, coreSize: { locked: true, dimension: "outer", value: 100 }, mount: "through" }));
    expect(d.flangeSpec.mount).toBe("through");
    expect(d.flangeSpec.thickness).toBeGreaterThanOrEqual(none.flangeSpec.thickness);
    expect(d.warnings.some((w) => /too narrow/i.test(w))).toBe(false);

    const layout = layoutThroughHoleMount(d.flangeSpec.outline, d.flangeSpec.boreOutline, d.flangeSpec.margin, DEFAULT_THROUGH_HOLE_DIAMETER, noChannel);
    expect(layout.holes).toHaveLength(4);
  });

  it("skips (and warns about) a corner too close to the inner-end cable channel, rather than cutting through it", () => {
    const outline = makeOutline("sq", 100, 15);
    const boreOutline = makeOutline("sq", 88, 12);
    const margin = requiredThroughMountMargin(outline, boreOutline, DEFAULT_THROUGH_HOLE_DIAMETER) + 1;
    // First, the real (unobstructed) layout, to find EXACTLY where corner 0's
    // own hole naturally sits (shapes.ts's own corner-i-at-standard-angle-
    // 2*pi*i/n convention -- corner 0 is at standard angle 0).
    const clear = layoutThroughHoleMount(outline, boreOutline, margin, DEFAULT_THROUGH_HOLE_DIAMETER, noChannel);
    expect(clear.holes).toHaveLength(4);
    const corner0Hole = clear.holes[0];

    // A channel footprint placed EXACTLY there, comfortably within the
    // required clearance.
    const collidingChannel = { hole: { x: corner0Hole.x, y: corner0Hole.y }, holeRadius: 2, channelRibbon: [] };
    const layout = layoutThroughHoleMount(outline, boreOutline, margin, DEFAULT_THROUGH_HOLE_DIAMETER, collidingChannel);
    expect(layout.holes.length).toBe(3); // corner 0 skipped, the other 3 corners keep their own holes
    expect(layout.warning).toMatch(/skipped/i);
    for (const h of layout.holes) {
      expect(Math.hypot(h.x - corner0Hole.x, h.y - corner0Hole.y)).toBeGreaterThan(layout.counterboreRadius);
    }
  });

  it("counterboreRadius grows with the requested hole diameter (THROUGH_MOUNT_COUNTERBORE_MARGIN added on top)", () => {
    const outline = makeOutline("round", 100, 50);
    const boreOutline = makeOutline("round", 90, 45);
    const layout = layoutThroughHoleMount(outline, boreOutline, 10, 6, noChannel);
    expect(layout.counterboreRadius).toBeCloseTo(6 / 2 + THROUGH_MOUNT_COUNTERBORE_MARGIN, 9);
    expect(layout.holeRadius).toBeCloseTo(3, 9);
  });
});

describe("through-hole mount mesh (issue #70): manifold, single-piece, across shapes", () => {
  const MOUNT_SPECS: Array<{ label: string; shape: CoilSpec["shape"] }> = [
    { label: "round", shape: { kind: "round" } },
    { label: "sq", shape: { kind: "sq", cornerRadius: 15 } },
    { label: "tri", shape: { kind: "tri", cornerRadius: 15 } },
  ];

  describe.each(MOUNT_SPECS)("$label core", ({ shape }) => {
    it("stays a single, valid solid with the through-holes cut (one extra genus per hole -- each is a genuine, separate tunnel through the flange, not just a blind pocket)", async () => {
      const d = await design(baseSpec({ shape, coreSize: { locked: true, dimension: "outer", value: 100 }, mount: "through" }));
      // The REAL inner-end channel (design()'s own layoutInnerEnd call, not
      // `noChannel`): a corner close to it can legitimately be skipped (see
      // the "skips ... a corner too close" test above), which changes how
      // many holes actually get cut -- recomputed here identically to how
      // design()/manifold.ts derive it, so this stays in sync rather than
      // assuming every corner always fits.
      const bendRadius = bendMultiplierOf(d.spec.wire) * d.spec.wire.diameter;
      const innerEndLayout = layoutInnerEnd(d.flangeSpec.outline, d.flangeSpec.margin, d.spec.wire.diameter, d.spec.tolerance, bendRadius);
      const layout = layoutThroughHoleMount(d.flangeSpec.outline, d.flangeSpec.boreOutline, d.flangeSpec.margin, DEFAULT_THROUGH_HOLE_DIAMETER, innerEndLayout, d.flangeSpec.envelopeRadius);
      expect(layout.holes.length).toBeGreaterThan(0);

      const wasm = await Module();
      wasm.setup();
      const manifold = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: d.mesh.positions, triVerts: d.mesh.indices }));
      try {
        expect(manifold.status()).toBe("NoError");
        expect(manifold.genus()).toBe(1 + layout.holes.length); // the bore's own tunnel (1) plus one independent tunnel per through-hole
        const pieces = manifold.decompose();
        try {
          expect(pieces.length).toBe(1); // no disconnected slivers
        } finally {
          for (const p of pieces) p.delete();
        }
      } finally {
        manifold.delete();
      }
    });
  });
});

// --- Hard clearance checks (PR review): every mount cutout, wherever one is
// actually placed, stays >= 2mm from the flange's own outer edge AND >= 2mm
// from the wall's own outer (winding) surface -- never just the hollow bore,
// which is NOT the same boundary (the flange's inner annulus, bore to the
// wall's own surface, sits directly below the solid wall tube and is not a
// safe place to cut -- see mount.ts's own `slotAt`/`holeAt` doc comments).
// Through-holes additionally stay >= 2mm outside the wound cable's own
// envelope, so they're genuinely reachable with a screwdriver. Checked
// through design() itself (the real, resolved geometry), across round/sq/tri,
// a range of sizes, and (for the keyhole) both rotations -- if a design run
// warns that the mount was skipped as too narrow, THAT is the "clear warning,
// no unsafe geometry" outcome this test accepts in place of a placed slot.
describe("hard clearance (issue #71/#70 PR review): >= 2mm to the flange edge, the wall's own outer surface, and (through-holes) the cable envelope", () => {
  const MIN_CLEARANCE = 2; // mm -- independent of SCREW_MOUNT_EDGE_MARGIN/THROUGH_MOUNT_EDGE_MARGIN's own value, a real external requirement
  const SHAPES: Array<{ label: string; shape: CoilSpec["shape"] }> = [
    { label: "round", shape: { kind: "round" } },
    { label: "sq", shape: { kind: "sq", cornerRadius: 15 } },
    { label: "tri", shape: { kind: "tri", cornerRadius: 15 } },
  ];
  const SIZES = [30, 60, 100, 200];

  describe.each(SHAPES)("$label core", ({ shape }) => {
    describe.each(SIZES)("size=%dmm", (size) => {
      for (const kr of [0, 45] as const) {
        it(`keyhole mount, rotation=${kr}`, async () => {
          const d = await design(baseSpec({ shape, coreSize: { locked: true, dimension: "outer", value: size }, mount: "keyhole", keyholeRotation: kr }));
          if (d.warnings.some((w) => /too narrow/i.test(w))) return; // graceful skip, with a clear warning -- the accepted alternative to unsafe geometry
          const layout = layoutKeyholeMount(d.flangeSpec.outline, d.flangeSpec.boreOutline, d.flangeSpec.margin, kr);
          expect(layout.slots.length).toBeGreaterThan(0);
          const flangeOutline = offsetOutline(d.flangeSpec.outline, d.flangeSpec.margin);
          for (const slot of layout.slots) {
            for (const p of [slot.head, slot.shankEnd]) {
              const r = Math.hypot(p.x, p.y);
              const phi = Math.atan2(p.y, p.x);
              const wallR = radiusAtAngle(d.flangeSpec.outline, phi);
              const flangeR = radiusAtAngle(flangeOutline, phi);
              // The cut's own widest reach at this point is SCREW_MOUNT_HEAD_RADIUS (issue #71's undercut -- see mount.ts).
              expect(r - SCREW_MOUNT_HEAD_DIAMETER / 2 - wallR).toBeGreaterThanOrEqual(MIN_CLEARANCE - 1e-6);
              expect(flangeR - (r + SCREW_MOUNT_HEAD_DIAMETER / 2)).toBeGreaterThanOrEqual(MIN_CLEARANCE - 1e-6);
            }
          }
        });
      }

      it("through-hole mount", async () => {
        const d = await design(baseSpec({ shape, coreSize: { locked: true, dimension: "outer", value: size }, mount: "through" }));
        if (d.warnings.some((w) => /too narrow/i.test(w))) return;
        const bendRadius = bendMultiplierOf(d.spec.wire) * d.spec.wire.diameter;
        const innerEndLayout = layoutInnerEnd(d.flangeSpec.outline, d.flangeSpec.margin, d.spec.wire.diameter, d.spec.tolerance, bendRadius);
        const envelopeRadius = d.flangeSpec.envelopeRadius ?? 0;
        const layout = layoutThroughHoleMount(d.flangeSpec.outline, d.flangeSpec.boreOutline, d.flangeSpec.margin, d.spec.throughHoleDiameter, innerEndLayout, envelopeRadius);
        expect(layout.holes.length).toBeGreaterThan(0);
        const flangeOutline = offsetOutline(d.flangeSpec.outline, d.flangeSpec.margin);
        for (const h of layout.holes) {
          const r = Math.hypot(h.x, h.y);
          const phi = Math.atan2(h.y, h.x);
          const wallR = radiusAtAngle(d.flangeSpec.outline, phi);
          const flangeR = radiusAtAngle(flangeOutline, phi);
          expect(r - layout.counterboreRadius - wallR).toBeGreaterThanOrEqual(MIN_CLEARANCE - 1e-6);
          expect(r - layout.counterboreRadius - envelopeRadius).toBeGreaterThanOrEqual(MIN_CLEARANCE - 1e-6); // reachable with a screwdriver, outside the wound cable
          expect(flangeR - (r + layout.counterboreRadius)).toBeGreaterThanOrEqual(MIN_CLEARANCE - 1e-6);
        }
      });
    });
  });
});
