// Issue #103 ("groove rings pinch together near a triangle corner/side
// transition"): `wall.ts`'s helix phased the groove directly by `t`, an
// arc-length fraction of the WINDING SURFACE (offset 0) -- correct for
// placing a point, but wrong once reused as a helix phase, because a
// corner's own arc length shrinks under the groove's own (negative, inward)
// offset while a flat side's doesn't (Steiner). The same `dt` then swept
// less real distance at the groove floor right where it crossed a corner,
// so `z = zStart + pitch*t` ran locally steeper there, bunching consecutive
// rings together (measured: ~6.5% local pitch distortion for a rounded
// square/triangle's default corner radius and groove depth -- round is
// untouched).
//
// The ticket's acceptance criterion -- "the groove pitch is constant along
// the arc length within 2%" -- is checked on the wall's own helix
// (`createWallProfile(d.wallSpec)`, the one listed exception in
// test/seams.test.ts: the helix is internal to the core, and the mesh is too
// coarse -- tens of microns of drift against facets of several tenths of a
// millimetre -- to measure it through design()), against a brute-force
// arc-length integrator over `pointAt`. The drawn cable that lies in the
// groove is checked through design() alone.

import { describe, expect, it } from "vitest";
import { design, pointAt } from "../src/core";
import type { CoilSpec, Design, ShapeKind } from "../src/core";
import { createWallProfile } from "../src/core/wall";
import type { WallSpec } from "./support/types";

function shapeSpec(kind: ShapeKind): CoilSpec["shape"] {
  return kind === "round" ? { kind } : { kind, cornerRadius: 15 };
}

function baseSpec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 2000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 60 },
    height: { locked: false },
    layers: { locked: false },
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

/** The maximum, over many t, of |local dz/d(true arc length) - nominal| /
 * nominal, where "true arc length" is measured along the groove FLOOR's own
 * outline (offset -grooveDepth) via the brute-force oracle above -- i.e.
 * exactly the ticket's own measurement ("sample the groove-centre z at many
 * arc-length positions ... check whether the pitch is constant per unit arc
 * length"). */
function maxLocalPitchDistortion(spec: WallSpec): number {
  const profile = createWallProfile(spec);
  const N = 4000;
  const arcAtOffset = (offset: number) => {
    let s = 0;
    const out: number[] = [0];
    let prev = pointAt(spec.outline, 0, offset);
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const p = pointAt(spec.outline, t, offset);
      s += Math.hypot(p.x - prev.x, p.y - prev.y);
      out.push(s);
      prev = p;
    }
    return out;
  };
  const arc = arcAtOffset(-spec.grooveDepth);
  const total = arc[N];
  const nominalSlope = profile.pitch / total;
  const zAt = (t: number) => profile.zStart + profile.pitch * profile.phaseFraction(t);

  let maxDev = 0;
  let prevZ = zAt(0);
  let prevArc = 0;
  for (let i = 1; i < N; i++) {
    // (i < N, not <=: t=1 wraps to phaseFraction(0), a periodic seam --
    // never a real column value, which is always in [0,1).)
    const t = i / N;
    const z = zAt(t);
    const dArc = arc[i] - prevArc;
    if (dArc > 1e-9) {
      const localSlope = (z - prevZ) / dArc;
      maxDev = Math.max(maxDev, Math.abs(localSlope - nominalSlope) / nominalSlope);
    }
    prevZ = z;
    prevArc = arc[i];
  }
  return maxDev;
}

/** The largest relative gap between the cable's local climb per mm of its own path (over a few samples) and its mean climb per mm, away from the first and last turn. */
function maxCableClimbDistortion(d: Design): number {
  const { points, turns } = d.wirePaths[0];
  const count = points.length / 3;
  const arc = [0];
  for (let i = 1; i < count; i++) arc.push(arc[i - 1] + Math.hypot(points[3 * i] - points[3 * i - 3], points[3 * i + 1] - points[3 * i - 2]));
  const total = arc[count - 1];
  const nominalSlope = (points[3 * (count - 1) + 2] - points[2]) / total;
  const turn = total / turns;
  const WINDOW = 8;
  let worst = 0;
  for (let i = WINDOW; i < count; i++) {
    if (arc[i - WINDOW] < turn || arc[i] > total - turn) continue;
    const localSlope = (points[3 * i + 2] - points[3 * (i - WINDOW) + 2]) / (arc[i] - arc[i - WINDOW]);
    worst = Math.max(worst, Math.abs(localSlope - nominalSlope) / nominalSlope);
  }
  return worst;
}

describe("the groove pitch is constant along the arc length within 2% (issue #103 AC)", () => {
  const cases: Array<[string, CoilSpec["shape"]["kind"]]> = [
    ["round", "round"],
    ["sq", "sq"],
    ["tri", "tri"],
  ];

  for (const [name, kind] of cases) {
    it(`${name}: max local pitch distortion (measured along the groove floor's own arc length) is within 2%`, async () => {
      const d = await design(baseSpec({ shape: shapeSpec(kind) }));
      const distortion = maxLocalPitchDistortion(d.wallSpec);
      expect(distortion * 100).toBeLessThanOrEqual(2);
    });
  }

  it("tri: the fix actually moved the needle (distortion is near-zero, not just under the 2% floor by luck)", async () => {
    const d = await design(baseSpec({ shape: shapeSpec("tri") }));
    const distortion = maxLocalPitchDistortion(d.wallSpec);
    expect(distortion * 100).toBeLessThan(0.01);
  });
});

describe("the drawn cable's climb per mm of its own path is constant within 2% (winding pitch, through design())", () => {
  for (const kind of ["round", "sq", "tri"] as const) {
    it(`${kind}: max local climb distortion along the cable's own path is within 2%`, async () => {
      const d = await design(baseSpec({ shape: shapeSpec(kind) }));
      expect(d.wirePaths[0].turns).toBeGreaterThan(3);
      expect(maxCableClimbDistortion(d) * 100).toBeLessThanOrEqual(2);
    });
  }
});
