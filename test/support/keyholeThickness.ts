import Module from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import { design } from "../../src/core";
import type { CoilSpec } from "../../src/core";
import { fuseFlange } from "../../src/core/manifold";
import { buildWall } from "../../src/core/wall";

export type KeyholeSweepSpec = { label: string; shape: CoilSpec["shape"]; coreSize: number };

// Starts just past SCREW_MOUNT_RECESS_DEPTH (3mm): AT or below that, the
// recess breaks all the way through the flange by construction (a real, but
// different and much coarser, geometric limit -- not this issue's
// floating-point robustness bug -- so it's out of scope here and genuinely
// does raise the genus). Steps of 0.1mm: the failure this pins is a
// floating-point robustness issue that only shows up at scattered, seemingly
// arbitrary thickness values (not a clean contiguous band) -- a coarser step
// (0.5mm was tried first) silently skipped every one of them and passed even
// against the unfixed code. The values come from the same accumulating `+=
// 0.1` loop the sweep always used, so the exact floats are unchanged.
const THICKNESSES: number[] = [];
for (let thickness = 3.5; thickness <= 14; thickness += 0.1) THICKNESSES.push(thickness);

// One fuseFlange per thickness is ~0.2s, so a whole sweep is ~20s. Cut into
// slices of ~26 thicknesses: each slice is its own case (a few seconds, well
// inside its limit even under a loaded full run), and none of the 106
// thicknesses is dropped.
const SLICES = 4;
const SLICE_SIZE = Math.ceil(THICKNESSES.length / SLICES);
const slices = Array.from({ length: SLICES }, (_, i) => THICKNESSES.slice(i * SLICE_SIZE, (i + 1) * SLICE_SIZE)).map((values) => ({
  values,
  range: `${values[0].toFixed(1)}-${values[values.length - 1].toFixed(1)}mm`,
}));

// Issue #41: manifold-3d boolean robustness of the screw-mount recess cut
// across flange thickness. `design()` itself can't vary the flange's
// thickness today (it's pinned to MIN_FLANGE_THICKNESS_FOR_SCREW_MOUNT, 5mm,
// for every "keyhole" spec -- see design.ts), so the failing thickness band
// this bug lives in (~7.3mm+) isn't reachable through the public interface
// yet -- only once a future ticket (e.g. #43's auto flange thickness) grows
// it. These tests build the SAME wall/flange design() would (via its own
// public `wallSpec`/`flangeSpec`, not a reimplementation) and call the
// exported `fuseFlange`/`buildWall` "flange path" directly, only overriding
// `thickness`, to pin the fix ahead of that future ticket actually reaching
// it -- the closest a vitest can get to "through the public interface" for a
// path design() can't drive yet.
export function describeKeyholeThicknessSweep(specs: KeyholeSweepSpec[]): void {
  describe("fuseFlange screw-keyhole recess cut across flange thickness (issue #41)", () => {
    describe.each(specs)("$label", ({ shape, coreSize }) => {
      let wall: ReturnType<typeof buildWall>;
      let flangeSpec: Awaited<ReturnType<typeof design>>["flangeSpec"];
      let wasm: Awaited<ReturnType<typeof Module>>;

      beforeAll(async () => {
        const spec: CoilSpec = {
          wire: { length: 2000, diameter: 3.8, type: "usb" },
          shape,
          windingQuality: 0.7,
          coreSize: { locked: true, dimension: "outer", value: coreSize },
          height: { locked: true, value: 60 },
          layers: { locked: true, value: 1 },
          objective: "minVolume",
          topCap: "auto",
          joint: "press",
          tolerance: 0.2,
          print: { bedX: 256, bedY: 256, bedZ: 256 },
          mount: "keyhole",
          plateJoint: "glue",
        };
        const d = await design(spec);
        wall = buildWall(d.wallSpec);
        flangeSpec = d.flangeSpec;
        wasm = await Module();
        wasm.setup();
      });

      it("sweeps 3.5-14mm in 0.1mm steps (106 thicknesses over the slices)", () => {
        expect(slices.flatMap((s) => s.values)).toEqual(THICKNESSES);
        expect(THICKNESSES).toHaveLength(106);
      });

      it.each(slices)("stays a single, genus-1 solid across the $range thickness slice", async ({ values }) => {
        for (const thickness of values) {
          const mesh = await fuseFlange(wall, { ...flangeSpec, thickness });
          const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
          try {
            const label = `thickness=${thickness.toFixed(1)}`;
            expect(m.status(), label).toBe("NoError");
            expect(m.genus(), label).toBe(1); // one hole through the whole part -- the bore; the recess(es) are blind pockets
            const pieces = m.decompose();
            try {
              expect(pieces.length, label).toBe(1); // no disconnected slivers
            } finally {
              for (const p of pieces) p.delete();
            }
          } finally {
            m.delete();
          }
        }
      }, 30000);
    });
  });
}
