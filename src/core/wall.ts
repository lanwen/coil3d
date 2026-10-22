import { FACE_FILLET_MIN, FACE_FILLET_STEPS, FACE_GROOVE_LEAD, FACE_HOLE_CORNER_MIN, FACE_ARC_JOINT_OVERLAP, FACE_LEAD_COLUMN_REACH, FACE_LEAD_COLUMN_STEP, FACE_LEAD_HOLD, FACE_LEAD_INNER, FACE_LEAD_MARGIN, FACE_LEAD_SHRINK, FACE_LEAD_TILT, FACE_LIP_OPEN, FACE_LIP_RAMP, GROOVE_DEPTH_FACTOR, GROOVE_FLOOR_WALL, GROOVE_LIP_ANGLE_DEG, GROOVE_SLACK, MARGIN_BOTTOM, MARGIN_TOP_FACTOR, RIDGE_LAND, WALL_THICKNESS } from "./constants";
import { chamferedRim } from "./edgeChamfer";
import { arcLengthFractionAt, evalOutline, isFullCircle, isPill, offsetPerimeter, outlineColumnParams, outlineOffsetAt, paramAt, pointAlong, pointAt, polygonVertex } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { CoilMesh } from "./types";

export interface GrooveShape {
  depth: number;
  radius: number;
  pitch: number;
}

function grooveReach(radius: number, depth: number): { down: number; up: number } {
  const c = radius - depth;
  const lip = lipChamfer(radius, depth);
  const down = lip ? lip.dz - lip.x / lip.slope : c >= radius ? 0 : Math.sqrt(Math.max(0, radius * radius - c * c));
  return { down, up: radius * Math.SQRT2 - c };
}

function lipChamfer(radius: number, depth: number): { dz: number; x: number; slope: number } | undefined {
  const a = (GROOVE_LIP_ANGLE_DEG * Math.PI) / 180;
  const x = radius - depth - radius * Math.cos(a);
  return x < 0 ? { dz: radius * Math.sin(a), x, slope: Math.tan(a) } : undefined;
}

export function grooveShape(wireDiameter: number): GrooveShape {
  const depth = GROOVE_DEPTH_FACTOR * wireDiameter;
  const radius = wireDiameter / 2 + GROOVE_SLACK;
  const { down, up } = grooveReach(radius, depth);
  return { depth, radius, pitch: down + up + RIDGE_LAND };
}

export function windingSpan(height: number, wireDiameter: number): number {
  return height - grooveStartHeight(grooveShape(wireDiameter), MARGIN_BOTTOM) - (1 + MARGIN_TOP_FACTOR) * (wireDiameter / 2);
}

export function wallThickness(wireDiameter: number): number {
  return Math.max(WALL_THICKNESS, grooveShape(wireDiameter).depth + GROOVE_FLOOR_WALL);
}

export interface WallRings {
  holeOutline: ShapeOutline;
  width: number;
  bottomThickness: number;
  bottomRing: boolean;
  topThickness?: number;
  fillet: number;
}

export interface FaceLeads {
  bottom: boolean;
  top: boolean;
  centre: number;
  radius: number;
}

export function ringHolePoint(boreOutline: ShapeOutline, outline: ShapeOutline, t: number, width: number): { x: number; y: number } {
  if (isFullCircle(boreOutline)) {
    const p = pointAt(boreOutline, t, 0);
    const scale = (boreOutline.apothem - width) / boreOutline.apothem;
    return { x: p.x * scale, y: p.y * scale };
  }
  const param = paramAt(outline, 0, t);
  const rounded = boreOutline.cornerRadius - width >= FACE_HOLE_CORNER_MIN || isPill(boreOutline);
  const sharp = { n: boreOutline.n, apothem: boreOutline.apothem - width, cornerRadius: 0 };
  const corner = param.seg >> 1;
  if (param.seg % 2 === 0) {
    if (rounded) return evalOutline(boreOutline, param, -width);
    const [x, y] = polygonVertex(sharp, corner);
    return { x, y };
  }
  const across = evalOutline(boreOutline, param, -width);
  if (rounded) return across;
  const [ax, ay] = polygonVertex(sharp, corner);
  const [bx, by] = polygonVertex(sharp, (corner + 1) % boreOutline.n);
  const along = ((across.x - ax) * (bx - ax) + (across.y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2);
  const at = Math.min(1, Math.max(0, along));
  return { x: ax + (bx - ax) * at, y: ay + (by - ay) * at };
}

export interface WallSpec {
  outline: ShapeOutline;
  boreOutline: ShapeOutline;
  height: number;
  wireDiameter: number;
  pitch: number;
  grooveRadius: number;
  grooveDepth: number;
  marginBottom: number;
  marginTop: number;
  taperTurns: number;
  runInTurns: number;
  turns: number;
  columns: number;
  rowsPerPitch: number;
  minCornerSegments: number;
  rings?: WallRings;
  faceLeads?: FaceLeads;
  flat?: boolean;
}

const BEYOND_GROOVE = 1e9;
const PROFILE_SAMPLES = 2000;
const OUTLINE_ANGLE_SAMPLES = 4096;
const FADE_SURFACE_TOLERANCE = 0.02;
const FADE_DONE_TAPER = 1 - 1e-4;
const FADE_BAND_SLACK = 1e-3;

export const smoothstep = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export interface WallProfile {
  pitch: number;
  zStart: number;
  offset(t: number, z: number): number;
  point(t: number, z: number): [number, number, number];
  phaseFraction(t: number): number;
  rowOffsets(n: number): number[];
  fading(t: number, z: number): boolean;
}

export function grooveStartHeight(groove: Pick<GrooveShape, "radius" | "depth">, marginBottom: number): number {
  return marginBottom + grooveReach(groove.radius, groove.depth).down;
}

export function grooveCrest(groove: Pick<GrooveShape, "radius" | "depth">): number {
  return grooveReach(groove.radius, groove.depth).up;
}

function createFlatWallProfile(spec: WallSpec): WallProfile {
  const { outline, pitch, grooveRadius, grooveDepth, marginBottom } = spec;
  return {
    pitch,
    zStart: grooveStartHeight({ radius: grooveRadius, depth: grooveDepth }, marginBottom),
    offset: () => -grooveDepth,
    point: (t, z) => {
      const p = pointAt(outline, t, -grooveDepth);
      return [p.x, p.y, z];
    },
    phaseFraction: (t) => arcLengthFractionAt(outline, -grooveDepth, t),
    rowOffsets: () => [],
    fading: () => false,
  };
}

export function createWallProfile(spec: WallSpec): WallProfile {
  if (spec.flat) return createFlatWallProfile(spec);
  const { outline, pitch, grooveRadius: rho, grooveDepth: g, marginBottom, taperTurns: tau, runInTurns: tauIn, turns } = spec;

  const c = rho - g;
  const s45 = Math.SQRT1_2;
  const dz45 = rho * s45;
  const f45 = c - rho * s45;
  const lip = lipChamfer(rho, g);
  const profile = (dz: number): number => {
    if (dz > dz45) return f45 + (dz - dz45);
    if (lip && dz < -lip.dz) return lip.x + (-lip.dz - dz) * lip.slope;
    return Math.abs(dz) >= rho ? BEYOND_GROOVE : c - Math.sqrt(rho * rho - dz * dz);
  };
  const zStart = grooveStartHeight({ radius: rho, depth: g }, marginBottom);
  const leads = spec.faceLeads;
  const leadTurns = FACE_GROOVE_LEAD / offsetPerimeter(outline, -g);
  const openTurns = FACE_LIP_OPEN / offsetPerimeter(outline, -g);
  const startTurns = leads?.bottom ? leadTurns : tauIn;
  const fadeTurns = leads?.top ? leadTurns : tau;
  const endTurns = leads?.top ? turns + leadTurns : turns;
  const heldTurns = (phi: number) => Math.min(Math.max(phi, 0), turns);
  const taper = (phi: number) => smoothstep((phi + startTurns) / Math.max(startTurns, 1e-9)) * smoothstep((endTurns - phi) / fadeTurns);
  const perimeter = offsetPerimeter(outline, -g);
  const leadMargin = FACE_LEAD_MARGIN;
  const leadHold = FACE_ARC_JOINT_OVERLAP + FACE_LEAD_HOLD;
  const leadIn = FACE_LEAD_SHRINK;
  const leadAlong = (phi: number): { u: number; bottom: boolean } | undefined => {
    if (!leads) return undefined;
    const fromBottom = leads.bottom ? phi * perimeter : Infinity;
    const fromTop = leads.top ? (turns - phi) * perimeter : Infinity;
    const bottom = Math.abs(fromBottom) <= Math.abs(fromTop);
    const u = bottom ? fromBottom : fromTop;
    return u > -leadIn && u < leadHold + FACE_LIP_OPEN ? { u, bottom } : undefined;
  };
  const leadSection = (phi: number, dz: number): number => {
    const at = leadAlong(phi);
    if (!leads || !at) return BEYOND_GROOVE;
    const { u, bottom } = at;
    const hi = leads.radius + leadMargin;
    const inner = leads.radius - FACE_LEAD_INNER;
    const lo = leads.centre + g - leadMargin;
    const w = u >= 0 ? 1 - smoothstep((u - leadHold) / FACE_LIP_OPEN) : 1;
    const R = u >= 0 ? lo + (hi - lo) * w : hi - (hi - inner) * smoothstep(-u / leadIn);
    const openSide = bottom ? dz < 0 : dz > 0;
    const a = Math.abs(dz);
    if (openSide) return (leads.centre - R) * (1 + (w - 1) * smoothstep(a / FACE_LIP_RAMP));
    if (bottom) {
      const beta = Math.PI / 2 - (Math.PI / 4) * smoothstep((u + FACE_LEAD_TILT) / (FACE_ARC_JOINT_OVERLAP + FACE_LEAD_TILT));
      if (beta < Math.PI / 2 - 1e-6 && a > R * Math.sin(beta)) return leads.centre - R * Math.cos(beta) + (a - R * Math.sin(beta)) * Math.tan(beta);
    }
    return a >= R ? BEYOND_GROOVE : leads.centre - Math.sqrt(R * R - a * a);
  };

  const phaseFraction = (t: number): number => arcLengthFractionAt(outline, -g, t);

  const offset = (t: number, z: number, fullDepth = false): number => {
    const phase = phaseFraction(t);
    const q = (z - zStart) / pitch - phase;
    const k0 = Math.floor(q);
    let f = 0;
    const consider = (k: number) => {
      const phi = k + phase;
      if (phi <= -startTurns || phi >= endTurns) return;
      const dz = z - zStart - pitch * heldTurns(phi);
      const grown = fullDepth ? 1 : taper(phi);
      const v = Math.min(profile(dz) + (1 - grown) * g, leadSection(phi, dz));
      if (v < f) f = v;
    };
    consider(k0);
    consider(k0 + 1);
    if (leads?.top) consider(Math.ceil(turns - openTurns - phase));
    if (leads?.bottom) consider(Math.ceil(-startTurns - phase));
    return f;
  };

  const point = (t: number, z: number): [number, number, number] => {
    const off = offset(t, z);
    const p = pointAt(outline, t, off);
    return [p.x, p.y, z];
  };

  const landEnd = pitch - grooveReach(rho, g).down;
  const landStart = dz45 - f45;
  const corners = [0, dz45, (landStart + landEnd) / 2, ...(lip ? [pitch - lip.dz] : [])].filter((h) => h >= 0 && h < pitch);
  const rowOffsets = (n: number): number[] => {
    const M = PROFILE_SAMPLES;
    const hs: number[] = [];
    const len: number[] = [];
    let prev: [number, number] | undefined;
    for (let i = 0; i <= M; i++) {
      const h = (pitch * i) / M;
      const x = Math.min(0, profile(h), profile(h - pitch));
      len.push(prev ? len[len.length - 1] + Math.hypot(h - prev[0], x - prev[1]) : 0);
      hs.push(h);
      prev = [h, x];
    }
    const total = len[M];
    const lengthAt = (h: number) => len[Math.min(M, Math.round((h / pitch) * M))];
    const heightAt = (l: number) => {
      let i = 1;
      while (i < M && len[i] < l) i++;
      return hs[i - 1] + ((hs[i] - hs[i - 1]) * (l - len[i - 1])) / Math.max(len[i] - len[i - 1], 1e-12);
    };
    const step = total / n;
    const nearReach = step / 4;
    const nearCorner = (l: number) => corners.some((c) => {
      const gap = Math.abs(l - lengthAt(c));
      return Math.min(gap, total - gap) < nearReach;
    });
    const nearLand = (l: number) => l > lengthAt(landStart) - nearReach && l < lengthAt(landEnd) + nearReach;
    const near = (l: number) => nearCorner(l) || nearLand(l);
    const even = Array.from({ length: n }, (_, k) => k * step).filter((l) => !near(l)).map(heightAt);
    return [...corners, ...even].sort((a, b) => a - b);
  };
  const landMiddle = (landStart + landEnd) / 2;
  const fading = (t: number, z: number) => {
    const phase = phaseFraction(t);
    const k0 = Math.floor((z - zStart) / pitch - phase);
    for (let k = k0 - 1; k <= k0 + 1; k++) {
      const phi = k + phase;
      if (phi <= -startTurns || phi >= endTurns || taper(phi) > FADE_DONE_TAPER) continue;
      const dz = z - zStart - pitch * Math.max(phi, 0);
      if (dz >= landMiddle - pitch - FADE_BAND_SLACK && z - zStart - pitch * Math.min(phi, turns) <= landMiddle + FADE_BAND_SLACK) return true;
    }
    return false;
  };
  return { pitch, zStart, offset: (t, z) => offset(t, z), point, phaseFraction, rowOffsets, fading };
}

export function grooveFadeTriangles(mesh: CoilMesh, spec: WallSpec): Uint32Array | undefined {
  if (spec.flat) return undefined;
  const profile = createWallProfile(spec);
  const { outline, height } = spec;
  const N = OUTLINE_ANGLE_SAMPLES;
  const angles: number[] = [];
  for (let i = 0; i <= N; i++) {
    const p = pointAt(outline, i / N, 0);
    let a = Math.atan2(p.y, p.x);
    while (i > 0 && a < angles[i - 1]) a += 2 * Math.PI;
    angles.push(a);
  }
  const tAt = (x: number, y: number): number => {
    let a = Math.atan2(y, x);
    while (a < angles[0]) a += 2 * Math.PI;
    while (a >= angles[0] + 2 * Math.PI) a -= 2 * Math.PI;
    let lo = 0;
    let hi = N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (angles[mid] <= a) lo = mid;
      else hi = mid;
    }
    return (lo + (a - angles[lo]) / Math.max(angles[lo + 1] - angles[lo], 1e-12)) / N;
  };
  const p = mesh.positions;
  const fadeLow = profile.zStart + profile.pitch;
  const fadeHigh = profile.zStart + profile.pitch * (spec.turns - (spec.faceLeads?.top ? 0 : spec.taperTurns) - 1);
  const fades = new Map<number, boolean>();
  const fadeAt = (v: number): boolean => {
    let f = fades.get(v);
    if (f === undefined) {
      const x = p[v * 3];
      const y = p[v * 3 + 1];
      const z = p[v * 3 + 2];
      f = false;
      const nearFadeEnds = z < fadeLow || z > fadeHigh;
      if (z > 0 && z < height && nearFadeEnds) {
        const { offset, nx, ny } = outlineOffsetAt(outline, x, y);
        const t = tAt(x - offset * nx, y - offset * ny);
        f = Math.abs(offset - profile.offset(t, z)) < FADE_SURFACE_TOLERANCE && profile.fading(t, z);
      }
      fades.set(v, f);
    }
    return f;
  };
  const t = mesh.indices;
  const out: number[] = [];
  for (let i = 0; i < t.length; i += 3) if (fadeAt(t[i]) && fadeAt(t[i + 1]) && fadeAt(t[i + 2])) out.push(i / 3);
  return out.length > 0 ? new Uint32Array(out) : undefined;
}

export function wallColumnParams(spec: WallSpec): number[] {
  const base = outlineColumnParams(spec.outline, spec.columns, spec.minCornerSegments);
  const g = spec.grooveDepth;
  const perimeter = offsetPerimeter(spec.outline, -g);
  const fractionOf = (t: number) => arcLengthFractionAt(spec.outline, -g, t);
  const paramOf = (f: number): number => {
    const target = ((f % 1) + 1) % 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (fractionOf(mid) < target) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const junctions = [0, spec.turns % 1];
  const extra: number[] = [];
  const count = Math.round(FACE_LEAD_COLUMN_REACH / FACE_LEAD_COLUMN_STEP);
  for (const f of junctions) for (let k = -count; k <= count; k++) extra.push(paramOf(f + (k * FACE_LEAD_COLUMN_STEP) / perimeter));
  const all = [...base, ...extra].map((t) => ((t % 1) + 1) % 1).sort((a, b) => a - b);
  const gap = (0.3 * FACE_LEAD_COLUMN_STEP) / perimeter;
  return all.filter((t, i) => i === 0 || t - all[i - 1] > gap);
}

export function buildWall(spec: WallSpec): CoilMesh {
  const { outline, boreOutline, height, marginBottom, marginTop, rowsPerPitch } = spec;
  const profile = createWallProfile(spec);
  const { pitch, zStart } = profile;

  const ts = wallColumnParams(spec);
  const C = ts.length;

  const delta = pitch / rowsPerPitch;
  const rowOffsets = profile.rowOffsets(rowsPerPitch);
  const zLo = Math.max(marginBottom * 0.5, delta * 0.25);
  const zHi = height - marginTop * 0.5;

  const positions: number[] = [];
  const indices: number[] = [];
  const colIdx: number[][] = [];
  const colZ: number[][] = [];
  const bottomO: number[] = [];
  const topO: number[] = [];

  for (let ci = 0; ci < C; ci++) {
    const t = ts[ci];
    const idx: number[] = [];
    const zz: number[] = [];
    const push = (z: number) => {
      idx.push(positions.length / 3);
      zz.push(z);
      positions.push(...profile.point(t, z));
    };
    push(0);
    bottomO.push(idx[0]);
    const z0 = zStart + pitch * profile.phaseFraction(t);
    const kMin = Math.floor((zLo - z0) / pitch);
    const kMax = Math.ceil((zHi - z0) / pitch);
    for (let k = kMin; k <= kMax; k++) {
      for (const h of rowOffsets) {
        const z = z0 + k * pitch + h;
        if (z >= zLo && z <= zHi) push(z);
      }
    }
    push(height);
    topO.push(idx[idx.length - 1]);
    colIdx.push(idx);
    colZ.push(zz);
  }

  for (let ci = 0; ci < C; ci++) {
    const A = colIdx[ci];
    const Az = colZ[ci];
    const B = colIdx[(ci + 1) % C];
    const Bz = colZ[(ci + 1) % C];
    let i = 0;
    let j = 0;
    while (i < A.length - 1 || j < B.length - 1) {
      if (j === B.length - 1 || (i < A.length - 1 && Az[i + 1] <= Bz[j + 1])) {
        indices.push(A[i], B[j], A[i + 1]);
        i++;
      } else {
        indices.push(A[i], B[j], B[j + 1]);
        j++;
      }
    }
  }

  const { rings } = spec;
  const ledgeFillet = (t: number, bottom: number, radius: number): Array<[number, number, number]> => {
    const b = pointAlong(boreOutline, outline, t, 0);
    if (radius < FACE_FILLET_MIN) return [[b.x, b.y, bottom]];
    return Array.from({ length: FACE_FILLET_STEPS + 1 }, (_, i) => {
      const angle = (Math.PI / 2) * (i / FACE_FILLET_STEPS);
      const q = i === FACE_FILLET_STEPS ? b : ringHolePoint(boreOutline, outline, t, radius * (1 - Math.sin(angle)));
      return [q.x, q.y, bottom + radius * (1 - Math.cos(angle))];
    });
  };
  const profileOf = (t: number): Array<[number, number, number]> => {
    const b = pointAlong(boreOutline, outline, t, 0);
    if (!rings) return [[b.x, b.y, 0], [b.x, b.y, height]];
    const h = ringHolePoint(boreOutline, outline, t, rings.width);
    const bottom = rings.bottomThickness;
    const floor: Array<[number, number, number]> = rings.bottomRing ? [[h.x, h.y, 0], [h.x, h.y, bottom], ...ledgeFillet(t, bottom, rings.fillet)] : [[b.x, b.y, 0]];
    if (rings.topThickness === undefined) return [...floor, [b.x, b.y, height]];
    const flat = height - rings.topThickness;
    const foot = Math.max(bottom, flat - outlineOffsetAt(rings.holeOutline, b.x, b.y).offset);
    return [...floor, [b.x, b.y, foot], [h.x, h.y, flat], [h.x, h.y, height]];
  };
  const inner: number[][] = [];
  let previous: { points: Array<[number, number, number]>; index: number[] } | undefined;
  for (let ci = 0; ci < C; ci++) {
    const points = profileOf(ts[ci]);
    const index = points.map((p, j) => {
      const q = previous?.points[j];
      if (previous && q && Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-9) return previous.index[j];
      positions.push(p[0], p[1], p[2]);
      return positions.length / 3 - 1;
    });
    inner.push(index);
    previous = { points, index };
  }
  const solid = (a: number, b: number, c: number) => {
    if (a !== b && b !== c && a !== c) indices.push(a, b, c);
  };
  for (let ci = 0; ci < C; ci++) {
    const cj = (ci + 1) % C;
    const here = inner[ci];
    const next = inner[cj];
    for (let j = 0; j + 1 < here.length; j++) {
      solid(here[j], here[j + 1], next[j]);
      solid(next[j], here[j + 1], next[j + 1]);
    }
    const last = here.length - 1;
    solid(bottomO[ci], here[0], bottomO[cj]);
    solid(bottomO[cj], here[0], next[0]);
    solid(topO[ci], topO[cj], here[last]);
    solid(topO[cj], next[last], here[last]);
  }

  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

export function buildOutlineRing(outerOutline: ShapeOutline, outerOffset: number, innerOutline: ShapeOutline, zLo: number, zHi: number, columns: number, minCornerSegments: number): CoilMesh {
  const positions: number[] = [];
  const push = (x: number, y: number, z: number): number => {
    const idx = positions.length / 3;
    positions.push(x, y, z);
    return idx;
  };

  const ts = outlineColumnParams(outerOutline, columns, minCornerSegments);

  const rim = chamferedRim(outerOffset, zLo, zHi);
  const outer: number[][] = rim.map(() => []);
  const innerBottom: number[] = [];
  const innerTop: number[] = [];
  for (const t of ts) {
    rim.forEach((row, r) => {
      const o = pointAt(outerOutline, t, row.offset);
      outer[r].push(push(o.x, o.y, row.z));
    });
    const inner = pointAlong(innerOutline, outerOutline, t, 0);
    innerBottom.push(push(inner.x, inner.y, zLo));
    innerTop.push(push(inner.x, inner.y, zHi));
  }

  const columnCount = ts.length;
  const outerBottom = outer[0];
  const outerTop = outer[rim.length - 1];
  const indices: number[] = [];
  const quad = (a: number, b: number, c: number, d: number) => indices.push(a, b, c, c, b, d);
  const outwardWall = quad;
  const boreWall = quad;
  const bottomAnnulus = quad;
  const topAnnulus = (outerHere: number, outerNext: number, innerHere: number, innerNext: number) =>
    indices.push(outerHere, outerNext, innerHere, outerNext, innerNext, innerHere);
  for (let ci = 0; ci < columnCount; ci++) {
    const cj = (ci + 1) % columnCount;
    for (let r = 0; r + 1 < rim.length; r++) outwardWall(outer[r][ci], outer[r][cj], outer[r + 1][ci], outer[r + 1][cj]);
    boreWall(innerBottom[ci], innerTop[ci], innerBottom[cj], innerTop[cj]);
    bottomAnnulus(outerBottom[ci], innerBottom[ci], outerBottom[cj], innerBottom[cj]);
    topAnnulus(outerTop[ci], outerTop[cj], innerTop[ci], innerTop[cj]);
  }

  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
