import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { design, parseHash } from "../src/core";
import { dimensionAxesGeometry, measureDimensionFrame } from "../src/viewer/dimensionGeometry";
import { frontFacingDimensionSpin } from "../src/viewer/frontFacing";
import { encodeHashDoc } from "../e2e/hashDoc";

// Issue #93: the viewer's dimension axes are fixed geometry on the model's
// flats-aligned bounding box. Built here from real design() parts, the same
// way CoilViewer builds them for the standing view (Front/Iso).

const CASES = [
  ["round", encodeHashDoc({ L: 5000, d: 3.8, lock: ["outer", "h"], size: 60, h: 60, cap: "on" })],
  ["sq", encodeHashDoc({ L: 6000, d: 3.8, lock: ["outer", "h"], size: 60, h: 60, cap: "on", shape: "sq", rc: 15 })],
  ["tri", encodeHashDoc({ L: 6000, d: 3.8, lock: ["outer", "h"], size: 60, h: 60, cap: "on", shape: "tri", rc: 15 })],
] as const;

// The Iso camera (presets.ts: from (1, -1, 0.9), z up), screen right and toward it.
const ISO_TOWARD = new THREE.Vector3(1, -1, 0.9).normalize();
const ISO_RIGHT = new THREE.Vector3(0, 0, 1).cross(ISO_TOWARD).normalize();

describe("dimension axes geometry (issue #93)", () => {
  for (const [kind, hash] of CASES) {
    it(`${kind}: each axis spans exactly the box's extent along its own edge, from the front-left-bottom corner`, async () => {
      const d = await design(parseHash(hash).spec);
      const { box, groundZ } = measureDimensionFrame(d.parts, frontFacingDimensionSpin(kind));
      // Standing, the box's frame is the world's (the spin cancels the mesh's own front-facing rotation).
      const axes = dimensionAxesGeometry(box, groundZ, ISO_RIGHT, ISO_TOWARD);
      const size = box.getSize(new THREE.Vector3());
      const [width, depth, height] = axes.arms;
      expect(axes.arms.map((a) => a.id)).toEqual(["width", "depth", "height"]);
      expect(width.from.distanceTo(width.to)).toBeCloseTo(size.x, 6);
      expect(depth.from.distanceTo(depth.to)).toBeCloseTo(size.y, 6);
      expect(height.from.distanceTo(height.to)).toBeCloseTo(size.z, 6);
      // Along the box's X, Y and Z edges.
      expect(width.to.clone().sub(width.from).normalize().distanceTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-9);
      expect(depth.to.clone().sub(depth.from).normalize().distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-9);
      expect(height.to.clone().sub(height.from).normalize().distanceTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-9);
      // The origin: the front-left-bottom corner (-X, -Y, the lowest point), a gap out on every axis.
      const g = axes.gap;
      expect(g).toBeGreaterThan(0);
      expect(g).toBeLessThan(0.1 * Math.max(size.x, size.y) + 4);
      expect(axes.origin.toArray()).toEqual([box.min.x - g, box.min.y - g, Math.min(groundZ, box.min.z) - g]);
      expect(width.from.toArray()).toEqual([box.min.x, box.min.y - g, axes.origin.z]);
      expect(depth.from.toArray()).toEqual([box.min.x - g, box.min.y, axes.origin.z]);
      expect(height.from.toArray()).toEqual([box.min.x - g, box.min.y - g, box.min.z]);
      // Flats-aligned: the square's width and depth are its across-flats flange width.
      const flats = d.solution.flangeExtent!.acrossFlats;
      if (kind !== "tri") {
        expect(size.x).toBeCloseTo(flats, 1);
        expect(size.y).toBeCloseTo(flats, 1);
      } else {
        // A triangle standing on a flat: its box is the flat's width by base-to-apex height.
        expect(Math.min(size.x, size.y)).toBeGreaterThan(flats - 0.5);
        expect(Math.max(size.x, size.y)).toBeLessThan(d.solution.flangeExtent!.acrossCorners + 0.5);
      }
    });
  }
});
