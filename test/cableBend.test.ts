import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec, Design, MountKind, ShapeSpec, WireTypeId } from "../src/core";
import { bendMultiplierOf } from "../src/core/types";
import { layoutInnerEnd, resolveChannelDepth } from "../src/core/innerEnd";
import { outlineOffsetAt } from "../src/core/shapes";
import { CABLE_CLIP_DEPTH_SLACK } from "../src/core/constants";

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
    joint: "press",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    mount: "none",
    plateJoint: "glue",
    ...overrides,
  };
}

type P3 = [number, number, number];

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
 * Discrete curvature at every interior sample: the turning angle between the
 * two adjoining segments divided by their mean length. Returns the worst
 * sample (curvature and position), so a failure names WHERE the cable bends
 * too sharply.
 */
function worstCurvature(points: Float32Array): { k: number; at: P3; index: number } {
  const p = (i: number): P3 => [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]];
  const n = points.length / 3;
  let worst = { k: 0, at: [0, 0, 0] as P3, index: -1 };
  for (let i = 1; i + 1 < n; i++) {
    const a = p(i - 1);
    const b = p(i);
    const c = p(i + 1);
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const bc = Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
    if (ab < 1e-6 || bc < 1e-6) continue;
    const dot = ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) + (b[2] - a[2]) * (c[2] - b[2])) / (ab * bc);
    const k = Math.acos(Math.max(-1, Math.min(1, dot))) / ((ab + bc) / 2);
    if (k > worst.k) worst = { k, at: b, index: i };
  }
  return worst;
}

function expectWithinBendLimit(points: Float32Array, mbr: number, label: string) {
  expect(points.length, `${label}: has samples`).toBeGreaterThanOrEqual(6);
  const w = worstCurvature(points);
  const where = `sample ${w.index} at (${w.at.map((v) => v.toFixed(1)).join(", ")}), bend radius ${(1 / w.k).toFixed(2)} mm vs MBR ${mbr.toFixed(1)} mm`;
  expect(w.k * mbr, `${label}: sharpest bend at ${where}`).toBeLessThanOrEqual(1.05);
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

  if (d.capClip) {
    const out = d.outerEndLeadOut;
    const n = d.capClip.clips[0].path.length;
    const capSegment = out.slice(out.length - 3 * n);
    for (let i = 2; i < capSegment.length; i += 3) expect(capSegment[i], `${label}: the outer end runs level through the cap clip and out`).toBeCloseTo(capSegment[2], 6);
    // With the lead-out's last sample before it, so the join is covered too.
    expectWithinBendLimit(out.slice(out.length - 3 * (n + 1)), mbr, `${label}: cap fix point`);
    // Issue #121: the cap has several clips, each the first one's layout
    // moved along the outline; a cable end through any of them runs level
    // (by construction: its path is plan-view only) and out past the rim
    // within the bend limit.
    expect(d.capClip.clips.length, `${label}: clips around the cap`).toBeGreaterThanOrEqual(2);
    d.capClip.clips.forEach((clip, i) => {
      expectWithinBendLimit(new Float32Array(clip.path.flatMap((p) => [p.x, p.y, 0])), mbr, `${label}: cap clip ${i}`);
      const end = clip.path[clip.path.length - 1];
      expect(outlineOffsetAt(d.flangeSpec.outline, end.x, end.y).offset, `${label}: cap clip ${i} leads out past the rim`).toBeGreaterThan(d.flangeSpec.margin);
    });
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
    expectWithinBendLimit(joinedPieces(d), 36, "repro joined pieces");
    expectWithinBendLimit(d.cablePath, 36, "repro cablePath");
    expectFixPointsWithinBendLimit(d, 36, "repro");
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
            expect(d.capClip !== undefined, "a cap clip exactly when the cap is on").toBe(d.parts.some((p) => p.role === "topCap"));
          });
        }
      }
    }
  }
});
