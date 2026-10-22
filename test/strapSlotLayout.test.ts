import { describe, expect, it } from "vitest";
import { design, parseHash } from "../src/core";
import type { CoilMesh } from "../src/core";
import { encodeHashDoc } from "../e2e/hashDoc";

const ROUND = 1e6;
const r = (n: number) => Math.round(n * ROUND) / ROUND + 0;

function volume(mesh: CoilMesh): number {
  const p = mesh.positions;
  let sum = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [mesh.indices[i] * 3, mesh.indices[i + 1] * 3, mesh.indices[i + 2] * 3];
    sum += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return sum;
}

const DOCS = {
  pillTclipStrap: { shape: "pill", L: 2000, d: 3.8, lock: ["h"], h: 40, cap: "on", mount: "skadis-tclip", strap: true },
  squareStrap3: { L: 4000, d: 3.8, lock: ["outer", "ly"], size: 60, shape: "sq", rc: 10, ly: 3, base: "on", cap: "on", strap: true },
  triStrap: { L: 3000, d: 3.8, lock: ["outer", "ly"], size: 60, shape: "tri", rc: 10, ly: 2, base: "on", cap: "on", strap: true },
  roundSkadisLabelStrap: { L: 4000, d: 3.8, lock: ["outer", "ly"], size: 85, ly: 2, base: "on", cap: "on", mount: "skadis", label: "USB-C", strap: true },
  squareKeyholeStrap: { L: 4000, d: 3.8, lock: ["outer", "ly"], size: 85, shape: "sq", rc: 10, ly: 2, base: "on", cap: "on", mount: "keyhole", strap: true },
  squareThroughLabelStrap: { L: 4000, d: 3.8, lock: ["outer", "ly"], size: 85, shape: "sq", rc: 10, ly: 2, base: "on", cap: "on", mount: "through", label: "USB-C", strap: true },
};

const RECORDED = {
  pillTclipStrap: {"slots":{"base":[{"centre":[-21.433158,32.241791],"axis":[-0.044406,0.999014],"arc":142.824221,"points":62},{"centre":[21.433158,-32.241791],"axis":[0.044406,-0.999014],"arc":284.214812,"points":62}],"cap":[{"centre":[10.566371,32.273628],"axis":[0,1],"arc":110.824221,"points":62},{"centre":[-10.566371,-32.273628],"axis":[0,-1],"arc":252.214812,"points":62}],"mountPlate":[]},"parts":[{"name":"core","triangles":11446,"volume":44236.604071},{"name":"top-cap","triangles":2330,"volume":16827.200494},{"name":"skadis-tclip-1","triangles":262,"volume":1162.065903},{"name":"skadis-tclip-2","triangles":264,"volume":1162.065905}]},
  squareStrap3: {"slots":{"base":[{"centre":[2.786894,50.02362],"axis":[0.127155,0.991883],"arc":88.846857,"points":62},{"centre":[-2.786894,-50.02362],"axis":[-0.127155,-0.991883],"arc":237.701945,"points":62}],"cap":[{"centre":[2.786894,50.02362],"axis":[0.127155,0.991883],"arc":88.846857,"points":62},{"centre":[-2.786894,-50.02362],"axis":[-0.127155,-0.991883],"arc":237.701945,"points":62}],"mountPlate":[]},"parts":[{"name":"core","triangles":10848,"volume":33149.141344},{"name":"top-cap","triangles":3230,"volume":17828.579332}]},
  triStrap: {"slots":{"base":[{"centre":[-8.905041,53.954648],"axis":[0.498121,0.867108],"arc":115.980109,"points":62},{"centre":[0.978697,-48.24833],"axis":[0.5,-0.866025],"arc":289.877822,"points":62}],"cap":[{"centre":[-8.905041,53.954648],"axis":[0.498121,0.867108],"arc":115.980109,"points":62},{"centre":[0.978697,-48.24833],"axis":[0.5,-0.866025],"arc":289.877822,"points":62}],"mountPlate":[]},"parts":[{"name":"core","triangles":11348,"volume":39328.585599},{"name":"top-cap","triangles":3378,"volume":21811.481447}]},
  roundSkadisLabelStrap: {"slots":{"base":[{"centre":[-54.770085,0.622914],"axis":[-0.999935,0.011373],"arc":171.453498,"points":62},{"centre":[54.770085,-0.622914],"axis":[0.999935,-0.011373],"arc":343.529924,"points":62}],"cap":[{"centre":[-23.614759,49.421589],"axis":[-0.431134,0.902288],"arc":110.453498,"points":62},{"centre":[23.614759,-49.421589],"axis":[0.431134,-0.902288],"arc":282.529924,"points":62}],"mountPlate":[]},"parts":[{"name":"core","triangles":13276,"volume":46074.008504},{"name":"top-cap","triangles":7722,"volume":23634.018879},{"name":"skadis-top-clip-1","triangles":1300,"volume":1349.351216},{"name":"skadis-bottom-clip-1","triangles":724,"volume":680.354922},{"name":"skadis-bottom-clip-2","triangles":724,"volume":680.354922}]},
  squareKeyholeStrap: {"slots":{"base":[{"centre":[-6.816159,67.166998],"axis":[-0.306019,0.952025],"arc":124.408294,"points":62},{"centre":[6.816159,-67.166998],"axis":[0.306019,-0.952025],"arc":324.382959,"points":62}],"cap":[{"centre":[-7.760996,66.839714],"axis":[-0.348439,0.937332],"arc":125.408294,"points":62},{"centre":[7.760996,-66.839714],"axis":[0.348439,-0.937332],"arc":325.382959,"points":62}],"mountPlate":[]},"parts":[{"name":"core","triangles":14244,"volume":49034.62395},{"name":"top-cap","triangles":4030,"volume":26376.990618}]},
  squareThroughLabelStrap: {"slots":{"base":[{"centre":[-23.127523,54.334084],"axis":[-0.707107,0.707107],"arc":145.408294,"points":62},{"centre":[23.127523,-54.334084],"axis":[0.707107,-0.707107],"arc":345.382959,"points":62}],"cap":[{"centre":[-7.760996,66.839714],"axis":[-0.348439,0.937332],"arc":125.408294,"points":62},{"centre":[7.760996,-66.839714],"axis":[0.348439,-0.937332],"arc":325.382959,"points":62}],"mountPlate":[]},"parts":[{"name":"core","triangles":14494,"volume":47590.754901},{"name":"top-cap","triangles":6336,"volume":25724.277283}]},
};

async function fingerprint(doc: Record<string, unknown>, resolution: "draft" | "final") {
  const parsed = parseHash(encodeHashDoc(doc));
  expect(parsed.notice).toBeUndefined();
  const d = await design(parsed.spec, resolution);
  const slots = (list: typeof d.strapSlots.base) => list.map((s) => ({ centre: [r(s.centre.x), r(s.centre.y)], axis: [r(s.axis.x), r(s.axis.y)], arc: r(s.arc), points: s.outline.length }));
  return {
    slots: { base: slots(d.strapSlots.base), cap: slots(d.strapSlots.cap), mountPlate: slots(d.strapSlots.mountPlate) },
    parts: d.parts.map((p) => ({ name: p.name, triangles: p.mesh.indices.length / 3, volume: r(volume(p.mesh)) })),
  };
}

describe("strap slot layout is unchanged by the keep-out prefilter (issue #342)", () => {
  for (const [name, doc] of Object.entries(DOCS)) {
    it(`${name}: slot positions, triangle counts and volumes match the layout recorded before the prefilter`, async () => {
      expect(await fingerprint(doc, "draft")).toEqual(RECORDED[name as keyof typeof DOCS]);
    }, 30_000);
  }
});
