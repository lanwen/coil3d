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
import { design, parseHash } from "../src/core";
import type { CoilSpec } from "../src/core";
import {
  DEFAULT_THROUGH_HOLE_DIAMETER,
  SCREW_MOUNT_HEAD_DIAMETER,
  SCREW_MOUNT_HEAD_HEIGHT,
  SCREW_MOUNT_RECESS_DEPTH,
  SCREW_MOUNT_SHANK_DIAMETER,
  SCREW_MOUNT_SLOT_DEPTH,
  SCREW_MOUNT_UNDERCUT_DEPTH,
  THROUGH_MOUNT_EDGE_MARGIN,
} from "../src/core/constants";
import { distanceToClosedPolygon, layoutKeyholeMount, layoutThroughHoleMount, requiredFlangeMargin, requiredThroughMountMargin } from "../src/core/mount";
import { layoutInnerEnd } from "../src/core/innerEnd";
import { layoutFlangeThroughHoles } from "../src/core/flangePads";
import { makeOutline, offsetOutline, radiusAtAngle } from "../src/core/shapes";
import { bendMultiplierOf } from "../src/core/types";
import { bruteForceRadiusAtAngle, coarseOutlineScan } from "./support/bruteForceRadius";
import { KEYHOLE_ROOF_MAX_SPAN } from "./support/keyholeBridge";

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
    base: "on",
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

// --- Issue #120: two reported mount bugs -----------------------------------
//
// (1) keyhole rotation 0 vs 45 produced NO visible change for a triangle
// core: `candidateAxisDegs` only ever gives a triangle 2 reachable axes
// (its own +-30 degree corner/side pair), and the one closest to literal 45
// was ALWAYS the same axis the automatic (cheapest) pick already used --
// `bestAxisDeg` picked purely by distance-to-request with no regard for
// what the automatic case already chose. Fixed by excluding the automatic
// axis from the candidates a non-zero request can land on, whenever a
// second one is reachable at all (mount.ts's `bestAxisDeg`).
//
// (2) the SKÅDIS mount silently disappeared (only a general warning)
// whenever the auto-solved -- or a small, locked -- core came out too small
// for it: unlike the keyhole/through-hole mounts, nothing grew the flange
// margin to guarantee a fit. Fixed by growing the margin in `flange.ts`'s
// `resolveFlangeSizing` exactly like the other two mount kinds (since issue
// #207, for the rim clips: `requiredSkadisMargin`).
describe("issue #120: keyhole rotation and SKÅDIS mount regressions", () => {
  it("a triangle core: keyholeRotation 0 vs 45 land on genuinely different axes and slot positions (previously identical -- confirmed bug)", async () => {
    const specs = [0, 45] as const;
    const results = await Promise.all(
      specs.map((kr) =>
        design(
          baseSpec({
            shape: { kind: "tri", cornerRadius: 15 },
            coreSize: { locked: true, dimension: "outer", value: 100 },
            mount: "keyhole",
            keyholeRotation: kr,
          }),
        ),
      ),
    );
    const [atZero, at45] = results;
    expect(atZero.mountAxisDeg).not.toBeCloseTo(at45.mountAxisDeg!, 6);

    const layoutAt = (d: (typeof results)[number], kr: 0 | 45) => layoutKeyholeMount(d.flangeSpec.outline, d.flangeSpec.boreOutline, d.flangeSpec.margin, kr);
    const slotsZero = layoutAt(atZero, 0).slots;
    const slots45 = layoutAt(at45, 45).slots;
    expect(slotsZero.length).toBeGreaterThan(0);
    expect(slots45.length).toBe(slotsZero.length);
    // At least one slot actually moved -- not just a coincidental relabeling.
    const moved = slots45.some((s, i) => Math.hypot(s.head.x - slotsZero[i].head.x, s.head.y - slotsZero[i].head.y) > 1e-3);
    expect(moved).toBe(true);
  });

  it("a small triangle core also differs between rotations (single-slot case, not just the 2-slot square already covered above)", async () => {
    const d0 = await design(baseSpec({ shape: { kind: "tri", cornerRadius: 15 }, coreSize: { locked: true, dimension: "outer", value: 50 }, mount: "keyhole", keyholeRotation: 0 }));
    const d45 = await design(baseSpec({ shape: { kind: "tri", cornerRadius: 15 }, coreSize: { locked: true, dimension: "outer", value: 50 }, mount: "keyhole", keyholeRotation: 45 }));
    expect(d0.mountAxisDeg).not.toBeCloseTo(d45.mountAxisDeg!, 6);
  });

  // The issue's own SKÅDIS repro hash: a round core, height locked at 33mm,
  // core size and layers free (solver-picked), top cap on, mount=skadis --
  // decoded from `#s=eyJ2IjoyLCJMIjoxMDAwLCJkIjoyLjQsImgiOjMzLCJsb2NrIjpb
  // ImgiXSwiY2FwIjoib24iLCJtb3VudCI6InNrYWRpcyIsImJ4Ijo1NzYsImJ5Ijo1NDcsImJ6
  // Ijo1NzV9`.
  it("the issue's own SKÅDIS repro (round core, h locked 33, cap on, solver-picked size) builds the clips, not a silent skip", async () => {
    const hash =
      "#s=eyJ2IjoyLCJMIjoxMDAwLCJkIjoyLjQsImgiOjMzLCJsb2NrIjpbImgiXSwiY2FwIjoib24iLCJtb3VudCI6InNrYWRpcyIsImJ4Ijo1NzYsImJ5Ijo1NDcsImJ6Ijo1NzV9";
    const { spec, notice } = parseHash(hash);
    expect(notice).toBeUndefined();
    const d = await design(spec);
    expect(d.warnings.some((w) => /too small/i.test(w))).toBe(false);
    expect(d.parts.filter((p) => p.role === "mountClip").length).toBeGreaterThanOrEqual(2);
  });

  it("a small, locked core still fits the SKÅDIS clips by growing the flange margin, across shapes (never a silent skip)", async () => {
    for (const shape of [{ kind: "round" as const }, { kind: "sq" as const, cornerRadius: 5 }, { kind: "tri" as const, cornerRadius: 5 }]) {
      const d = await design(baseSpec({ shape, mount: "skadis", coreSize: { locked: true, dimension: "outer", value: 12 }, height: { locked: true, value: 20 } }));
      const clips = d.parts.filter((p) => p.role === "mountClip").length;
      // The raised triangle core is only 28.4 mm across (2.6 x d bend radius): too small for two rim clips, so
      // they are left out -- but never silently, there is a warning that says so.
      if (shape.kind === "tri") {
        expect(clips > 0 || d.warnings.some((w) => /too small or too crowded for the SKÅDIS rim clips, so they were left out/.test(w))).toBe(true);
        continue;
      }
      expect(d.warnings.some((w) => /too small/i.test(w))).toBe(false);
      expect(clips).toBeGreaterThanOrEqual(2);
    }
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

// --- Issue #175: the undercut's roof, an accepted bridge -----------------

describe("keyhole mount undercut roof (issue #175): the only overhang is the accepted flat roof, at most KEYHOLE_ROOF_MAX_SPAN across", () => {
  // The core prints flange down, so the keyhole is cut into the bed face and
  // its undercut's flat roof is a bridge over a closed chamber, as wide as
  // the screw head. That bridge is accepted by design (maintainer decision,
  // #175; see test/support/keyholeBridge.ts). This guard keeps it that way:
  // every face in the cut that faces down, sits above the bed and leans past
  // 45 deg (with test/printability's tessellation slack) must be the roof
  // itself -- flat, at SCREW_MOUNT_RECESS_DEPTH above the bed -- and the
  // roof spans at most KEYHOLE_ROOF_MAX_SPAN across the slot's axis.
  const MAX_OVERHANG_DEG = 45 + 1.5;
  const SHAPES: CoilSpec["shape"][] = [{ kind: "round" }, { kind: "sq", cornerRadius: 12 }, { kind: "tri", cornerRadius: 12 }];
  const CASES = SHAPES.flatMap((shape) =>
    [0, 45].flatMap((keyholeRotation) => [50, 100].map((size) => ({ label: `${shape.kind}, rotation ${keyholeRotation}, ${size} mm`, shape, keyholeRotation, size }))),
  );

  it.each(CASES)("$label", async ({ shape, keyholeRotation, size }) => {
    const d = await design(baseSpec({ shape, mount: "keyhole", keyholeRotation: keyholeRotation as 0 | 45, coreSize: { locked: true, dimension: "outer", value: size } }));
    const f = d.flangeSpec;
    const { slots } = layoutKeyholeMount(f.outline, f.boreOutline, f.margin, f.keyholeRotation);
    expect(slots.length).toBeGreaterThan(0);
    const core = d.parts.find((p) => p.role === "core")!;
    // The core prints as assembled, flange face on the bed (z = -thickness).
    const bedZ = -f.thickness;
    const p = core.mesh.positions;
    const tris = core.mesh.indices;
    // Distance in XY from the slot's axis segment (head -> shankEnd).
    const fromAxis = (x: number, y: number, s: (typeof slots)[number]) => {
      const ex = s.shankEnd.x - s.head.x;
      const ey = s.shankEnd.y - s.head.y;
      const t = Math.max(0, Math.min(1, ((x - s.head.x) * ex + (y - s.head.y) * ey) / (ex * ex + ey * ey)));
      return Math.hypot(x - s.head.x - t * ex, y - s.head.y - t * ey);
    };
    const roofZ = bedZ + SCREW_MOUNT_RECESS_DEPTH;
    let span = 0;
    let flagged = 0;
    let offRoof = 0;
    for (let t3 = 0; t3 < tris.length; t3 += 3) {
      const [a, b, c] = [tris[t3] * 3, tris[t3 + 1] * 3, tris[t3 + 2] * 3];
      const minZ = Math.min(p[a + 2], p[b + 2], p[c + 2]);
      if (minZ <= bedZ + 0.05 || minZ > 0) continue; // on the bed itself, or above the flange
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 2e-3 || nz >= 0) continue;
      if ((Math.asin(Math.min(1, -nz / len)) * 180) / Math.PI <= MAX_OVERHANG_DEG) continue;
      const cx = (p[a] + p[b] + p[c]) / 3;
      const cy = (p[a + 1] + p[b + 1] + p[c + 1]) / 3;
      const slot = slots.find((s) => fromAxis(cx, cy, s) < SCREW_MOUNT_HEAD_DIAMETER);
      if (!slot) continue;
      flagged++;
      for (const v of [a, b, c]) {
        span = Math.max(span, 2 * fromAxis(p[v], p[v + 1], slot));
        if (Math.abs(p[v + 2] - roofZ) > 1e-3) offRoof++;
      }
    }
    expect(flagged).toBeGreaterThan(0); // the cut is there, and its roof is found
    expect(offRoof).toBe(0); // nothing else in the keyhole overhangs
    expect(span).toBeGreaterThanOrEqual(SCREW_MOUNT_HEAD_DIAMETER - 1e-3); // the head-width roof, measured
    expect(span).toBeLessThanOrEqual(KEYHOLE_ROOF_MAX_SPAN);
  });
});

// --- Issue #70: through-hole mount ----------------------------------------

/** No real inner-end channel to avoid -- a stand-in far from the flange that never collides, for tests that aren't exercising the collision-avoidance behaviour itself. */
const noChannel = { channelRibbon: [] };

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
      expect(r - layout.holeRadius).toBeGreaterThan(outline.apothem); // clear of the wall's own outer surface, not just the bore
      expect(r + layout.holeRadius).toBeLessThan(outline.apothem + margin); // inside the flange's own outer edge
    }
  });

  it("requiredThroughMountMargin grows to fit a bigger hole diameter", () => {
    const outline = makeOutline("round", 40, 20);
    const boreOutline = makeOutline("round", 34, 17);
    const small = requiredThroughMountMargin(outline, boreOutline, 3);
    const big = requiredThroughMountMargin(outline, boreOutline, 8);
    expect(big).toBeGreaterThan(small);
  });

  it("design() bumps the flange margin (never the thickness -- issue #129, no counterbore) to fit the through-hole mount, and every hole is placed with no warning on a comfortably large core", async () => {
    const none = await design(baseSpec({ shape: { kind: "sq", cornerRadius: 15 }, coreSize: { locked: true, dimension: "outer", value: 100 } }));
    const d = await design(baseSpec({ shape: { kind: "sq", cornerRadius: 15 }, coreSize: { locked: true, dimension: "outer", value: 100 }, mount: "through" }));
    expect(d.flangeSpec.mount).toBe("through");
    // Issue #129: the through-hole mount is a plain hole with no counterbore
    // any more, so it needs no thickness floor of its own -- the flange is
    // exactly as thick as it would be with no mount at all.
    expect(d.flangeSpec.thickness).toBeCloseTo(none.flangeSpec.thickness, 9);
    expect(d.warnings.some((w) => /too narrow/i.test(w))).toBe(false);
    expect(d.warnings.some((w) => /thickness increased/i.test(w))).toBe(false);

    const layout = layoutThroughHoleMount(d.flangeSpec.outline, d.flangeSpec.boreOutline, d.flangeSpec.margin, DEFAULT_THROUGH_HOLE_DIAMETER, noChannel);
    expect(layout.holes).toHaveLength(4);
  });

  it("turns a corner's hole round its corner to clear the inner-end cable channel, and skips (and warns about) it only when that can't (issue #239)", () => {
    const outline = makeOutline("sq", 100, 15);
    const boreOutline = makeOutline("sq", 88, 12);
    const margin = requiredThroughMountMargin(outline, boreOutline, DEFAULT_THROUGH_HOLE_DIAMETER) + 1;
    // First, the real (unobstructed) layout, to find EXACTLY where corner 0's
    // own hole naturally sits (shapes.ts's own corner-i-at-standard-angle-
    // 2*pi*i/n convention -- corner 0 is at standard angle 0).
    const clear = layoutThroughHoleMount(outline, boreOutline, margin, DEFAULT_THROUGH_HOLE_DIAMETER, noChannel);
    expect(clear.holes).toHaveLength(4);
    const corner0Hole = clear.holes[0];
    expect(Math.atan2(corner0Hole.y, corner0Hole.x)).toBeCloseTo(0, 9);

    const square = (c: { x: number; y: number }, half: number) => [
      { x: c.x - half, y: c.y - half },
      { x: c.x + half, y: c.y - half },
      { x: c.x + half, y: c.y + half },
      { x: c.x - half, y: c.y + half },
    ];
    // A small channel footprint right there: the hole turns round the corner, clear of it.
    const small = square(corner0Hole, 1);
    const nudged = layoutThroughHoleMount(outline, boreOutline, margin, DEFAULT_THROUGH_HOLE_DIAMETER, { channelRibbon: small });
    expect(nudged.holes.length).toBe(4);
    expect(nudged.warning).toBeUndefined();
    const moved = nudged.holes[0];
    expect(Math.abs(Math.atan2(moved.y, moved.x))).toBeGreaterThan(0.01);
    expect(distanceToClosedPolygon(moved.x, moved.y, small)).toBeGreaterThanOrEqual(nudged.holeRadius + THROUGH_MOUNT_EDGE_MARGIN - 1e-9);

    // One covering the whole corner: corner 0 is skipped, the other 3 corners keep their own holes.
    const big = square(corner0Hole, 20);
    const layout = layoutThroughHoleMount(outline, boreOutline, margin, DEFAULT_THROUGH_HOLE_DIAMETER, { channelRibbon: big });
    expect(layout.holes.length).toBe(3);
    expect(layout.warning).toMatch(/skipped/i);
    for (const h of layout.holes) {
      expect(Math.hypot(h.x - corner0Hole.x, h.y - corner0Hole.y)).toBeGreaterThan(layout.holeRadius);
    }
  });

  it("holeRadius is exactly half the requested hole diameter (issue #129: no counterbore margin added on top)", () => {
    const outline = makeOutline("round", 100, 50);
    const boreOutline = makeOutline("round", 90, 45);
    const layout = layoutThroughHoleMount(outline, boreOutline, 10, 6, noChannel);
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
      const layout = layoutFlangeThroughHoles(d.flangeSpec, innerEndLayout);
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
// (Issue #239: through-holes may sit under the winding now, countersunk.) Checked
// through design() itself (the real, resolved geometry), across round/sq/tri,
// a range of sizes, and (for the keyhole) both rotations -- if a design run
// warns that the mount was skipped as too narrow, THAT is the "clear warning,
// no unsafe geometry" outcome this test accepts in place of a placed slot.
describe("hard clearance (issue #71/#70 PR review): >= 2mm to the flange edge and the wall's own outer surface", () => {
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
        const layout = layoutFlangeThroughHoles(d.flangeSpec, innerEndLayout);
        expect(layout.holes.length).toBeGreaterThan(0);
        const flangeOutline = offsetOutline(d.flangeSpec.outline, d.flangeSpec.margin);
        for (const h of layout.holes) {
          const r = Math.hypot(h.x, h.y);
          const phi = Math.atan2(h.y, h.x);
          const wallR = radiusAtAngle(d.flangeSpec.outline, phi);
          const flangeR = radiusAtAngle(flangeOutline, phi);
          expect(r - layout.holeRadius - wallR).toBeGreaterThanOrEqual(MIN_CLEARANCE - 1e-6);
          expect(flangeR - (r + layout.holeRadius)).toBeGreaterThanOrEqual(MIN_CLEARANCE - 1e-6);
        }
      });
    });
  });
});

// --- Issue #92: large flange margins and large corner radii ("big offsets")
//
// The clearance checks above route through `radiusAtAngle` on BOTH sides
// (the layout functions AND the assertions), so a shared bug in that
// function couldn't have shown up there -- self-consistent, not
// independent. This describe instead checks every keyhole/through-hole
// placement against test/support/bruteForceRadius.ts's own oracle (a direct
// `pointAt` bisection, sharing none of `radiusAtAngle`'s classification
// logic) -- AND drives the margin itself through mount.ts's own
// `requiredFlangeMargin`/`requiredThroughMountMargin` (never a manually
// chosen value), because that bisection is exactly where issue #92's bug
// bit in practice: it calls `radiusAtAngle` in its own inner loop, so a
// wrong classification there converges the search to a WRONG (too small)
// margin instead of merely reporting a wrong number. Confirmed against this
// exact test, pre-fix: `sq, cornerRadius=15, size=60, keyholeRotation=0`
// converged `requiredFlangeMargin` to a margin that, measured against the
// independent oracle, put the wall-side clearance at -7.76mm (the cut
// actually broke through the wall's own outer surface) -- not merely
// "less generous than it could be", a genuine violation of the >= 2mm
// guarantee. Every combination below passes with the fix; this is the
// regression guard that a future change to `radiusAtAngle` can't quietly
// reopen it.
describe("hard clearance holds through requiredFlangeMargin/requiredThroughMountMargin at large sizes and corner radii (issue #92)", () => {
  const MIN_CLEARANCE = 2; // mm, same external requirement as the describe above
  const KINDS = ["sq", "tri"] as const;
  const SIZES = [30, 60, 100, 200, 400];
  // Fractions of maxCornerRadius (size/2): spans small, moderate (the
  // pre-fix failing case, cornerRadius=15 at size=60 is exactly crFrac=0.5),
  // and near-fully-rounded corners -- the regime where `cornerRadius` grows
  // large relative to `Rc` (see shapes.ts's `radiusAtAngle` doc comment).
  const CR_FRACTIONS = [0.1, 0.3, 0.5, 0.7, 0.9, 0.99];

  for (const kind of KINDS) {
    describe(kind, () => {
      describe.each(SIZES)("size=%dmm", (size) => {
        describe.each(CR_FRACTIONS)("cornerRadius=%p * maxCornerRadius", (crFrac) => {
          const cornerRadius = (size / 2) * crFrac;
          const outline = makeOutline(kind, size, cornerRadius);
          const boreOutline = makeOutline(kind, size * 0.7, cornerRadius * 0.7);
          const wallScan = coarseOutlineScan(outline, 0);

          for (const kr of [0, 45] as const) {
            it(`keyhole mount, rotation=${kr}`, () => {
              const margin = requiredFlangeMargin(outline, boreOutline, kr);
              const layout = layoutKeyholeMount(outline, boreOutline, margin, kr);
              expect(layout.slots.length).toBeGreaterThan(0); // requiredFlangeMargin's own contract: enough margin to place it
              const flangeScan = coarseOutlineScan(outline, margin);
              for (const slot of layout.slots) {
                for (const p of [slot.head, slot.shankEnd]) {
                  const r = Math.hypot(p.x, p.y);
                  const phi = Math.atan2(p.y, p.x);
                  const wallR = bruteForceRadiusAtAngle(wallScan, outline, 0, phi);
                  const flangeR = bruteForceRadiusAtAngle(flangeScan, outline, margin, phi);
                  expect(r - SCREW_MOUNT_HEAD_DIAMETER / 2 - wallR, `wall clearance, phi=${phi.toFixed(4)}`).toBeGreaterThanOrEqual(MIN_CLEARANCE - 1e-6);
                  expect(flangeR - (r + SCREW_MOUNT_HEAD_DIAMETER / 2), `flange-edge clearance, phi=${phi.toFixed(4)}`).toBeGreaterThanOrEqual(MIN_CLEARANCE - 1e-6);
                }
              }
            });
          }

          it("through-hole mount", () => {
            const margin = requiredThroughMountMargin(outline, boreOutline, DEFAULT_THROUGH_HOLE_DIAMETER);
            const layout = layoutThroughHoleMount(outline, boreOutline, margin, DEFAULT_THROUGH_HOLE_DIAMETER, noChannel);
            expect(layout.holes.length).toBeGreaterThan(0);
            const flangeScan = coarseOutlineScan(outline, margin);
            for (const h of layout.holes) {
              const r = Math.hypot(h.x, h.y);
              const phi = Math.atan2(h.y, h.x);
              const wallR = bruteForceRadiusAtAngle(wallScan, outline, 0, phi);
              const flangeR = bruteForceRadiusAtAngle(flangeScan, outline, margin, phi);
              expect(r - layout.holeRadius - wallR, `wall clearance, phi=${phi.toFixed(4)}`).toBeGreaterThanOrEqual(MIN_CLEARANCE - 1e-6);
              expect(flangeR - (r + layout.holeRadius), `flange-edge clearance, phi=${phi.toFixed(4)}`).toBeGreaterThanOrEqual(MIN_CLEARANCE - 1e-6);
            }
          });
        });
      });
    });
  }
});
