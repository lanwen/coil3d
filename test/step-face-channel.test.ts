import { describe, expect, it } from "vitest";
import { design, exportDesign } from "../src/core";
import type { CoilSpec, Design, ShapeSpec } from "../src/core";
import type { FaceEnd } from "../src/core/faceChannel";
import { FACE_ARC_JOINT_OVERLAP } from "../src/core/constants";
import { evalOutline, outlineOffsetAt } from "../src/core/shapes";
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

const FILLET_PROBE_INSET = 0.5;
const DIP_SPAN = 2;

// Issue #321: the ledge in the bore is rounded and each channel's floor or roof curves into the hole. Probes sit a hair
// either side of every surface the mesh has on vertical lines 0.5 mm inside the bore wall (the fillet) and on each
// channel's centre line within 2 mm of the hole's edge (the curved floor or roof).
function boreProbes(d: Design): { points: Probe[]; expected: boolean[]; crossings: number } {
  const layout = d.faceChannels!;
  const core = d.parts.find((p) => p.role === "core")!.mesh;
  const columns: Array<[number, number]> = [0, 1, 2].map((seg) => {
    const p = evalOutline(d.wallSpec.boreOutline, { seg, u: 0.5 }, 0);
    return [p.x - p.nx * FILLET_PROBE_INSET, p.y - p.ny * FILLET_PROBE_INSET];
  });
  const along = (path: Float32Array, end: FaceEnd) => {
    const onChannel: Array<[number, number]> = [];
    for (let i = 0; i < path.length / 3; i++) {
      const [x, y, z] = [path[3 * i], path[3 * i + 1], path[3 * i + 2]];
      const offset = outlineOffsetAt(layout.holeOutline, x, y).offset;
      if (Math.abs(z - end.level) < 0.05 && offset > 0.1 && offset < DIP_SPAN) onChannel.push([x, y]);
    }
    return [0.2, 0.5, 0.8].map((f) => onChannel[Math.floor(f * onChannel.length)]).filter(Boolean);
  };
  const lines = [
    ...columns.map((c) => ({ at: c, lo: layout.bottomThickness - 1, hi: layout.bottomThickness + layout.ringWidth })),
    ...(layout.inner ? along(d.innerEndLeadIn, layout.inner).map((c) => ({ at: c, lo: layout.inner!.level - 2, hi: layout.inner!.level + 4 })) : []),
    ...(layout.outer ? along(d.outerEndLeadOut, layout.outer).map((c) => ({ at: c, lo: layout.outer!.level - 4, hi: layout.outer!.level + 2 })) : []),
  ];
  const points: Probe[] = [];
  const expected: boolean[] = [];
  let crossingCount = 0;
  for (const { at, lo, hi } of lines) {
    const crossings = verticalCrossings(core, at[0], at[1]);
    const near = crossings.filter((z) => z > lo && z < hi);
    crossingCount += near.length;
    for (const z of near.flatMap((c) => [c - 0.15, c + 0.15])) {
      points.push([at[0], at[1], z]);
      expected.push(insideAt(crossings, z));
    }
  }
  return { points, expected, crossings: crossingCount };
}

const START_INSET = 0.02;
const START_BEHIND = 0.05;

// Issue #321: the wall's cavity reaches past the cutter's start face, so the face leaves no sliver of wall in the channel's
// section. Probes sit 0.02 mm inside the section just before the face: along its wall on the open side and around its dome.
function startProbes(d: Design): { points: Probe[]; inMesh: boolean[] } {
  const layout = d.faceChannels!;
  const core = d.parts.find((p) => p.role === "core")!.mesh;
  const r = layout.channelRadius - START_INSET;
  const points: Probe[] = [];
  const inMesh: boolean[] = [];
  for (const [end, open] of [[layout.inner, -1], [layout.outer, 1]] as const) {
    if (!end) continue;
    const arc = end.arcs[0];
    const sign = Math.sign(arc.sweep);
    const section: Array<[number, number]> = [
      [-r, 0],
      [-r, open * 0.6],
      [-r, open * 1.2],
      [r * Math.cos((135 * Math.PI) / 180), -open * r * Math.sin((135 * Math.PI) / 180)],
      [r * Math.cos((160 * Math.PI) / 180), -open * r * Math.sin((160 * Math.PI) / 180)],
    ];
    const angle = arc.from - (sign * (FACE_ARC_JOINT_OVERLAP + START_BEHIND)) / arc.radius;
    for (const [lat, dz] of section) {
      const x = arc.centre.x + (arc.radius + lat) * Math.cos(angle);
      const y = arc.centre.y + (arc.radius + lat) * Math.sin(angle);
      points.push([x, y, end.level + dz]);
      inMesh.push(insideAt(verticalCrossings(core, x, y), end.level + dz));
    }
  }
  return { points, inMesh };
}

describe.sequential("STEP/OCCT export: the bore's ledge fillet and edge rounds (issue #321)", () => {
  const pill: CoilSpec = { ...bareSpec({ kind: "pill", cornerRadius: 15 }, 1), wire: { length: 3000, diameter: 3.8, type: "usb" }, coreSize: { locked: true, dimension: "outer", value: 100 }, height: { locked: true, value: 40 } };
  it.each([
    ["rounded square", bareSpec({ kind: "sq", cornerRadius: 12 }, 1)],
    ["pill", pill],
  ] as const)(
    "re-imports a %s core with its ledge fillet and curved channel ends as one solid that matches the mesh",
    async (_name, spec) => {
      const d = await design(spec);
      expect(d.faceChannels?.inner).toBeDefined();
      expect(d.faceChannels?.outer).toBeDefined();
      const bytes = await exportDesign(d, "step");
      const probe = boreProbes(d);
      const start = startProbes(d);
      expect(probe.crossings, "surfaces to probe").toBeGreaterThanOrEqual(12);
      expect(probe.expected.includes(true) && probe.expected.includes(false)).toBe(true);
      expect(start.inMesh.includes(true), "wall inside a channel's section just before its start face, in the mesh").toBe(false);
      const { valid, solidVolumes, inside: all } = await reimportStep(bytes, "reimport-bore-rounds", [...probe.points, ...start.points]);
      const inside = all.slice(0, probe.points.length);
      expect(all.slice(probe.points.length).includes(true), "wall inside a channel's section just before its start face, in the STEP").toBe(false);
      expect(valid).toBe(true);
      expect(solidVolumes.length).toBe(1);
      for (const err of perPartVolumeErrors(solidVolumes, d.parts)) expect(err).toBeLessThan(0.005);
      expect(inside).toEqual(probe.expected);
    },
    STEP_TIMEOUT_MS,
  );
});

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
