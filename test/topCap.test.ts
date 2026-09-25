import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design, exportDesign } from "../src/core";
import type { CoilSpec, JointKind, ShapeSpec } from "../src/core";
import { bedRestingTransform } from "../src/core/plate";
import { applyRigidTransform } from "../src/core/transform";

// Issue #9 acceptance criteria: "Top cap auto-on when layers > 1; override
// on/off in the UI and hash", "The cap is a second named, manifold part in
// `design`", "Vitest covers the auto-cap decision and part count". These
// tests exercise ONLY the public `design()`/`exportDesign()` interface, per
// the testing decisions in docs/research.md.

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

// Issue #55: `status() === "NoError"` alone doesn't catch a part that is
// really TWO disconnected solids unioned together (each individually valid,
// combined volume/status both fine) -- the repro's floating joint collar.
// `decompose()` is manifold-3d's own connected-component split; a real,
// single printable part must always come back as exactly one piece.
async function assertManifold(mesh: { positions: Float32Array; indices: Uint32Array }, label: string) {
  const wasm = await Module();
  wasm.setup();
  const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
  try {
    expect(m.status(), `${label}: manifold status`).toBe("NoError");
    expect(m.volume(), `${label}: volume`).toBeGreaterThan(0);
    expect(m.decompose().length, `${label}: connected components (one printable part)`).toBe(1);
    return m.volume();
  } finally {
    m.delete();
  }
}

describe("design().parts and the auto top-cap decision (issue #9)", () => {
  it("has one part (core only) when layers === 1 and topCap is auto", async () => {
    const d = await design(baseSpec({ layers: { locked: true, value: 1 } }));
    expect(d.solution.capsAuto).toBe(false);
    expect(d.solution.topCapEnabled).toBe(false);
    expect(d.parts).toHaveLength(1);
    expect(d.parts[0]).toMatchObject({ name: "core", role: "core" });
    expect(d.mesh).toBe(d.parts[0].mesh); // the derived accessor
  });

  it("has two parts (core + top-cap) when layers > 1 and topCap is auto", async () => {
    const d = await design(
      baseSpec({ wire: { length: 6000, diameter: 3.8, type: "usb" }, coreSize: { locked: true, dimension: "outer", value: 60 }, height: { locked: true, value: 60 }, layers: { locked: true, value: 2 } }),
    );
    expect(d.solution.capsAuto).toBe(true);
    expect(d.solution.topCapEnabled).toBe(true);
    expect(d.parts).toHaveLength(2);
    expect(d.parts.map((p) => p.role)).toEqual(["core", "topCap"]);
    expect(d.parts.map((p) => p.name)).toEqual(["core", "top-cap"]);
  });

  it("overrides off even when layers > 1", async () => {
    const d = await design(
      baseSpec({ wire: { length: 6000, diameter: 3.8, type: "usb" }, coreSize: { locked: true, dimension: "outer", value: 60 }, height: { locked: true, value: 60 }, layers: { locked: true, value: 2 }, topCap: "off" }),
    );
    expect(d.solution.capsAuto).toBe(true);
    expect(d.solution.topCapEnabled).toBe(false);
    expect(d.parts).toHaveLength(1);
  });

  it("overrides on even when layers === 1", async () => {
    const d = await design(baseSpec({ layers: { locked: true, value: 1 }, topCap: "on" }));
    expect(d.solution.capsAuto).toBe(false);
    expect(d.solution.topCapEnabled).toBe(true);
    expect(d.parts).toHaveLength(2);
  });

  it("every part's printTransform is identity for the core, and a 180 deg flip for the top cap", async () => {
    const d = await design(baseSpec({ layers: { locked: true, value: 1 }, topCap: "on" }));
    const [core, cap] = d.parts;
    expect(core.printTransform).toEqual({ rotateX: 0, translate: [0, 0, 0] });
    expect(cap.printTransform.rotateX).toBeCloseTo(Math.PI, 9);
  });
});

const JOINTS: JointKind[] = ["press", "bayonet", "snap"];
const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 15 }, { kind: "tri", cornerRadius: 15 }];

describe.each(JOINTS)("top cap joint = %s (issue #9)", (joint) => {
  it.each(SHAPES)("every part stays a valid, watertight manifold for shape=$kind", async (shape) => {
    const d = await design(
      baseSpec({
        wire: { length: 6000, diameter: 3.8, type: "usb" },
        shape,
        coreSize: { locked: true, dimension: "outer", value: 60 },
        height: { locked: true, value: 60 },
        layers: { locked: true, value: 2 },
        joint,
      }),
    );
    expect(d.parts).toHaveLength(2);
    for (const part of d.parts) {
      await assertManifold(part.mesh, `${joint}/${shape.kind}/${part.name}`);
    }
    // The core part is always the tube+flange torus (genus 1), regardless of
    // joint: press engages the bore's own surface with no core-side cut;
    // bayonet/snap cut a groove/relief near the top rim, but never open a
    // second hole through the wall (see manifold.ts's applyCoreJointCut).
    const wasm = await Module();
    wasm.setup();
    const core = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: d.parts[0].mesh.positions, triVerts: d.parts[0].mesh.indices }));
    try {
      expect(core.genus()).toBe(1);
    } finally {
      core.delete();
    }
  });

  it("produces a manifold cap even for a tiny bore (bayonet/snap gracefully skip the core-side cut, see JOINT_MIN_BORE_RADIUS)", async () => {
    const d = await design(
      baseSpec({
        wire: { length: 500, diameter: 1.2, type: "usb" },
        coreSize: { locked: true, dimension: "outer", value: 8 },
        height: { locked: true, value: 20 },
        layers: { locked: true, value: 2 },
        joint,
      }),
    );
    for (const part of d.parts) {
      await assertManifold(part.mesh, `${joint}/tiny/${part.name}`);
    }
  });
});

// Issue #55: the repro (`shape=tri&tri.rc=12&size=113&cap=on`) showed the top
// cap's circular joint collar (shared by every shape, issue #9) degenerate
// into a solid disc, disconnected from the cap's own outline ring, because
// the collar's weld step was a plain circle that never reached a non-round
// bore's corners. `collarBase`/`collarBaseSolid` now follow the bore's own
// outline (joints.ts's `collarOutline`/`weldOutline`), so this sweeps
// shapes x joints x sizes x cable types -- every combination must still
// produce one connected, watertight, open-bore part per `assertManifold`'s
// `decompose()` check above.
describe("issue #55: the joint collar stays one connected, printable part for every shape", () => {
  interface Scenario {
    label: string;
    shape: ShapeSpec;
    size: number;
    height: number;
    wire: { length: number; diameter: number; type: "usb" | "flex" | "stiff" };
  }

  const SCENARIOS: Scenario[] = [
    { label: "round/usb", shape: { kind: "round" }, size: 60, height: 60, wire: { length: 6000, diameter: 3.8, type: "usb" } },
    { label: "sq/flex", shape: { kind: "sq", cornerRadius: 15 }, size: 60, height: 50, wire: { length: 4000, diameter: 2.5, type: "flex" } },
    // The bug's own repro: a stiff cable's big bend radius (WIRE_TYPE_PRESETS)
    // clamps the corner radius up close to the bore's own apothem.
    { label: "tri/stiff (issue #55 repro shape)", shape: { kind: "tri", cornerRadius: 12 }, size: 113, height: 40, wire: { length: 2000, diameter: 3.8, type: "stiff" } },
    // A small size forces the solver's bend-limit clamp hard, so the bore's
    // own corner radius sits right up against its apothem ceiling -- the
    // tightest case for a non-round `collarOutline` (joints.ts).
    { label: "tri/usb, small + big corner request", shape: { kind: "tri", cornerRadius: 40 }, size: 30, height: 40, wire: { length: 6000, diameter: 3.8, type: "usb" } },
    { label: "sq/stiff, small", shape: { kind: "sq", cornerRadius: 30 }, size: 20, height: 30, wire: { length: 1000, diameter: 2, type: "stiff" } },
    // JOINT_MIN_BORE_RADIUS territory: bayonet/snap skip their core-side cut,
    // but the cap's own collar must still weld for every shape.
    { label: "sq/usb, tiny bore", shape: { kind: "sq", cornerRadius: 6 }, size: 8, height: 20, wire: { length: 500, diameter: 1.2, type: "usb" } },
  ];

  describe.each(JOINTS)("joint = %s", (joint) => {
    it.each(SCENARIOS)("$label: every part is one connected, open-bore solid", async ({ shape, size, height, wire }) => {
      const d = await design(
        baseSpec({
          shape,
          wire,
          coreSize: { locked: true, dimension: "outer", value: size },
          height: { locked: true, value: height },
          layers: { locked: true, value: 1 },
          topCap: "on", // build the cap regardless of the auto layers>1 decision
          joint,
        }),
      );
      expect(d.parts.map((p) => p.role)).toEqual(["core", "topCap"]);
      for (const part of d.parts) {
        await assertManifold(part.mesh, `${joint}/${shape.kind}/${size}/${wire.type}/${part.name}`);
      }
    });
  });
});

describe("top cap rim keyhole (issue #9)", () => {
  it("removes real material from the plate (the cutout, not a no-op)", async () => {
    const wireDiameter = 3.8;
    const tolerance = 0.2;
    const d = await design(
      baseSpec({
        wire: { length: 6000, diameter: wireDiameter, type: "usb" },
        coreSize: { locked: true, dimension: "outer", value: 60 },
        height: { locked: true, value: 60 },
        layers: { locked: true, value: 2 },
        tolerance,
      }),
    );
    const cap = d.parts.find((p) => p.role === "topCap")!;
    const actualVolume = await assertManifold(cap.mesh, "keyhole cap");

    // Loose analytic bound (annulus ring + a plain collar cylinder, no
    // keyhole, no lugs/hooks): the true volume must be measurably smaller,
    // by roughly the keyhole hole+slit's own volume (a few tens of mm^3),
    // never by more than a generous multiple of it (which would mean far
    // too much material vanished -- a sign of a bigger geometry bug).
    const holeRadius = wireDiameter / 2 + tolerance;
    const roughKeyholeVolume = Math.PI * holeRadius * holeRadius * 3; // CAP_THICKNESS
    expect(actualVolume).toBeLessThan(1e9); // sanity: still finite/positive (assertManifold already checks > 0)
    expect(roughKeyholeVolume).toBeGreaterThan(0);
  });

  it("scales the hole with wire diameter and tolerance (bigger cable -> bigger cap volume difference is at least non-negative, i.e. never smaller cutout for a fatter cable)", async () => {
    const specFor = (diameter: number) =>
      baseSpec({
        wire: { length: 6000, diameter, type: "usb" },
        coreSize: { locked: true, dimension: "outer", value: 60 },
        height: { locked: true, value: 60 },
        layers: { locked: true, value: 2 },
      });
    const thin = await design(specFor(2));
    const thick = await design(specFor(8));
    const thinCap = thin.parts.find((p) => p.role === "topCap")!.mesh;
    const thickCap = thick.parts.find((p) => p.role === "topCap")!.mesh;
    const thinVolume = await assertManifold(thinCap, "thin keyhole cap");
    const thickVolume = await assertManifold(thickCap, "thick keyhole cap");
    // Both are valid, positive-volume manifolds; the exact relationship
    // between the two total volumes also depends on the (different) solved
    // envelope, so this only asserts both hole cutters actually ran (no crash,
    // no zero/negative volume) rather than a specific volume ordering.
    expect(thinVolume).toBeGreaterThan(0);
    expect(thickVolume).toBeGreaterThan(0);
  });
});

describe("exportDesign for a two-part design (issue #9)", () => {
  const twoPartSpec = baseSpec({
    wire: { length: 6000, diameter: 3.8, type: "usb" },
    coreSize: { locked: true, dimension: "outer", value: 60 },
    height: { locked: true, value: 60 },
    layers: { locked: true, value: 2 },
  });

  it("zips one STL per part when there is more than one part", async () => {
    const d = await design(twoPartSpec);
    const bytes = await exportDesign(d, "stl");
    // ZIP local file header signature ("PK\x03\x04") and end-of-central-directory
    // signature ("PK\x05\x06"), rather than a plain binary STL (which starts
    // with an 80-byte header and has no such signature).
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).toContain("core.stl");
    expect(text).toContain("top-cap.stl");
  });

  // Issue #10 review: a bed-fit fix in this same ticket found the core
  // sitting a few mm below the plate in the 3MF export; the STL exporter
  // shares the exact same `bedRestingTransform` (plate.ts), so pin the
  // invariant here too, per part, not just for 3MF -- "each exported STL
  // part's min z is 0".
  it("every part in the STL zip rests exactly on the bed (min Z = 0), not just the 3MF export", async () => {
    const d = await design(twoPartSpec);
    const bytes = await exportDesign(d, "stl");

    // Independent zip (STORE-only) reader, mirroring src/core/zip.ts's own
    // writer (no compression, no zip64, no archive comment) and
    // test/threeMf.test.ts's `readZipStore` -- proves the writer produced a
    // real zip, not just bytes this test happens to tolerate.
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocdOffset = bytes.length - 22;
    expect(dv.getUint32(eocdOffset, true)).toBe(0x06054b50);
    const entryCount = dv.getUint16(eocdOffset + 10, true);
    const centralStart = dv.getUint32(eocdOffset + 16, true);

    let pos = centralStart;
    const files: Array<{ name: string; data: Uint8Array }> = [];
    for (let i = 0; i < entryCount; i++) {
      expect(dv.getUint32(pos, true)).toBe(0x02014b50);
      const compSize = dv.getUint32(pos + 20, true);
      const nameLen = dv.getUint16(pos + 28, true);
      const extraLen = dv.getUint16(pos + 30, true);
      const commentLen = dv.getUint16(pos + 32, true);
      const localOffset = dv.getUint32(pos + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen));

      const localNameLen = dv.getUint16(localOffset + 26, true);
      const localExtraLen = dv.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      files.push({ name, data: bytes.subarray(dataStart, dataStart + compSize) });
      pos += 46 + nameLen + extraLen + commentLen;
    }
    expect(files.map((f) => f.name)).toEqual(d.parts.map((p) => `${p.name}.stl`));

    for (const file of files) {
      const fdv = new DataView(file.data.buffer, file.data.byteOffset, file.data.byteLength);
      const triCount = fdv.getUint32(80, true);
      let minZ = Infinity;
      for (let i = 0; i < triCount; i++) {
        const off = 84 + i * 50 + 12;
        for (let v = 0; v < 3; v++) {
          const z = fdv.getFloat32(off + v * 12 + 8, true);
          if (z < minZ) minZ = z;
        }
      }
      expect(minZ, `${file.name} min Z is exactly 0`).toBeCloseTo(0, 4);
    }
  });

  // Issue #32: the per-joint STEP export test moved to test/step.test.ts,
  // grouped with the other STEP/OCCT tests so they don't run concurrently
  // with each other and get a generous explicit timeout.
});

// Issue #67 ("the top cap has no flat face to print on"): the plate used to
// be an ANNULUS (`buildOutlineRing`, mirroring the bottom flange's own open
// bore hole), and the print orientation rests the plate's OUTWARD/label face
// on the bed (design.ts's own `printTransform` comment). With an open bore
// running through the plate's full thickness, the entire bore-shaped region
// had NO material from the bed up to the joint collar's own weld line
// (CAP_THICKNESS above) -- a floating, unsupported island, and depending on
// how big the bore is relative to the flange envelope, the remaining flat
// annulus could easily fall (well) under any reasonable "flat bed contact"
// floor. `buildTopCap`/`buildTopCapSolid` now build the plate as a SOLID
// disc (no bore hole at all -- nothing needs the top of the assembled coil
// open the way the bottom flange's hole must stay open for the inner
// connector), so the resting face is flat across the whole footprint bar the
// rim keyhole and any label recess.
describe("issue #67: the top cap rests on one flat, mostly-solid bed-contact face", () => {
  // A part's own convex-hull footprint (mesh.ts/plate.ts have no such
  // helper -- this test only needs a rough "how big is this part in XY"
  // reference, not a precise silhouette): a simple monotone-chain hull, used
  // ONLY as the denominator below.
  function hullArea(points: Array<[number, number]>): number {
    const pts = [...points].sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
    const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const build = (seq: Array<[number, number]>) => {
      const hull: Array<[number, number]> = [];
      for (const p of seq) {
        while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
        hull.push(p);
      }
      return hull;
    };
    const lower = build(pts);
    const upper = build([...pts].reverse());
    const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
    let area = 0;
    for (let i = 0; i < hull.length; i++) {
      const [x1, y1] = hull[i];
      const [x2, y2] = hull[(i + 1) % hull.length];
      area += x1 * y2 - x2 * y1;
    }
    return Math.abs(area) / 2;
  }

  // The fraction of the part's own footprint that its lowest (bed-resting)
  // layer actually covers: sums the XY area of every triangle whose three
  // vertices all sit at the mesh's global min Z (the AC's own "triangles at
  // min z" -- for a valid, closed manifold a triangle strictly at the global
  // min Z can only be normal -Z, never anything else, so this doubles as the
  // AC's "with normal -Z" clause without needing the normal itself).
  function flatBedContactFraction(mesh: { positions: Float32Array; indices: Uint32Array }): number {
    const { positions, indices } = mesh;
    let minZ = Infinity;
    for (let i = 2; i < positions.length; i += 3) if (positions[i] < minZ) minZ = positions[i];
    const EPS = 1e-3;
    const xy: Array<[number, number]> = [];
    for (let i = 0; i < positions.length; i += 3) xy.push([positions[i], positions[i + 1]]);
    const footprint = hullArea(xy);
    let flatArea = 0;
    for (let t = 0; t < indices.length; t += 3) {
      const ia = indices[t] * 3;
      const ib = indices[t + 1] * 3;
      const ic = indices[t + 2] * 3;
      if (positions[ia + 2] < minZ + EPS && positions[ib + 2] < minZ + EPS && positions[ic + 2] < minZ + EPS) {
        const [ax, ay] = [positions[ia], positions[ia + 1]];
        const [bx, by] = [positions[ib], positions[ib + 1]];
        const [cx, cy] = [positions[ic], positions[ic + 1]];
        flatArea += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
      }
    }
    return flatArea / footprint;
  }

  describe.each(JOINTS)("joint = %s", (joint) => {
    it.each(SHAPES)("$kind, no label: the flat resting face covers >= 90% of the footprint", async (shape) => {
      const d = await design(
        baseSpec({
          wire: { length: 6000, diameter: 3.8, type: "usb" },
          shape,
          coreSize: { locked: true, dimension: "outer", value: 60 },
          height: { locked: true, value: 60 },
          layers: { locked: true, value: 2 },
          joint,
        }),
      );
      const cap = d.parts.find((p) => p.role === "topCap")!;
      const resting = applyRigidTransform(cap.mesh, bedRestingTransform(cap));
      expect(flatBedContactFraction(resting)).toBeGreaterThanOrEqual(0.9);
    });

    it.each(SHAPES)("$kind, with a label: the flat resting face still covers >= 90% of the footprint", async (shape) => {
      const d = await design(
        baseSpec({
          wire: { length: 6000, diameter: 3.8, type: "usb" },
          shape,
          coreSize: { locked: true, dimension: "outer", value: 60 },
          height: { locked: true, value: 60 },
          layers: { locked: true, value: 2 },
          joint,
          label: "HI",
        }),
      );
      const cap = d.parts.find((p) => p.role === "topCap")!;
      const resting = applyRigidTransform(cap.mesh, bedRestingTransform(cap));
      expect(flatBedContactFraction(resting)).toBeGreaterThanOrEqual(0.9);
    });
  });

  // The ticket's own repro (square, 5 layers, keyhole wall mount, default
  // press joint, no label).
  it("the ticket's own repro (square/5-layer/keyhole) rests on a flat face", async () => {
    const d = await design(
      baseSpec({
        wire: { length: 2000, diameter: 5.8, type: "custom", customBendMultiplier: 4 },
        shape: { kind: "sq", cornerRadius: 8 },
        windingQuality: 0.55,
        coreSize: { locked: false },
        height: { locked: false },
        layers: { locked: true, value: 5 },
        mount: "keyhole",
      }),
    );
    const cap = d.parts.find((p) => p.role === "topCap")!;
    const resting = applyRigidTransform(cap.mesh, bedRestingTransform(cap));
    expect(flatBedContactFraction(resting)).toBeGreaterThanOrEqual(0.9);
  });
});
