import { describe, expect, it } from "vitest";
import { design, JOINT_ENGAGE_DEPTH, printPlacements, TOLERANCE_MAX, TOLERANCE_MIN } from "../src/core";
import type { CoilMesh, CoilSpec, Design, JointKind, MountKind, PartRole, RigidTransform, ShapeSpec } from "../src/core";
import { SCREW_MOUNT_RECESS_DEPTH, SCREW_MOUNT_SLOT_TRAVEL } from "../src/core/constants";
import { layoutKeyholeMount } from "../src/core/mount";
import { KEYHOLE_ROOF_MAX_SPAN } from "./support/keyholeBridge";

// Issue #168: AGENTS.md's printability rule -- "every part prints flat on the
// bed without supports: overhangs at most 45 deg, no large bridges" -- as one
// general check over every printed part, in the exact pose the 3MF export and
// the print-layout view place it in (`printPlacements`).
//
// A triangle fails when it faces down, sits above the bed, and leans more
// than 45 deg from vertical (a horizontal ceiling is 90 deg). Failing
// triangles are grouped into connected patches. A patch is exempt only as a
// narrow BRIDGE (issue #128's measure): at most BRIDGE_MAX_SPAN wide by
// 2 * area / perimeter, and anchored along its sides -- every boundary edge
// meets a face that runs DOWN from it (a wall the bridge rests on), except at
// most its two short ends. A ledge that sticks out into the air (its outer
// edge meets a face that rises from it) is an overhang, not a bridge, however
// narrow. Each failure names the part, the case (shape, joint, size or
// mount), where it is and how steep.

const MAX_OVERHANG_DEG = 45;
/** Faceted curves and boolean slivers lean a little past their nominal angle. */
const TESSELLATION_TOL_DEG = 1.5;
const BRIDGE_MAX_SPAN = 2; // mm
/** A triangle entirely below this height prints on the bed itself. */
const BED_EPS = 0.05; // mm

interface Patch {
  /** Worst overhang in the patch, degrees from vertical. */
  worstDeg: number;
  /** The worst triangle's centroid, in the part's own (assembled) frame. */
  at: [number, number, number];
  /** Height of that centroid above the bed, in print pose. */
  printZ: number;
  area: number;
  width: number;
  /** Boundary length whose neighbouring face rises from the edge (not resting on anything). */
  freeLength: number;
  /** Bounding box of the patch's vertices, in the part's own (assembled) frame. */
  min: [number, number, number];
  max: [number, number, number];
}

function place(mesh: CoilMesh, t: RigidTransform): Float32Array {
  const cos = Math.cos(t.rotateX);
  const sin = Math.sin(t.rotateX);
  const [dx, dy, dz] = t.translate;
  const p = mesh.positions;
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    out[i] = p[i] + dx;
    out[i + 1] = p[i + 1] * cos - p[i + 2] * sin + dy;
    out[i + 2] = p[i + 1] * sin + p[i + 2] * cos + dz;
  }
  return out;
}

/**
 * Where triangle `n`, across edge i0-i1 from an overhang patch, goes from that
 * edge: its third vertex's offset from the edge line. Undefined for a
 * degenerate neighbour.
 */
function awayFromEdge(p: Float32Array, tris: Uint32Array, weld: Int32Array, n: number, i0: number, i1: number): [number, number, number] | undefined {
  let w = -1;
  for (let j = 0; j < 3; j++) if (weld[tris[n + j]] !== weld[i0] && weld[tris[n + j]] !== weld[i1]) w = tris[n + j];
  if (w < 0) return undefined;
  const [ax, ay, az] = [p[i0 * 3], p[i0 * 3 + 1], p[i0 * 3 + 2]];
  const [ex, ey, ez] = [p[i1 * 3] - ax, p[i1 * 3 + 1] - ay, p[i1 * 3 + 2] - az];
  const [cx, cy, cz] = [p[w * 3] - ax, p[w * 3 + 1] - ay, p[w * 3 + 2] - az];
  const s = (cx * ex + cy * ey + cz * ez) / (ex * ex + ey * ey + ez * ez);
  return [cx - s * ex, cy - s * ey, cz - s * ez];
}

/** Every unsupported overhang patch of `mesh` in print pose `t` (bed at z = 0). */
function overhangs(mesh: CoilMesh, t: RigidTransform): Patch[] {
  const p = place(mesh, t);
  const src = mesh.positions;
  const tris = mesh.indices;
  // Weld vertices by position, so patches and edge neighbours connect even where the mesh repeats a vertex.
  const ids = new Map<string, number>();
  const weld = new Int32Array(p.length / 3);
  for (let v = 0; v < weld.length; v++) {
    const key = `${Math.round(p[v * 3] * 1e4)},${Math.round(p[v * 3 + 1] * 1e4)},${Math.round(p[v * 3 + 2] * 1e4)}`;
    let id = ids.get(key);
    if (id === undefined) ids.set(key, (id = ids.size));
    weld[v] = id;
  }
  const edgeKey = (u: number, v: number) => (u < v ? u * 4294967296 + v : v * 4294967296 + u);
  // Each welded edge -> the triangles using it.
  const edgeTris = new Map<number, number[]>();
  for (let t3 = 0; t3 < tris.length; t3 += 3) {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(weld[tris[t3 + k]], weld[tris[t3 + ((k + 1) % 3)]]);
      const list = edgeTris.get(key);
      if (list) list.push(t3);
      else edgeTris.set(key, [t3]);
    }
  }

  const fails = new Map<number, number>(); // triangle -> overhang deg
  const normals = new Map<number, [number, number, number]>();
  for (let t3 = 0; t3 < tris.length; t3 += 3) {
    const [a, b, c] = [tris[t3] * 3, tris[t3 + 1] * 3, tris[t3 + 2] * 3];
    if (Math.max(p[a + 2], p[b + 2], p[c + 2]) <= BED_EPS) continue;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    // A sliver (under 0.001 mm^2) has no meaningful normal: boolean-seam noise, far below print resolution.
    if (len < 2e-3 || nz >= 0) continue;
    const deg = (Math.asin(Math.min(1, -nz / len)) * 180) / Math.PI;
    if (deg > MAX_OVERHANG_DEG + TESSELLATION_TOL_DEG) {
      fails.set(t3, deg);
      normals.set(t3, [nx / len, ny / len, nz / len]);
    }
  }

  // Connected patches of failing triangles (sharing an edge).
  const parent = new Map<number, number>();
  for (const t3 of fails.keys()) parent.set(t3, t3);
  const find = (x: number): number => {
    while (parent.get(x) !== x) {
      const up = parent.get(parent.get(x)!)!;
      parent.set(x, up);
      x = up;
    }
    return x;
  };
  for (const list of edgeTris.values()) {
    const failing = list.filter((t3) => fails.has(t3));
    for (let i = 1; i < failing.length; i++) parent.set(find(failing[i]), find(failing[0]));
  }

  const groups = new Map<number, number[]>();
  for (const t3 of fails.keys()) {
    const r = find(t3);
    const g = groups.get(r);
    if (g) g.push(t3);
    else groups.set(r, [t3]);
  }

  const patches: Patch[] = [];
  for (const group of groups.values()) {
    const inPatch = new Set(group);
    let area = 0;
    let perimeter = 0;
    let freeLength = 0;
    let worst = group[0];
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const t3 of group) {
      if (fails.get(t3)! > fails.get(worst)!) worst = t3;
      const [a, b, c] = [tris[t3] * 3, tris[t3 + 1] * 3, tris[t3 + 2] * 3];
      for (const v of [a, b, c]) {
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], src[v + k]);
          max[k] = Math.max(max[k], src[v + k]);
        }
      }
      area += Math.abs((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a])) / 2;
      const nrm = normals.get(t3)!;
      for (let k = 0; k < 3; k++) {
        const i0 = tris[t3 + k];
        const i1 = tris[t3 + ((k + 1) % 3)];
        // The faces across this edge, other than coplanar ones: a face lying in
        // the patch's own plane but facing the other way is a zero-thickness seam
        // where two cuts touch, not a real boundary.
        const across = edgeTris
          .get(edgeKey(weld[i0], weld[i1]))!
          .filter((n) => !inPatch.has(n))
          .map((n) => awayFromEdge(p, tris, weld, n, i0, i1))
          .filter((d): d is [number, number, number] => d !== undefined && Math.abs(d[0] * nrm[0] + d[1] * nrm[1] + d[2] * nrm[2]) > 1e-4 * Math.hypot(...d) + 1e-6);
        if (across.length === 0) continue; // an inner edge of the patch
        perimeter += Math.hypot(p[i0 * 3] - p[i1 * 3], p[i0 * 3 + 1] - p[i1 * 3 + 1]);
        // A face rising from the edge leaves it hanging in the air; one running down from it is a wall that holds it up.
        if (across.some(([dx, dy, dz]) => dz > 0.01 * Math.hypot(dx, dy, dz) + 1e-6)) {
          freeLength += Math.hypot(p[i0 * 3] - p[i1 * 3], p[i0 * 3 + 1] - p[i1 * 3 + 1], p[i0 * 3 + 2] - p[i1 * 3 + 2]);
        }
      }
    }
    const [a, b, c] = [tris[worst] * 3, tris[worst + 1] * 3, tris[worst + 2] * 3];
    const at: [number, number, number] = [0, 1, 2].map((k) => (src[a + k] + src[b + k] + src[c + k]) / 3) as [number, number, number];
    const width = perimeter > 0 ? (2 * area) / perimeter : 0;
    patches.push({ worstDeg: fails.get(worst)!, at, printZ: (p[a + 2] + p[b + 2] + p[c + 2]) / 3, area, width, freeLength, min, max });
  }
  return patches;
}

/** A narrow bridge: thin, and resting on walls along its sides (only its two ends may be free). */
function isNarrowBridge(patch: Patch): boolean {
  return patch.width <= BRIDGE_MAX_SPAN && patch.freeLength <= 2 * BRIDGE_MAX_SPAN;
}

function describePatch(part: string, label: string, q: Patch): string {
  const f = (x: number) => x.toFixed(1);
  return `${part} [${label}] overhang ${f(q.worstDeg)} deg at (${q.at.map(f).join(", ")}) mm, ${f(q.printZ)} mm above the bed; patch ${f(q.area)} mm^2, ${f(q.width)} mm wide, ${f(q.freeLength)} mm unsupported edge`;
}

function baseSpec(overrides: Partial<CoilSpec>): CoilSpec {
  return {
    wire: { length: 4000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 60 },
    height: { locked: true, value: 50 },
    layers: { locked: true, value: 2 },
    objective: "minVolume",
    topCap: "on",
    joint: "press",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    mount: "none",
    plateJoint: "glue",
    ...overrides,
  };
}

const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 12 }, { kind: "tri", cornerRadius: 12 }];
const JOINTS: JointKind[] = ["press", "bayonet", "snap"];
const MOUNTS: MountKind[] = ["keyhole", "through", "skadis", "opengrid"];

// Three sizes and cable diameters, the bigger two with a label on the cap.
const SIZES: Array<{ label: string; overrides: Partial<CoilSpec> }> = [
  { label: "40 mm, 2.5 mm cable", overrides: { coreSize: { locked: true, dimension: "outer", value: 40 }, height: { locked: true, value: 40 }, wire: { length: 3000, diameter: 2.5, type: "usb" } } },
  { label: "60 mm, 3.8 mm cable, label", overrides: { label: "USB-C 2m" } },
  {
    label: "90 mm, 5 mm cable, label",
    overrides: { coreSize: { locked: true, dimension: "outer", value: 90 }, height: { locked: true, value: 60 }, wire: { length: 5000, diameter: 5, type: "usb" }, label: "HDMI 3m" },
  },
];

interface Case {
  name: string;
  spec: CoilSpec;
}

const CASES: Case[] = [];
for (const shape of SHAPES) {
  for (const joint of JOINTS) {
    for (const size of SIZES) CASES.push({ name: `${shape.kind}, ${joint}, ${size.label}`, spec: baseSpec({ shape, joint, ...size.overrides }) });
  }
  for (const mount of MOUNTS) CASES.push({ name: `${shape.kind}, snap, mount ${mount}`, spec: baseSpec({ shape, joint: "snap", mount }) });
  // The snap joint at both ends of the tolerance range, and on a bore too small for its core-side relief (a plain collar then).
  for (const tolerance of [TOLERANCE_MIN, TOLERANCE_MAX]) CASES.push({ name: `${shape.kind}, snap, tolerance ${tolerance}`, spec: baseSpec({ shape, joint: "snap", tolerance }) });
  CASES.push({
    name: `${shape.kind}, snap, tiny bore`,
    spec: baseSpec({
      shape: shape.kind === "round" ? shape : { kind: shape.kind, cornerRadius: 6 },
      joint: "snap",
      coreSize: { locked: true, dimension: "outer", value: shape.kind === "tri" ? 14 : 10 },
      height: { locked: true, value: 20 },
      wire: { length: 500, diameter: 1.2, type: "usb" },
    }),
  });
}
CASES.push({ name: "sq, press, mount keyhole rotated 45", spec: baseSpec({ shape: SHAPES[1], mount: "keyhole", keyholeRotation: 45 }) });
CASES.push({ name: "round, press, mount skadis, snap plate joint", spec: baseSpec({ mount: "skadis", plateJoint: "snap" }) });

/**
 * Known failures, each a separate design problem with its own issue: a
 * matching patch is reported but does not fail its case. Remove an entry
 * once its issue is fixed. Never widen the 45-degree rule to make a case
 * pass.
 */
const KNOWN: Array<{ issue: string; applies: (spec: CoilSpec) => boolean; matches: (role: PartRole, patch: Patch, d: Design) => boolean }> = [
  // See #176: the engraved label's letter floors, face down on the bed, bridge more than 2 mm on the bigger caps.
  { issue: "#176", applies: (spec) => spec.label !== undefined, matches: (role, q) => role === "topCap" && q.printZ < 1 && q.freeLength === 0 },
];

/**
 * Accepted by design, unlike KNOWN: a matching patch passes only while it
 * stays `within` its bound, so it still fails if it grows.
 */
const ACCEPTED: Array<{ reason: string; applies: (spec: CoilSpec) => boolean; matches: (role: PartRole, patch: Patch, d: Design) => boolean; within: (patch: Patch) => boolean }> = [
  // Keyhole undercut roof: an accepted bridge (maintainer decision, #175).
  // Most printers bridge this span; the alternative was a 3.5 mm thicker pad.
  // Only the flat roof itself: on the core, at the roof's height above the
  // bed, over one slot. Its span across the channel (local x -- every slot's
  // channel runs along local +y) and along it stay within the head-width
  // stadium plus a small margin. Any other keyhole overhang still fails.
  {
    reason: "keyhole undercut roof, accepted bridge (#175)",
    applies: (spec) => spec.mount === "keyhole",
    matches: (role, q, d) => {
      if (role !== "core" || q.worstDeg < 89 || Math.abs(q.printZ - SCREW_MOUNT_RECESS_DEPTH) > 0.1) return false;
      const f = d.flangeSpec;
      const { slots } = layoutKeyholeMount(f.outline, f.boreOutline, f.margin, f.keyholeRotation);
      const cx = (q.min[0] + q.max[0]) / 2;
      const cy = (q.min[1] + q.max[1]) / 2;
      return slots.some((s) => Math.abs(cx - s.head.x) < 0.5 && Math.abs(cy - (s.head.y + s.shankEnd.y) / 2) < 0.5);
    },
    within: (q) =>
      q.freeLength === 0 &&
      q.max[2] - q.min[2] < 0.01 &&
      q.max[0] - q.min[0] <= KEYHOLE_ROOF_MAX_SPAN &&
      q.max[1] - q.min[1] <= KEYHOLE_ROOF_MAX_SPAN + SCREW_MOUNT_SLOT_TRAVEL,
  },
];

const designs = new Map<string, Promise<Design>>();
const designOf = (c: Case) => {
  let d = designs.get(c.name);
  if (!d) designs.set(c.name, (d = design(c.spec)));
  return d;
};

describe("issue #168: every printed part prints without supports (overhangs <= 45 deg, only narrow bridges)", () => {
  it.each(CASES)("$name", async (c) => {
    const d = await designOf(c);
    const failures: string[] = [];
    for (const { part, transform } of printPlacements(d.parts, d.spec.print)) {
      for (const q of overhangs(part.mesh, transform)) {
        if (isNarrowBridge(q)) continue;
        const accepted = ACCEPTED.find((k) => k.applies(c.spec) && k.matches(part.role, q, d));
        if (accepted) {
          if (!accepted.within(q)) failures.push(`${describePatch(part.name, c.name, q)} -- larger than the ${accepted.reason}`);
          continue;
        }
        const known = KNOWN.find((k) => k.applies(c.spec) && k.matches(part.role, q, d));
        if (known) console.info(`known failure, ${known.issue}: ${describePatch(part.name, c.name, q)}`);
        else failures.push(describePatch(part.name, c.name, q));
      }
    }
    expect(failures).toEqual([]);
  });
});
