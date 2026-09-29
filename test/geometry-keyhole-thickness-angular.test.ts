import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec } from "../src/core";
import { fuseFlange } from "../src/core/manifold";
import { buildWall } from "../src/core/wall";

// Split from test/geometry.test.ts (test-audit report, S1): the sq/tri
// (both two-slot) cases of the #41 sweep. See
// test/geometry-keyhole-thickness-round.test.ts for the shared issue #41
// rationale and why the sweep was split by shape into two files.
describe("fuseFlange screw-keyhole recess cut across flange thickness (issue #41)", () => {
  const KEYHOLE_SPECS: Array<{ label: string; shape: CoilSpec["shape"]; coreSize: number }> = [
    // >=90mm flange diameter: mount.ts's layoutKeyholeMount lays out TWO
    // slots (the original issue's own repro shape/size).
    { label: "sq, two-slot", shape: { kind: "sq", cornerRadius: 15 }, coreSize: 100 },
    { label: "tri, two-slot", shape: { kind: "tri", cornerRadius: 15 }, coreSize: 100 },
  ];

  describe.each(KEYHOLE_SPECS)("$label", ({ shape, coreSize }) => {
    it("stays a single, genus-1 solid across a 3.5-14mm thickness sweep", async () => {
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
      const wall = buildWall(d.wallSpec);

      const wasm = await Module();
      wasm.setup();

      // Starts just past SCREW_MOUNT_RECESS_DEPTH (3mm): AT or below that,
      // the recess breaks all the way through the flange by construction
      // (a real, but different and much coarser, geometric limit -- not
      // this issue's floating-point robustness bug -- so it's out of scope
      // here and genuinely does raise the genus). Steps of 0.1mm: the
      // failure this pins is a floating-point robustness issue that only
      // shows up at scattered, seemingly arbitrary thickness values (not a
      // clean contiguous band) -- a coarser step (0.5mm was tried first)
      // silently skipped every one of them and passed even against the
      // unfixed code.
      for (let thickness = 3.5; thickness <= 14; thickness += 0.1) {
        const flangeSpec = { ...d.flangeSpec, thickness };
        const mesh = await fuseFlange(wall, flangeSpec);
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
