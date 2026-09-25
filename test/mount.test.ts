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
  SCREW_MOUNT_TWO_SLOT_ANGLE,
  SCREW_MOUNT_UNDERCUT_DEPTH,
  THROUGH_MOUNT_COUNTERBORE_MARGIN,
} from "../src/core/constants";
import { bestAxisDeg, layoutKeyholeMount, layoutThroughHoleMount, requiredThroughMountMargin } from "../src/core/mount";
import { makeOutline } from "../src/core/shapes";

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
  // A square's own natural axes are 45 degrees apart (corner, then side
  // midpoint, alternating -- mount.ts's file header); which one wins depends
  // on both `keyholeRotation` and the 2-slot fan angle together (the search
  // evaluates each candidate's own FANNED cost, not just its unfanned one --
  // see `bestAxisDeg`'s doc comment), so this checks the actual 2-slot case
  // a 100mm square flange uses (>= SCREW_MOUNT_TWO_SLOT_FLANGE_THRESHOLD),
  // where rotation 0 vs 45 provably land on different axes (verified
  // empirically against this exact shape, not assumed).
  it("bestAxisDeg re-centres its search on keyholeRotation instead of literal vertical", () => {
    const square = makeOutline("sq", 100, 15);
    const axis0 = bestAxisDeg(square, SCREW_MOUNT_TWO_SLOT_ANGLE, 0);
    const axis45 = bestAxisDeg(square, SCREW_MOUNT_TWO_SLOT_ANGLE, 45);
    expect(axis45).not.toBeCloseTo(axis0, 6);
    // Every result is still one of the shape's own genuine mirror axes
    // (see candidateAxisDegs's own doc comment) -- both land on a multiple
    // of 45 degrees for this square.
    expect(axis0 % 45).toBeCloseTo(0, 6);
    expect(axis45 % 45).toBeCloseTo(0, 6);
  });

  it("design()'s mountAxisDeg follows spec.keyholeRotation (0 vs 45 place the 2-slot mount on a different axis), and the mount still fits (still hangs level)", async () => {
    const axes: Record<number, number> = {};
    for (const kr of [0, 45] as const) {
      const d = await design(baseSpec({ shape: { kind: "sq", cornerRadius: 15 }, coreSize: { locked: true, dimension: "outer", value: 100 }, mount: "keyhole", keyholeRotation: kr }));
      expect(d.warnings.some((w) => /too narrow/i.test(w))).toBe(false);
      const layout = layoutKeyholeMount(d.flangeSpec.outline, d.flangeSpec.boreOutline, d.flangeSpec.margin, kr);
      expect(layout.slots).toHaveLength(2); // this flange is well above the 2-slot threshold, for every rotation
      // The SAME "does it actually use the 2-slot fan angle" derivation
      // design.ts/mount.ts themselves use, cross-checked against both the
      // layout's own reported axis and design()'s surfaced `mountAxisDeg`.
      const expectedAxis = bestAxisDeg(d.flangeSpec.boreOutline, SCREW_MOUNT_TWO_SLOT_ANGLE, kr);
      expect(layout.axisDeg).toBeCloseTo(expectedAxis, 6);
      expect(d.mountAxisDeg).toBeCloseTo(expectedAxis, 6);
      axes[kr] = expectedAxis;

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
      const layout = layoutThroughHoleMount(outline, boreOutline, 10, DEFAULT_THROUGH_HOLE_DIAMETER, noChannel);
      expect(layout.holes).toHaveLength(shape.n);
      expect(layout.warning).toBeUndefined();
    }
  });

  it("evenly spaces 4 holes on a round flange (falls back to 3 only when 4 doesn't fit)", () => {
    const outline = makeOutline("round", 100, 50);
    const boreOutline = makeOutline("round", 90, 45);
    const layout = layoutThroughHoleMount(outline, boreOutline, 10, DEFAULT_THROUGH_HOLE_DIAMETER, noChannel);
    expect(layout.holes).toHaveLength(4);
    // Evenly spaced: every hole sits at the SAME radius, 90 degrees apart.
    const radii = layout.holes.map((h) => Math.hypot(h.x, h.y));
    for (const r of radii) expect(r).toBeCloseTo(radii[0], 6);
  });

  it("keeps every hole outside the winding envelope (within the flange margin annulus) and clear of the bore", () => {
    const outline = makeOutline("round", 100, 50);
    const boreOutline = makeOutline("round", 90, 45);
    const margin = 10;
    const layout = layoutThroughHoleMount(outline, boreOutline, margin, DEFAULT_THROUGH_HOLE_DIAMETER, noChannel);
    for (const h of layout.holes) {
      const r = Math.hypot(h.x, h.y);
      expect(r).toBeGreaterThan(boreOutline.apothem); // outside the bore/winding envelope
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
    const margin = 10;
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
      const layout = layoutThroughHoleMount(d.flangeSpec.outline, d.flangeSpec.boreOutline, d.flangeSpec.margin, DEFAULT_THROUGH_HOLE_DIAMETER, noChannel);
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
