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
// untouched, see shapes.ts's `arcLengthFractionAt`).
//
// `arcLengthFractionAt`'s own correctness is checked here against an
// independent brute-force arc-length integrator (same oracle style as
// test/shapes-radius-at-angle.test.ts's `bruteForceRadius.ts`, never
// reusing `arcLengthFractionAt`'s own formula), and the ticket's actual
// acceptance criterion -- "the groove pitch is constant along the arc
// length within 2%" -- is checked end-to-end through the public `design()`
// interface's own `wallSpec`, for round/sq/tri.

import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec, ShapeKind } from "../src/core";

function shapeSpec(kind: ShapeKind): CoilSpec["shape"] {
  return kind === "round" ? { kind } : { kind, cornerRadius: 15 };
}
import { arcLengthFractionAt, pointAt } from "../src/core/shapes";
import type { ShapeOutline } from "../src/core/shapes";
import { createWallProfile } from "../src/core/wall";
import type { WallSpec } from "../src/core/wall";

/** Independent oracle: true arc length from t=0 to t (at the given offset),
 * by brute-force polyline integration -- never calls `arcLengthFractionAt`. */
function bruteForceArcLengthFraction(o: ShapeOutline, offset: number, t: number, samples = 20_000): number {
  let s = 0;
  let total = 0;
  let prev = pointAt(o, 0, offset);
  for (let i = 1; i <= samples; i++) {
    const ti = i / samples;
    const p = pointAt(o, ti, offset);
    const seg = Math.hypot(p.x - prev.x, p.y - prev.y);
    total += seg;
    if (ti <= t) s += seg;
    prev = p;
  }
  return s / total;
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

describe("arcLengthFractionAt matches a brute-force arc-length integrator (issue #103)", () => {
  const round: ShapeOutline = { n: 4, apothem: 20, cornerRadius: 20 };
  const sq: ShapeOutline = { n: 4, apothem: 20, cornerRadius: 8 };
  const tri: ShapeOutline = { n: 3, apothem: 20, cornerRadius: 8 };

  const cases: [string, ShapeOutline][] = [
    ["round", round],
    ["sq", sq],
    ["tri", tri],
  ];
  const OFFSETS = [0, -0.5, -2, 3];
  const TS = [0, 0.05, 0.13, 0.25, 0.37, 0.5, 0.61, 0.75, 0.9, 0.99];

  for (const [name, outline] of cases) {
    for (const offset of OFFSETS) {
      it(`${name} at offset=${offset}mm matches the brute-force oracle within 0.2%`, () => {
        for (const t of TS) {
          const expected = bruteForceArcLengthFraction(outline, offset, t);
          const actual = arcLengthFractionAt(outline, offset, t);
          expect(Math.abs(actual - expected), `t=${t}: got ${actual}, expected ${expected}`).toBeLessThanOrEqual(0.002);
        }
      });
    }
  }

  it("reduces to t exactly for round (no corners to distort)", () => {
    for (const offset of OFFSETS) {
      for (const t of TS) {
        expect(arcLengthFractionAt(round, offset, t)).toBeCloseTo(t, 9);
      }
    }
  });
});

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
