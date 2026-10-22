import Module from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import { design } from "../../src/core";
import type { CoilSpec } from "../../src/core";

export type KeyholeSweepSpec = { label: string; shape: CoilSpec["shape"]; coreSize: number };

// Issue #41: the screw-mount recess cut is a manifold boolean whose
// floating-point robustness failed at scattered, seemingly arbitrary flange
// thicknesses (not a clean contiguous band) -- a coarser step (0.5mm was tried
// first) silently skipped every one of them and passed even against the
// unfixed code. design() sets the flange's thickness from the cable's
// diameter (the channel's depth plus a 1.5 mm shelf, or 5 mm where the
// keyhole's own recess needs more), so a sweep of the diameter in 0.1 mm
// steps visits every thickness from 5 to 14 mm the design can emit, in the
// same 0.1 mm steps the sweep over the thickness itself used. (Below 5 mm the
// recess breaks through the flange by construction, and design() never emits
// it.) The values come from an accumulating `+= 0.1` loop, as the thickness
// sweep did.
const DIAMETERS: number[] = [];
for (let diameter = 2; diameter <= 12.5; diameter += 0.1) DIAMETERS.push(diameter);

// One design per diameter is ~0.2s, so a whole sweep is ~25s. Cut into slices
// of ~27 diameters: each slice is its own case, inside its limit even under a
// loaded full run, and none of the diameters is dropped.
const SLICES = 4;
const SLICE_SIZE = Math.ceil(DIAMETERS.length / SLICES);
const slices = Array.from({ length: SLICES }, (_, i) => DIAMETERS.slice(i * SLICE_SIZE, (i + 1) * SLICE_SIZE)).map((values) => ({
  values,
  range: `${values[0].toFixed(1)}-${values[values.length - 1].toFixed(1)}mm`,
}));

export function describeKeyholeThicknessSweep(specs: KeyholeSweepSpec[]): void {
  describe("the core's screw-keyhole recess cut across flange thickness (issue #41), through design()", () => {
    describe.each(specs)("$label", ({ shape, coreSize }) => {
      let wasm: Awaited<ReturnType<typeof Module>>;

      beforeAll(async () => {
        wasm = await Module();
        wasm.setup();
      });

      it("sweeps the cable diameter 2.0-12.5mm in 0.1mm steps (every diameter in one of the slices)", () => {
        expect(slices.flatMap((s) => s.values)).toEqual(DIAMETERS);
        expect(DIAMETERS.length).toBeGreaterThanOrEqual(105);
      });

      it.each(slices)("stays a single, genus-1 solid across the $range diameter slice", async ({ values }) => {
        for (const diameter of values) {
          const spec: CoilSpec = {
            wire: { length: 2000, diameter, type: "usb" },
            shape,
            windingQuality: 0.7,
            coreSize: { locked: true, dimension: "outer", value: coreSize },
            // 30 mm, not 60: the recess is cut in the flange, and a shorter wall halves the time per design. Against a recess
            // cutter left flush with the flange face, the sweep fails at both heights.
            height: { locked: true, value: 30 },
            layers: { locked: true, value: 1 },
            objective: "minVolume",
            topCap: "off",
            base: "on",
            joint: "press",
            tolerance: 0.2,
            print: { bedX: 256, bedY: 256, bedZ: 256 },
            mount: "keyhole",
            plateJoint: "glue",
          };
          const { mesh, flangeSpec } = await design(spec);
          const label = `diameter=${diameter.toFixed(1)}, flange thickness ${flangeSpec.thickness.toFixed(2)}`;
          expect(flangeSpec.thickness, label).toBeGreaterThanOrEqual(diameter + 1.5 - 1e-6);
          const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
          try {
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
      }, 120000);
    });
  });
}
