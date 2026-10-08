import { describe, expect, it } from "vitest";
import { design, exportDesign } from "../src/core";
import type { CoilSpec, Design, ShapeSpec } from "../src/core";
import type { FaceEnd } from "../src/core/faceChannel";
import { outlineOffsetAt } from "../src/core/shapes";
import { grooveShape } from "../src/core/wall";
import { STEP_TIMEOUT_MS, insideAt, perPartVolumeErrors, reimportStep, verticalCrossings } from "./support/step";

// Issue #287: the bare core's STEP is built from sewn faces with one boolean for the channels. The probes sit on each
// channel's centre line, a hair either side of every surface the mesh has there, so a channel missing from the STEP
// (or cut to the wrong depth) shows up as a point that is inside one model and outside the other.
const SAMPLES = 4;

function bareSpec(shape: ShapeSpec, layers: number): CoilSpec {
  return {
    wire: { length: 2000, diameter: 3.8, type: "usb" },
    shape,
    windingQuality: 0.7,
    coreSize: { locked: false },
    height: { locked: false },
    layers: { locked: true, value: layers },
    objective: "minVolume",
    base: "off",
    topCap: "off",
    joint: "press",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    mount: "none",
    plateJoint: "glue",
  };
}

type Probe = [number, number, number];

function endProbes(d: Design, path: Float32Array, end: FaceEnd): { points: Probe[]; expected: boolean[]; crossings: number } {
  const layout = d.faceChannels!;
  const core = d.parts.find((p) => p.role === "core")!.mesh;
  const onFace: Array<[number, number]> = [];
  for (let i = 0; i < path.length / 3; i++) {
    const [x, y, z] = [path[3 * i], path[3 * i + 1], path[3 * i + 2]];
    if (Math.abs(z - end.level) > 0.3) continue;
    if (outlineOffsetAt(layout.holeOutline, x, y).offset < 0.3) continue;
    if (outlineOffsetAt(d.wallSpec.outline, x, y).offset > -(grooveShape(d.spec.wire.diameter).depth + 0.5)) continue;
    onFace.push([x, y]);
  }
  const points: Probe[] = [];
  const expected: boolean[] = [];
  let crossingCount = 0;
  const samples = Array.from({ length: SAMPLES }, (_, k) => onFace[Math.floor(((k + 0.5) * onFace.length) / SAMPLES)]).filter(Boolean);
  for (const [x, y] of samples) {
    const crossings = verticalCrossings(core, x, y);
    const near = crossings.filter((z) => Math.abs(z - end.level) < layout.channelRadius + 2);
    crossingCount += near.length;
    for (const z of [end.level, ...near.flatMap((c) => [c - 0.15, c + 0.15])]) {
      points.push([x, y, z]);
      expected.push(insideAt(crossings, z));
    }
  }
  return { points, expected, crossings: crossingCount };
}

describe.sequential("STEP/OCCT export: bare cores with face channels (issue #287)", () => {
  it.each([
    ["round", { kind: "round" }, 1],
    ["rounded square", { kind: "sq", cornerRadius: 12 }, 1],
    ["triangle", { kind: "tri", cornerRadius: 12 }, 1],
    ["triangle, two layers", { kind: "tri", cornerRadius: 12 }, 2],
  ] as const)(
    "re-imports a %s core as one valid solid whose channels match the mesh",
    async (_name, shape, layers) => {
      const d = await design(bareSpec(shape, layers));
      expect(d.faceChannels?.inner).toBeDefined();
      const bytes = await exportDesign(d, "step");
      const probed = [endProbes(d, d.innerEndLeadIn, d.faceChannels!.inner!), ...(d.faceChannels!.outer ? [endProbes(d, d.outerEndLeadOut, d.faceChannels!.outer)] : [])];
      for (const probe of probed) expect(probe.crossings, "each channel has surfaces to probe").toBeGreaterThanOrEqual(SAMPLES);
      const points = probed.flatMap((probe) => probe.points);
      const expected = probed.flatMap((probe) => probe.expected);
      expect(expected.includes(true) && expected.includes(false)).toBe(true);
      const { valid, solidVolumes, inside } = await reimportStep(bytes, "reimport-face-channel", points);
      expect(valid).toBe(true);
      expect(solidVolumes.length).toBe(1);
      for (const err of perPartVolumeErrors(solidVolumes, d.parts)) expect(err).toBeLessThan(0.005);
      expect(inside).toEqual(expected);
    },
    STEP_TIMEOUT_MS,
  );
});
