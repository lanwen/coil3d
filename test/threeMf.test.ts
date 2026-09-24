import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design, exportDesign } from "../src/core";
import type { CoilSpec } from "../src/core";

// Issue #10 acceptance criteria: "A hand-written 3MF (zip) with one object
// and one build item per part, units mm, parts side by side in print
// orientation", "Single-colour named objects (no basematerials/paint
// colours in v1)", "A bed-size setting (X/Y/Z) with per-part fit warnings;
// the UI shows the part count", "Vitest reads the 3MF back: object count,
// names, units, placement, watertightness". These tests exercise ONLY the
// public `design()`/`exportDesign()` interface -- the zip/XML reader below
// is an independent verification tool (mirrors geometry.test.ts's
// hand-rolled STL parser and topCap.test.ts's manifold-3d re-check), not
// access to core internals.

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
    ...overrides,
  };
}

const twoPartSpec = baseSpec({
  wire: { length: 6000, diameter: 3.8, type: "usb" },
  coreSize: { locked: true, dimension: "outer", value: 60 },
  height: { locked: true, value: 60 },
  layers: { locked: true, value: 2 },
});

// --- Independent zip (STORE-only) reader, mirroring src/core/zip.ts's own
// writer (no compression, no zip64, no archive comment -- see zip.ts's
// header comment for why this project hand-rolls its own zip instead of a
// dependency). Reading the central directory back independently proves the
// writer produced a real, spec-shaped zip, not just bytes this test's own
// assumptions happen to tolerate. ---
interface ZipFile {
  name: string;
  data: Uint8Array;
}

function readZipStore(bytes: Uint8Array): ZipFile[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = bytes.length - 22;
  expect(dv.getUint32(eocdOffset, true)).toBe(0x06054b50); // end of central directory signature
  const entryCount = dv.getUint16(eocdOffset + 10, true);
  const centralStart = dv.getUint32(eocdOffset + 16, true);

  const files: ZipFile[] = [];
  let pos = centralStart;
  for (let i = 0; i < entryCount; i++) {
    expect(dv.getUint32(pos, true)).toBe(0x02014b50); // central directory header signature
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
  return files;
}

interface ModelObject {
  id: number;
  name: string;
  positions: Float32Array;
  indices: Uint32Array;
}
interface ModelItem {
  objectId: number;
  /** The 12 numbers of the `transform` attribute: [m00..m22, m30, m31, m32]. */
  matrix: number[];
}

function parseModel(xml: string): { unit: string | undefined; objects: ModelObject[]; items: ModelItem[]; hasBaseMaterials: boolean } {
  const unit = /<model[^>]*\sunit="([^"]+)"/.exec(xml)?.[1];
  const hasBaseMaterials = xml.includes("<basematerials");

  const objects: ModelObject[] = [];
  const objectRe = /<object id="(\d+)" type="model" name="([^"]*)">(.*?)<\/object>/gs;
  for (const m of xml.matchAll(objectRe)) {
    const id = Number(m[1]);
    const name = m[2];
    const body = m[3];

    const positions: number[] = [];
    for (const v of body.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)) {
      positions.push(Number(v[1]), Number(v[2]), Number(v[3]));
    }
    const indices: number[] = [];
    for (const t of body.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)) {
      indices.push(Number(t[1]), Number(t[2]), Number(t[3]));
    }
    objects.push({ id, name, positions: new Float32Array(positions), indices: new Uint32Array(indices) });
  }

  const items: ModelItem[] = [];
  for (const m of xml.matchAll(/<item objectid="(\d+)" transform="([^"]+)"\/>/g)) {
    items.push({ objectId: Number(m[1]), matrix: m[2].split(" ").map(Number) });
  }

  return { unit, objects, items, hasBaseMaterials };
}

/** Apply a 3MF `<item transform>` matrix (row-vector convention: P' = P * M, see src/core/threeMf.ts) to a mesh's vertices. */
function applyMatrix(positions: Float32Array, matrix: number[]): Float32Array {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22, dx, dy, dz] = matrix;
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    out[i] = x * m00 + y * m10 + z * m20 + dx;
    out[i + 1] = x * m01 + y * m11 + z * m21 + dy;
    out[i + 2] = x * m02 + y * m12 + z * m22 + dz;
  }
  return out;
}

function bboxOf(positions: Float32Array) {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i],
      y = positions[i + 1],
      z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

async function assertWatertight(positions: Float32Array, indices: Uint32Array, label: string) {
  const wasm = await Module();
  wasm.setup();
  const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: positions, triVerts: indices }));
  try {
    expect(m.status(), `${label}: manifold status`).toBe("NoError");
    expect(m.volume(), `${label}: volume`).toBeGreaterThan(0);
  } finally {
    m.delete();
  }
}

describe("exportDesign(design, '3mf')", () => {
  it("writes a real zip (OPC package) with the 3 required parts", async () => {
    const d = await design(baseSpec());
    const bytes = await exportDesign(d, "3mf");
    const files = readZipStore(bytes);
    const names = files.map((f) => f.name);
    expect(names).toContain("[Content_Types].xml");
    expect(names).toContain("_rels/.rels");
    expect(names).toContain("3D/3dmodel.model");
  });

  it("one object + one build item per part, named and unitized in millimeter, single-color (no basematerials)", async () => {
    const d = await design(twoPartSpec);
    const bytes = await exportDesign(d, "3mf");
    const files = readZipStore(bytes);
    const modelXml = new TextDecoder().decode(files.find((f) => f.name === "3D/3dmodel.model")!.data);
    const model = parseModel(modelXml);

    expect(model.unit).toBe("millimeter");
    expect(model.hasBaseMaterials).toBe(false); // docs/research.md §10b: slicers ignore basematerials colours -- ship single-colour named objects

    expect(model.objects).toHaveLength(d.parts.length);
    expect(model.objects.map((o) => o.name)).toEqual(d.parts.map((p) => p.name));
    expect(model.items).toHaveLength(d.parts.length);

    // Every object's mesh is the part's own (untransformed) mesh, byte for
    // byte -- the print orientation + plate position live only in the
    // <item> transform (src/core/threeMf.ts), so every export backend reads
    // identical vertex data.
    d.parts.forEach((part, i) => {
      const obj = model.objects[i];
      expect(obj.positions.length).toBe(part.mesh.positions.length);
      expect(obj.indices.length).toBe(part.mesh.indices.length);
      for (let k = 0; k < obj.positions.length; k++) {
        expect(obj.positions[k]).toBeCloseTo(part.mesh.positions[k], 4);
      }
    });
  });

  it("each object round-trips as a valid, watertight manifold (trimesh-equivalent check)", async () => {
    const d = await design(twoPartSpec);
    const bytes = await exportDesign(d, "3mf");
    const files = readZipStore(bytes);
    const modelXml = new TextDecoder().decode(files.find((f) => f.name === "3D/3dmodel.model")!.data);
    const model = parseModel(modelXml);

    for (const obj of model.objects) {
      await assertWatertight(obj.positions, obj.indices, obj.name);
    }
  });

  it("places every part in its own print orientation, side by side, non-overlapping, centered on the bed", async () => {
    const d = await design(twoPartSpec);
    const bytes = await exportDesign(d, "3mf");
    const files = readZipStore(bytes);
    const modelXml = new TextDecoder().decode(files.find((f) => f.name === "3D/3dmodel.model")!.data);
    const model = parseModel(modelXml);

    const byId = new Map(model.objects.map((o) => [o.id, o]));
    const placedBoxes = model.items.map((item) => {
      const obj = byId.get(item.objectId)!;
      const placed = applyMatrix(obj.positions, item.matrix);
      return { name: obj.name, box: bboxOf(placed), matrix: item.matrix };
    });

    const bed = d.spec.print;
    for (const { name, box } of placedBoxes) {
      expect(box.minX, `${name} minX within bed`).toBeGreaterThanOrEqual(-1e-6);
      expect(box.maxX, `${name} maxX within bed`).toBeLessThanOrEqual(bed.bedX + 1e-6);
      expect(box.minY, `${name} minY within bed`).toBeGreaterThanOrEqual(-1e-6);
      expect(box.maxY, `${name} maxY within bed`).toBeLessThanOrEqual(bed.bedY + 1e-6);
    }

    // Non-overlapping, side by side along X (docs/research.md "Out of
    // scope": no automatic multi-row packing needed here, just no overlap).
    const sorted = [...placedBoxes].sort((a, b) => a.box.minX - b.box.minX);
    for (let i = 0; i + 1 < sorted.length; i++) {
      expect(sorted[i].box.maxX, `${sorted[i].name} doesn't overlap ${sorted[i + 1].name}`).toBeLessThanOrEqual(sorted[i + 1].box.minX + 1e-6);
    }

    // The top cap's print orientation is a 180deg flip about X
    // (design.ts/types.ts: printTransform.rotateX === Math.PI for the cap,
    // 0 for the core) -- confirm the 3MF <item> transform reproduces it:
    // m11 = cos(rotateX), m12 = sin(rotateX) (src/core/threeMf.ts).
    d.parts.forEach((part, i) => {
      const [, , , , m11, m12] = model.items[i].matrix;
      expect(m11).toBeCloseTo(Math.cos(part.printTransform.rotateX), 5);
      expect(m12).toBeCloseTo(Math.sin(part.printTransform.rotateX), 5);
    });
  });

  it("a single-part design still centers its one object on the bed", async () => {
    const d = await design(baseSpec());
    expect(d.parts).toHaveLength(1);
    const bytes = await exportDesign(d, "3mf");
    const files = readZipStore(bytes);
    const modelXml = new TextDecoder().decode(files.find((f) => f.name === "3D/3dmodel.model")!.data);
    const model = parseModel(modelXml);

    const obj = model.objects[0];
    const placed = applyMatrix(obj.positions, model.items[0].matrix);
    const box = bboxOf(placed);
    const bed = d.spec.print;
    const centerX = (box.minX + box.maxX) / 2;
    const centerY = (box.minY + box.maxY) / 2;
    expect(centerX).toBeCloseTo(bed.bedX / 2, 3);
    expect(centerY).toBeCloseTo(bed.bedY / 2, 3);
  });
});

describe("design().warnings: per-part bed-fit (issue #10)", () => {
  it("warns when a part's footprint doesn't fit a too-small bed", async () => {
    const d = await design(baseSpec({ print: { bedX: 20, bedY: 20, bedZ: 256 } }));
    expect(d.warnings.some((w) => /footprint/i.test(w) && /doesn't fit/i.test(w))).toBe(true);
  });

  it("warns when a part is taller than a too-short bed", async () => {
    const d = await design(baseSpec({ print: { bedX: 256, bedY: 256, bedZ: 10 } }));
    expect(d.warnings.some((w) => /taller than/i.test(w))).toBe(true);
  });

  it("has no bed-fit warnings for the default 256mm bed with a small coil", async () => {
    const d = await design(baseSpec());
    expect(d.warnings.some((w) => /bed/i.test(w))).toBe(false);
  });
});
