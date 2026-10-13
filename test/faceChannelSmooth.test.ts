import Module from "manifold-3d";
import type { ManifoldToplevel } from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import type { CoilMesh, Design } from "../src/core";
import { evalOutline, outlineOffsetAt } from "../src/core/shapes";
import { bendMultiplierOf } from "../src/core/types";
import { worstCurvature } from "./support/cableBend";
import { MIN_WEB, WEB_TOLERANCE, faceWebs } from "./support/faceWeb";
import { CASES, designOf } from "./support/faceCases";
import { unsupportedOverhangs } from "./support/overhangs";
import { rayHits } from "./support/rays";

// Issue #321: the face channels leave the groove and the bore without steps. Through design() only. The rim of each
// channel's junction with the groove, the channel's floor or roof curving into the hole, and the fillet at the foot of
// the bore are probed with rays against the core's mesh, the way a pulled cable would meet them.
//
// D1: a 50 mm square, cap off, one layer, base off. D2: the same with the base on.

type Vec = [number, number, number];

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const coreOf = (d: Design): CoilMesh => d.parts.find((p) => p.role === "core")!.mesh;

function near(mesh: CoilMesh, centre: Vec, reach: number): CoilMesh {
  const P = mesh.positions;
  const kept: number[] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = 3 * mesh.indices[t + k];
      if (Math.abs(P[a] - centre[0]) < reach && Math.abs(P[a + 1] - centre[1]) < reach && Math.abs(P[a + 2] - centre[2]) < reach) {
        kept.push(mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]);
        break;
      }
    }
  }
  return { positions: P, indices: new Uint32Array(kept) };
}

function firstHit(mesh: CoilMesh, origin: Vec, direction: Vec, cap: number): number {
  return Math.min(cap, rayHits(mesh, origin, direction)[0] ?? cap);
}

/** The path's points at `step` mm along it. */
function resample(path: ArrayLike<number>, step: number): Vec[] {
  const out: Vec[] = [];
  let carry = 0;
  for (let i = 3; i < path.length; i += 3) {
    const a: Vec = [path[i - 3], path[i - 2], path[i - 1]];
    const b: Vec = [path[i], path[i + 1], path[i + 2]];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    for (let s = carry; s < length; s += step) out.push([a[0] + ((b[0] - a[0]) * s) / length, a[1] + ((b[1] - a[1]) * s) / length, a[2] + ((b[2] - a[2]) * s) / length]);
    carry = (((carry - length) % step) + step) % step;
  }
  return out;
}

const STATION = 0.25;
const FAN_RAYS = 16;
const FAN_REACH = 4;
const WINDOW = 8;
const WALL_FAN = [13, 14, 15, 0, 1, 2, 3];

function tangentAt(points: Vec[], i: number): Vec {
  const a = points[Math.max(0, i - 1)];
  const b = points[Math.min(points.length - 1, i + 1)];
  const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  return [(b[0] - a[0]) / length, (b[1] - a[1]) / length, (b[2] - a[2]) / length];
}

/**
 * The horizontal normal of the path at every station: it points at the axis where the cable lies on the wall (`anchor`) and
 * keeps its side along the path, so a channel that runs straight at the axis does not flip the fan.
 */
function sideNormals(points: Vec[], anchor: number): Vec[] {
  const horizontal = (i: number): Vec => {
    const t = tangentAt(points, i);
    const length = Math.hypot(t[0], t[1]);
    return [-t[1] / length, t[0] / length, 0];
  };
  const normals: Vec[] = new Array(points.length);
  const p = points[anchor];
  const first = horizontal(anchor);
  normals[anchor] = first[0] * -p[0] + first[1] * -p[1] >= 0 ? first : [-first[0], -first[1], 0];
  for (const step of [1, -1]) {
    for (let i = anchor + step; i >= 0 && i < points.length; i += step) {
      const h = horizontal(i);
      const before = normals[i - step];
      normals[i] = h[0] * before[0] + h[1] * before[1] >= 0 ? h : [-h[0], -h[1], 0];
    }
  }
  return normals;
}

/** Distances from the cable's centre to the core along `FAN_RAYS` directions in the plane normal to the path, direction 0 pointing at the axis. */
function fan(mesh: CoilMesh, points: Vec[], i: number, n: Vec): number[] {
  const t = tangentAt(points, i);
  const p = points[i];
  const s: Vec = [t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]];
  return Array.from({ length: FAN_RAYS }, (_, k) => {
    const angle = (2 * Math.PI * k) / FAN_RAYS;
    const dir: Vec = [0, 1, 2].map((c) => n[c] * Math.cos(angle) + s[c] * Math.sin(angle)) as Vec;
    return firstHit(mesh, p, dir, FAN_REACH);
  });
}

interface Rim {
  step: number;
  clearance: number;
}

/** Where a channel leaves the groove: the largest jump of the wall in any fan direction between stations, and the cable's least clearance. */
function rim(d: Design, path: Float32Array, atStart: boolean): Rim {
  const cable = resample(d.cablePath, STATION);
  const j = atStart ? 0 : path.length - 3;
  const junction: Vec = [path[j], path[j + 1], path[j + 2]];
  let at = 0;
  let nearest = Infinity;
  cable.forEach((q, i) => {
    const gap = Math.hypot(q[0] - junction[0], q[1] - junction[1], q[2] - junction[2]);
    if (gap < nearest) [nearest, at] = [gap, i];
  });
  const mesh = near(coreOf(d), junction, WINDOW + 6);
  const normals = sideNormals(cable, at);
  const from = Math.max(1, at - WINDOW / STATION);
  const to = Math.min(cable.length - 1, at + WINDOW / STATION);
  let step = 0;
  let clearance = Infinity;
  let previous: number[] | undefined;
  for (let i = from; i < to; i++) {
    const rays = fan(mesh, cable, i, normals[i]);
    clearance = Math.min(clearance, ...rays);
    if (previous) for (const k of WALL_FAN) if (rays[k] < FAN_REACH && previous[k] < FAN_REACH) step = Math.max(step, Math.abs(rays[k] - previous[k]));
    previous = rays;
  }
  return { step, clearance: clearance - d.spec.wire.diameter / 2 };
}

/**
 * How far before the hole's edge the channel's floor (top) or roof (bottom) starts to drop away from the cable by more than
 * 0.08 mm: along the centre line, from that station to the first one where the ray runs past the web.
 */
function boreLead(d: Design, face: "top" | "bottom"): number {
  const layout = d.faceChannels!;
  const end = face === "top" ? layout.outer! : layout.inner!;
  const path = resample(face === "top" ? d.outerEndLeadOut : d.innerEndLeadIn, STATION);
  const sign = face === "top" ? -1 : 1;
  const web = face === "top" ? end.level - layout.channelRadius - (layout.height - layout.topThickness!) : layout.bottomThickness - (end.level + layout.channelRadius);
  const cap = layout.channelRadius + web + 0.3;
  let nearestIndex = 0;
  let nearest = Infinity;
  path.forEach((q, i) => {
    const gap = Math.hypot(q[0] - end.hole.x, q[1] - end.hole.y);
    if (gap < nearest && Math.abs(q[2] - end.level) < 0.05) [nearest, nearestIndex] = [gap, i];
  });
  const mesh = near(coreOf(d), [end.hole.x, end.hole.y, end.level], 12);
  const levelled = path.slice(Math.max(0, nearestIndex - 40), nearestIndex + 41).filter((q) => Math.abs(q[2] - end.level) <= 0.05);
  const profile = levelled.map((q) => firstHit(mesh, q, [0, 0, sign], cap));
  const order = face === "top" ? profile.map((_, k) => k) : profile.map((_, k) => profile.length - 1 - k);
  const onFloor = order.slice(order.findIndex((k) => profile[k] < cap - 1e-6));
  let drops = -1;
  let capped = -1;
  onFloor.forEach((k, n) => {
    if (drops < 0 && profile[k] > layout.channelRadius + 0.08) drops = n;
    if (capped < 0 && profile[k] >= cap - 1e-6) capped = n;
  });
  return capped > 0 && drops >= 0 ? (capped - drops) * STATION : 0;
}

const JUMP_STATION = 0.02;
const JUMP_NEAR = 0.45;
const JUMP_FAR = 3;

/** The largest change of the floor (top) or roof (bottom) between stations 0.02 mm apart, from 0.45 to 3 mm outside the hole's edge. */
function floorJump(d: Design, face: "top" | "bottom"): number {
  const layout = d.faceChannels!;
  const end = face === "top" ? layout.outer! : layout.inner!;
  const sign = face === "top" ? -1 : 1;
  const mesh = near(coreOf(d), [end.hole.x, end.hole.y, end.level], 14);
  let worst = 0;
  let previous: number | undefined;
  for (const q of resample(face === "top" ? d.outerEndLeadOut : d.innerEndLeadIn, JUMP_STATION)) {
    const distance = outlineOffsetAt(layout.holeOutline, q[0], q[1]).offset;
    if (Math.abs(q[2] - end.level) > 0.5 || distance < JUMP_NEAR || distance > JUMP_FAR) {
      previous = undefined;
      continue;
    }
    const height = firstHit(mesh, [q[0], q[1], end.level], [0, 0, sign], FAN_REACH);
    if (previous !== undefined) worst = Math.max(worst, Math.abs(height - previous));
    previous = height;
  }
  return worst;
}

/** How far the ledge in the bore rises `FILLET_PROBE` mm from the bore wall, at the middle of a corner, of a side and of the next corner. */
function filletRises(d: Design, radius: number): number[] {
  const layout = d.faceChannels!;
  const mesh = coreOf(d);
  return [0, 1, 2].map((seg) => {
    const p = evalOutline(d.wallSpec.boreOutline, { seg, u: 0.5 }, 0);
    const origin: Vec = [p.x - p.nx * FILLET_PROBE, p.y - p.ny * FILLET_PROBE, layout.bottomThickness + radius + FILLET_CLEAR];
    const hit = rayHits(mesh, origin, [0, 0, -1])[0] ?? Infinity;
    return origin[2] - hit - layout.bottomThickness;
  });
}

function solidCount(mesh: CoilMesh): number {
  const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
  const pieces = m.decompose();
  const n = m.status() === "NoError" ? pieces.length : -1;
  pieces.forEach((p) => p.delete());
  m.delete();
  return n;
}

const FILLET_PROBE = 0.5;
const FILLET_CLEAR = 0.1;

/** The room between the bottom ring's ledge and the top funnel's foot, less the 0.2 mm the round keeps clear of it. */
function filletRoom(d: Design): number {
  const layout = d.faceChannels!;
  return layout.topThickness === undefined ? Infinity : layout.height - layout.topThickness - layout.funnelDepth - layout.bottomThickness - 0.2;
}

const RIM_STEP_MAX = 0.5;
const TOP_RIM_CLEARANCE_MIN = -0.1;
const BORE_LEAD_MIN = 0.5;
const FLOOR_JUMP_MAX = 0.03;
const FILLET_RISE_SLACK = 0.1;

describe.sequential.each(CASES)("face channels without steps (issue #321): $name", (entry) => {
  it("has no step in the wall where the bottom channel leaves the groove", async () => {
    const d = await designOf(entry);
    expect(d.faceChannels, "has face channels").toBeDefined();
    if (d.faceChannels!.inner) expect(rim(d, d.innerEndLeadIn, false).step, "bottom rim step (mm)").toBeLessThanOrEqual(RIM_STEP_MAX);
  });

  it("has no step in the wall, and keeps the cable clear, where the top channel leaves the groove", async () => {
    const d = await designOf(entry);
    const { outer } = d.faceChannels!;
    if (!outer || outer.ramp) return;
    const top = rim(d, d.outerEndLeadOut, true);
    expect(top.step, "top rim step (mm)").toBeLessThanOrEqual(RIM_STEP_MAX);
    expect(top.clearance, "the cable's clearance at the top rim (mm)").toBeGreaterThanOrEqual(TOP_RIM_CLEARANCE_MIN);
  });

  it("curves the bottom channel's roof into the hole before its edge", async () => {
    const d = await designOf(entry);
    if (d.faceChannels!.inner) expect(boreLead(d, "bottom"), "bottom bore lead (mm)").toBeGreaterThanOrEqual(BORE_LEAD_MIN);
  });

  it("curves the top channel's floor into the hole before its edge", async () => {
    const d = await designOf(entry);
    if (d.faceChannels!.outer) expect(boreLead(d, "top"), "top bore lead (mm)").toBeGreaterThanOrEqual(BORE_LEAD_MIN);
  });

  it("starts the bottom channel's roof round without a step", async () => {
    const d = await designOf(entry);
    if (d.faceChannels!.inner) expect(floorJump(d, "bottom"), "roof step between stations (mm)").toBeLessThanOrEqual(FLOOR_JUMP_MAX);
  });

  it("starts the top channel's floor round without a step", async () => {
    const d = await designOf(entry);
    if (d.faceChannels!.outer) expect(floorJump(d, "top"), "floor step between stations (mm)").toBeLessThanOrEqual(FLOOR_JUMP_MAX);
  });

  it("rounds the ledge in the bore where the bottom ring is", async () => {
    const d = await designOf(entry);
    if (!d.faceChannels!.inner) return;
    const radius = Math.min(d.spec.wire.diameter, d.faceChannels!.ringWidth / 2, filletRoom(d));
    const expected = radius - Math.sqrt(radius * radius - (radius - FILLET_PROBE) ** 2);
    expect(expected, "the fillet is wide enough to probe").toBeGreaterThan(0.2);
    for (const rise of filletRises(d, radius)) expect(rise, `ledge rise ${FILLET_PROBE} mm from the bore wall (mm), a round of ${radius.toFixed(2)} mm`).toBeGreaterThanOrEqual(expected - FILLET_RISE_SLACK);
  });

  it("stays one printable solid with the cable inside its bend limit and the webs intact away from the hole", async () => {
    const d = await designOf(entry);
    expect(solidCount(coreOf(d))).toBe(1);
    expect(unsupportedOverhangs(d, entry.name)).toEqual([]);
    const limit = bendMultiplierOf(d.spec.wire) * d.spec.wire.diameter;
    expect(worstCurvature(d.cablePath).k * limit).toBeLessThanOrEqual(1.05);
    const { roof, floor } = faceWebs(d);
    for (const web of [...roof, ...floor]) expect(web).toBeGreaterThanOrEqual(MIN_WEB - WEB_TOLERANCE);
  });
});
