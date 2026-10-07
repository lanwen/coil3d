import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec, Design, MountKind, ShapeSpec, WireTypeId } from "../src/core";
import { bendMultiplierOf } from "../src/core/types";
import { layoutInnerEnd, resolveChannelDepth } from "../src/core/innerEnd";
import { outlineOffsetAt } from "../src/core/shapes";
import { CABLE_CLIP_DEPTH_SLACK } from "../src/core/constants";
import { expectWithinBendLimit } from "./support/cableBend";

// Issue #115: the WHOLE drawn cable -- inner-end lead-in, every wound layer,
// every layer-to-layer transition and the outer end -- is one smooth path
// whose curvature never exceeds 1/MBR (MBR = bend multiplier * diameter).
// Checked through design() only, on the concatenated `cablePath` AND on the
// separate pieces joined end to end (so the per-piece fields and the one
// continuous path can't disagree).

function baseSpec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 3000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: false },
    height: { locked: false },
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

/** The pieces joined end to end, dropping each join's duplicated point. */
function joinedPieces(d: Design): Float32Array {
  const pieces: Float32Array[] = [d.innerEndLeadIn];
  d.wirePaths.forEach((p, i) => {
    pieces.push(p.points);
    if (d.layerTransitions[i]) pieces.push(d.layerTransitions[i]);
  });
  pieces.push(d.outerEndLeadOut);
  const out: number[] = [];
  for (const piece of pieces) {
    for (let i = 0; i < piece.length; i += 3) {
      const n = out.length;
      if (n >= 3 && Math.hypot(piece[i] - out[n - 3], piece[i + 1] - out[n - 2], piece[i + 2] - out[n - 1]) < 1e-4) continue;
      out.push(piece[i], piece[i + 1], piece[i + 2]);
    }
  }
  return new Float32Array(out);
}

/** Largest gap between consecutive samples (mm). */
function maxGap(points: Float32Array): number {
  let gap = 0;
  for (let i = 3; i < points.length; i += 3) gap = Math.max(gap, Math.hypot(points[i] - points[i - 3], points[i + 1] - points[i - 2], points[i + 2] - points[i - 1]));
  return gap;
}

/**
 * Issue #195: every named piece of the wound cable -- lead-in, each layer,
 * each layer-to-layer step, lead-out -- checked on its own, with the
 * neighbouring pieces' adjoining samples so the joins are covered too, plus
 * the whole `cablePath`. A failure names the piece.
 */
function expectEveryBendWithinLimit(d: Design, mbr: number) {
  const pieces: Array<{ name: string; points: Float32Array }> = [{ name: "lead-in", points: d.innerEndLeadIn }];
  d.wirePaths.forEach((p, i) => {
    pieces.push({ name: `layer ${p.layer}`, points: p.points });
    if (d.layerTransitions[i]) pieces.push({ name: `step from layer ${p.layer} to layer ${p.layer + 1}`, points: d.layerTransitions[i] });
  });
  pieces.push({ name: "lead-out", points: d.outerEndLeadOut });
  const same = (a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number) => Math.hypot(a[i] - b[j], a[i + 1] - b[j + 1], a[i + 2] - b[j + 2]) < 1e-4;
  pieces.forEach(({ name, points }, i) => {
    const before = pieces[i - 1]?.points;
    const after = pieces[i + 1]?.points;
    const out: number[] = [];
    // The previous piece's last sample that isn't this piece's first.
    if (before && before.length >= 6) out.push(...before.slice(same(before, before.length - 3, points, 0) ? before.length - 6 : before.length - 3, before.length - (same(before, before.length - 3, points, 0) ? 3 : 0)));
    out.push(...points);
    if (after && after.length >= 6) out.push(...after.slice(same(after, 0, points, points.length - 3) ? 3 : 0, same(after, 0, points, points.length - 3) ? 6 : 3));
    expectWithinBendLimit(new Float32Array(out), mbr, name);
  });
  expectWithinBendLimit(d.cablePath, mbr, "cablePath");
}

/**
 * Issue #117: the fix points. The cable is clipped along its own direction
 * and leaves the part through the rim with no extra bend: from the clip to
 * its free end past the rim it runs level (no turn up or down into a hole)
 * and within the bend radius -- at the inner end through the flange clip,
 * at the outer end (cap on) through the cap's clip.
 */
function expectFixPointsWithinBendLimit(d: Design, mbr: number, label: string) {
  const bendRadius = mbr;
  const layout = layoutInnerEnd(d.flangeSpec.outline, d.flangeSpec.margin, d.spec.wire.diameter, d.spec.tolerance, bendRadius, resolveChannelDepth(d.spec.wire.diameter, d.flangeSpec.thickness));
  const lead = d.innerEndLeadIn;
  // From the free end up to the clip's far end (the one nearer the groove).
  const tail = layout.leadIn[0];
  const reach = Math.hypot(layout.clip.from.x - tail.x, layout.clip.from.y - tail.y);
  const segment: number[] = [];
  for (let i = 0; i < lead.length; i += 3) {
    if (Math.hypot(lead[i] - tail.x, lead[i + 1] - tail.y) > reach) break;
    segment.push(lead[i], lead[i + 1], lead[i + 2]);
  }
  const fix = new Float32Array(segment);
  expect(fix.length / 3, `${label}: inner fix-point segment samples`).toBeGreaterThanOrEqual(4);
  // Level from the clip's rim end out (the lips may start while the cable
  // settles the last CABLE_CLIP_DEPTH_SLACK into the channel).
  const level = Math.hypot(layout.clip.to.x - tail.x, layout.clip.to.y - tail.y);
  for (let i = 2; i < fix.length; i += 3) {
    const along = Math.hypot(fix[i - 2] - tail.x, fix[i - 1] - tail.y);
    if (along <= level) expect(fix[i], `${label}: the inner end leaves level through the clip and the rim`).toBeCloseTo(fix[2], 6);
    else expect(fix[i] - fix[2], `${label}: nearly level through the rest of the clip`).toBeLessThanOrEqual(CABLE_CLIP_DEPTH_SLACK + 1e-6);
  }
  expect(outlineOffsetAt(d.flangeSpec.outline, fix[0], fix[1]).offset, `${label}: the inner end leaves past the rim`).toBeGreaterThan(d.flangeSpec.margin);
  expectWithinBendLimit(fix, mbr, `${label}: inner fix point`);

  // Issue #241: with the cap on, the outer end runs level just under the cap
  // and curves out past the rim (under the cap's rim slot), within the bend
  // limit, joined to the lead-out without a kink.
  if (d.parts.some((p) => p.role === "topCap")) {
    const out = d.outerEndLeadOut;
    const n = out.length / 3;
    const zKey = out[n * 3 - 1];
    expect(zKey + d.spec.wire.diameter / 2, `${label}: the outer end runs just under the cap`).toBeCloseTo(d.solution.height - 0.1, 4);
    let first = n - 1;
    while (first > 0 && Math.abs(out[first * 3 - 1] - zKey) < 1e-6) first--;
    expect(n - first, `${label}: a level run out from under the cap`).toBeGreaterThanOrEqual(4);
    expectWithinBendLimit(out.slice(Math.max(0, first - 1) * 3), mbr, `${label}: cap end`);
    expect(outlineOffsetAt(d.flangeSpec.outline, out[n * 3 - 3], out[n * 3 - 2]).offset, `${label}: the outer end leads out past the rim`).toBeGreaterThan(d.flangeSpec.margin);
  }
}

const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 10 }, { kind: "tri", cornerRadius: 10 }];
const TYPES: Array<{ type: WireTypeId; diameter: number }> = [
  { type: "usb", diameter: 3.8 },
  { type: "flex", diameter: 2.5 },
  { type: "stiff", diameter: 3.6 },
];
const MOUNTS: MountKind[] = ["none", "keyhole", "through", "skadis", "opengrid"];

describe("the whole cable respects the bend radius (issue #115)", () => {
  it("the user's repro (stiff 3.6 mm, 132 mm round core, 3 layers, cap off, keyhole mount)", async () => {
    const d = await design(
      baseSpec({
        wire: { length: 3710, diameter: 3.6, type: "stiff" },
        coreSize: { locked: true, dimension: "outer", value: 132 },
        layers: { locked: true, value: 3 },
        topCap: "off",
        mount: "keyhole",
      }),
    );
    const mbr = bendMultiplierOf(d.spec.wire) * d.spec.wire.diameter;
    expectWithinBendLimit(joinedPieces(d), mbr, "repro joined pieces");
    expectWithinBendLimit(d.cablePath, mbr, "repro cablePath");
    expectFixPointsWithinBendLimit(d, mbr, "repro");
  });

  // Issue #195: the solver reported "ok" for a round core locked below the
  // bend limit's size floor. Minimal repro: the default design (round, outer
  // 30 mm locked) with a stiff cable and 2 layers -- layer 1 and the step to
  // layer 2 bent at ~15 mm against a stiff cable's bend radius (then 36 mm).
  it("the default round 30 mm core with a stiff cable and 2 layers (issue #195)", async () => {
    const spec = baseSpec({
      wire: { length: 2000, diameter: 3.6, type: "stiff" },
      coreSize: { locked: true, dimension: "outer", value: 30 },
      layers: { locked: true, value: 2 },
    });
    const d = await design(spec);
    expect(d.solution.diagnosis.status).toBe("ok");
    expectEveryBendWithinLimit(d, bendMultiplierOf(spec.wire) * spec.wire.diameter);
    expect(d.warnings.filter((w) => /bends tighter/i.test(w))).toEqual([]);
    expect(d.solution.outerSize, "the locked size is raised to the bend-limit floor").toBeCloseTo(d.solution.minOuterSizeForBend, 6);
    expect(d.warnings.some((w) => /core size raised/i.test(w))).toBe(true);
  });

  let caseIndex = 0;
  for (const shape of SHAPES) {
    for (const { type, diameter } of TYPES) {
      for (let layers = 1; layers <= 5; layers++) {
        for (const topCap of ["on", "off"] as const) {
          const mount = MOUNTS[caseIndex++ % MOUNTS.length];
          it(`shape=${shape.kind} type=${type} layers=${layers} cap=${topCap} mount=${mount}`, async () => {
            const spec = baseSpec({ shape, wire: { length: 3000, diameter, type }, layers: { locked: true, value: layers }, topCap, mount });
            const d = await design(spec);
            const mbr = bendMultiplierOf(spec.wire) * diameter;
            expect(d.wirePaths).toHaveLength(layers);
            const joined = joinedPieces(d);
            expectWithinBendLimit(joined, mbr, "joined pieces");
            // The pieces join into exactly the one continuous path, with no
            // jumps anywhere along it.
            expect(joined.length).toBe(d.cablePath.length);
            expectWithinBendLimit(d.cablePath, mbr, "cablePath");
            expect(maxGap(d.cablePath), "cablePath: largest step between samples").toBeLessThan(5);
            expectFixPointsWithinBendLimit(d, mbr, "fix points");
            expect(d.rimSlots.cap !== undefined, "a cap rim slot exactly when the cap is on").toBe(d.parts.some((p) => p.role === "topCap"));
          });
        }
      }
    }
  }
});

// Issue #195: "ok" means the cable fits within its bend radius everywhere --
// including where it steps from one layer to the next -- not only for a free
// core size the solver chose itself, but also for a locked one (round, square
// and triangle, locked below and above the bend limit's size floor).
describe("an ok design never bends the cable tighter than its bend radius (issue #195)", () => {
  const CORES: Array<CoilSpec["coreSize"]> = [
    { locked: false },
    { locked: true, dimension: "outer", value: 30 },
    { locked: true, dimension: "inner", value: 60 },
  ];
  const BEND_SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 2 }, { kind: "tri", cornerRadius: 2 }];
  let ok = 0;
  for (const shape of BEND_SHAPES) {
    for (const { type, diameter } of TYPES) {
      for (const coreSize of CORES) {
        for (const layers of [2, 3]) {
          const core = coreSize.locked ? `${coreSize.dimension} ${coreSize.value} mm` : "free";
          it(`shape=${shape.kind} type=${type} core=${core} layers=${layers}`, async () => {
            const spec = baseSpec({ shape, wire: { length: 2000, diameter, type }, coreSize, layers: { locked: true, value: layers } });
            const d = await design(spec);
            if (d.solution.diagnosis.status !== "ok") return;
            ok++;
            expectEveryBendWithinLimit(d, bendMultiplierOf(spec.wire) * diameter);
            expect(d.warnings.filter((w) => /bends tighter/i.test(w))).toEqual([]);
          });
        }
      }
    }
  }
  it("checked enough ok designs to mean something", () => {
    expect(ok).toBeGreaterThanOrEqual(40);
  });
});

// Issue #254: a bare core's cable ends leave the winding onto a flat end face and turn through the hole
// (src/core/faceChannel.ts). The whole path, the winding, the exit onto the face, the arc and the bend at the
// hole, holds the bend radius, in every piece and joined.
describe("a bare core's whole cable respects the bend radius (issue #254)", () => {
  for (const shape of SHAPES) {
    for (const { type, diameter } of TYPES) {
      for (const layers of [1, 2, 3]) {
        for (const topCap of ["on", "off"] as const) {
          it(`shape=${shape.kind} type=${type} layers=${layers} cap=${topCap} base=off`, async () => {
            const spec = baseSpec({ shape, wire: { length: 3000, diameter, type }, layers: { locked: true, value: layers }, topCap, base: "off" });
            const d = await design(spec);
            const mbr = bendMultiplierOf(spec.wire) * diameter;
            expect(d.faceChannels, "the ends use the face channels").toBeDefined();
            expect(d.wirePaths).toHaveLength(layers);
            expectEveryBendWithinLimit(d, mbr);
            const joined = joinedPieces(d);
            expect(joined.length).toBe(d.cablePath.length);
            expectWithinBendLimit(joined, mbr, "joined pieces");
            expect(maxGap(d.cablePath), "cablePath: largest step between samples").toBeLessThan(5);
            expect(d.innerEndLeadIn[2], "the inner end rises to the top face").toBeCloseTo(d.solution.height, 4);
            expect(d.warnings.filter((w) => /bends tighter/i.test(w))).toEqual([]);
          });
        }
      }
    }
  }
});
