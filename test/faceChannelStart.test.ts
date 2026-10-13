import { describe, expect, it } from "vitest";
import type { CoilMesh, Design } from "../src/core";
import { FACE_ARC_JOINT_OVERLAP } from "../src/core/constants";
import { CASES, designOf } from "./support/faceCases";

// Issue #321: where a face channel's cutter starts, the wall must meet it without an edge the line art draws. The viewer
// draws a crease from 30 degrees; every transverse edge around the cutter's start face must stay under 20, and no face
// may stand across the channel at the start.

const DRAW_DEGREES = 30;
const MAX_CREASE = DRAW_DEGREES - 10;
// Where the wall crosses the cutter's dome obliquely the boolean leaves skinny triangles (a pill's 0.026 mm, an HDMI core's
// 0.047 mm) and edges under 0.1 mm: both are below a pixel at the viewer's default zoom, so they draw nothing.
const SLIVER_ALTITUDE = 0.05;
const MIN_EDGE = 0.1;
const ZONE_REACH = 4;
const WELD = 1e4;
const ZONE_BEFORE = 1.5;
const ZONE_AFTER = 3;
const LATERAL_AFTER = 0.05;
const FACING_BACK = 0.7;
const FACE_BAND = 0.2;

interface Frame {
  local(x: number, y: number, z: number): { s: number; lat: number; dz: number };
  tangent(x: number, y: number): [number, number];
  start: [number, number, number];
}

function frameOf(d: Design, end: "inner" | "outer"): Frame | undefined {
  const layout = d.faceChannels!;
  const channel = layout[end];
  if (!channel) return undefined;
  const arc = channel.arcs[0];
  const sign = Math.sign(arc.sweep);
  return {
    start: [arc.centre.x + arc.radius * Math.cos(arc.from), arc.centre.y + arc.radius * Math.sin(arc.from), channel.level],
    local(x, y, z) {
      let a = Math.atan2(y - arc.centre.y, x - arc.centre.x) - arc.from;
      while (a > Math.PI) a -= 2 * Math.PI;
      while (a < -Math.PI) a += 2 * Math.PI;
      return { s: sign * a * arc.radius, lat: Math.hypot(x - arc.centre.x, y - arc.centre.y) - arc.radius, dz: z - channel.level };
    },
    tangent(x, y) {
      const length = Math.hypot(x - arc.centre.x, y - arc.centre.y);
      return [(-sign * (y - arc.centre.y)) / length, (sign * (x - arc.centre.x)) / length];
    },
  };
}

interface Face {
  n: [number, number, number];
  altitude: number;
}

function faceOf(P: Float32Array, a: number, b: number, c: number): Face {
  const u = [0, 1, 2].map((k) => P[3 * b + k] - P[3 * a + k]);
  const v = [0, 1, 2].map((k) => P[3 * c + k] - P[3 * a + k]);
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.hypot(n[0], n[1], n[2]);
  const longest = Math.max(Math.hypot(u[0], u[1], u[2]), Math.hypot(v[0], v[1], v[2]), Math.hypot(v[0] - u[0], v[1] - u[1], v[2] - u[2]));
  return { n: [n[0] / (length || 1), n[1] / (length || 1), n[2] / (length || 1)], altitude: length / (longest || 1) };
}

interface Start {
  creases: number;
  worst: number;
  facing: number;
  where: string;
}

function startOf(d: Design, end: "inner" | "outer"): Start | undefined {
  const frame = frameOf(d, end);
  if (!frame) return undefined;
  const layout = d.faceChannels!;
  const offset = d.spec.wire.diameter / 2 - d.wallSpec.grooveDepth;
  const mesh: CoilMesh = d.parts.find((p) => p.role === "core")!.mesh;
  const P = mesh.positions;
  const I = mesh.indices;
  const ids = new Map<string, number>();
  const weld = (v: number): number => {
    const key = `${Math.round(P[3 * v] * WELD)},${Math.round(P[3 * v + 1] * WELD)},${Math.round(P[3 * v + 2] * WELD)}`;
    let id = ids.get(key);
    if (id === undefined) ids.set(key, (id = ids.size));
    return id;
  };
  const reach = ZONE_AFTER + 3;
  const edges = new Map<string, { faces: Face[]; a: number; b: number }>();
  let facing = 0;
  for (let t = 0; t < I.length; t += 3) {
    const vs = [I[t], I[t + 1], I[t + 2]];
    if (!vs.some((v) => Math.hypot(P[3 * v] - frame.start[0], P[3 * v + 1] - frame.start[1], P[3 * v + 2] - frame.start[2]) < reach)) continue;
    const face = faceOf(P, vs[0], vs[1], vs[2]);
    const cx = (P[3 * vs[0]] + P[3 * vs[1]] + P[3 * vs[2]]) / 3;
    const cy = (P[3 * vs[0] + 1] + P[3 * vs[1] + 1] + P[3 * vs[2] + 1]) / 3;
    const cz = (P[3 * vs[0] + 2] + P[3 * vs[1] + 2] + P[3 * vs[2] + 2]) / 3;
    const at = frame.local(cx, cy, cz);
    const [tx, ty] = frame.tangent(cx, cy);
    if (
      face.altitude >= SLIVER_ALTITUDE &&
      Math.abs(at.s + FACE_ARC_JOINT_OVERLAP) <= FACE_BAND &&
      at.lat <= -offset &&
      at.lat >= -layout.channelRadius - 0.3 &&
      Math.abs(face.n[0] * tx + face.n[1] * ty) > FACING_BACK
    ) {
      facing++;
    }
    for (let k = 0; k < 3; k++) {
      const a = vs[k];
      const b = vs[(k + 1) % 3];
      const x = weld(a);
      const y = weld(b);
      const key = x < y ? `${x}_${y}` : `${y}_${x}`;
      const edge = edges.get(key);
      if (edge) edge.faces.push(face);
      else edges.set(key, { faces: [face], a, b });
    }
  }
  let creases = 0;
  let worst = 0;
  let where = "";
  for (const { faces, a, b } of edges.values()) {
    if (faces.length !== 2 || Math.min(faces[0].altitude, faces[1].altitude) < SLIVER_ALTITUDE) continue;
    const mx = (P[3 * a] + P[3 * b]) / 2;
    const my = (P[3 * a + 1] + P[3 * b + 1]) / 2;
    const mz = (P[3 * a + 2] + P[3 * b + 2]) / 2;
    if (Math.hypot(mx - frame.start[0], my - frame.start[1], mz - frame.start[2]) > ZONE_REACH) continue;
    const at = frame.local(mx, my, mz);
    if (at.s < -FACE_ARC_JOINT_OVERLAP - ZONE_BEFORE || at.s > ZONE_AFTER || at.lat > LATERAL_AFTER || at.lat < -layout.channelRadius - 0.8) continue;
    const la = frame.local(P[3 * a], P[3 * a + 1], P[3 * a + 2]);
    const lb = frame.local(P[3 * b], P[3 * b + 1], P[3 * b + 2]);
    const length = Math.hypot(P[3 * a] - P[3 * b], P[3 * a + 1] - P[3 * b + 1], P[3 * a + 2] - P[3 * b + 2]);
    if (length < MIN_EDGE || Math.abs(lb.s - la.s) / length >= 0.5) continue;
    const [p, q] = faces;
    const cos = Math.max(-1, Math.min(1, p.n[0] * q.n[0] + p.n[1] * q.n[1] + p.n[2] * q.n[2]));
    const degrees = (Math.acos(cos) * 180) / Math.PI;
    creases++;
    if (degrees > worst) where = `s ${at.s.toFixed(2)}, lat ${at.lat.toFixed(2)}, dz ${at.dz.toFixed(2)}, length ${length.toFixed(2)}`;
    worst = Math.max(worst, degrees);
  }
  return { creases, worst, facing, where };
}

describe.sequential.each(CASES)("the face channels' starts draw no edge (issue #321): $name", (entry) => {
  for (const end of ["inner", "outer"] as const) {
    it(`${end} end: no crease of ${MAX_CREASE} degrees or more around the cutter's start, and no face across the channel`, async () => {
      const d = await designOf(entry);
      const start = startOf(d, end);
      if (!start) return;
      expect(start.worst, `worst of ${start.creases} transverse edges at ${start.where}`).toBeLessThanOrEqual(MAX_CREASE);
      expect(start.facing, "faces standing across the channel at its start").toBe(0);
    }, 120_000);
  }
});
