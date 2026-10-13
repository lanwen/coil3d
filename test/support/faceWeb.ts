import type { Design } from "../../src/core";
import { faceDipSweep } from "../../src/core/faceChannel";
import type { FaceEnd } from "../../src/core/faceChannel";
import { outlineOffsetAt } from "../../src/core/shapes";
import { grooveShape } from "../../src/core/wall";
import { rayHits } from "./rays";

/** How far outside the hole's rim the channel's floor starts to curve into the hole (the web thins there on purpose). */
function dipStart(d: Design, end: FaceEnd): number {
  const layout = d.faceChannels!;
  const dip = faceDipSweep(end, layout);
  if (!dip) return 0;
  const ring = dip.rings[0];
  const at = { x: ring.reduce((sum, q) => sum + q.x, 0) / ring.length, y: ring.reduce((sum, q) => sum + q.y, 0) / ring.length };
  return Math.max(0, outlineOffsetAt(layout.holeOutline, at.x, at.y).offset);
}

/** The channel's own level bounds the samples that count: those on the face, in the ring and clear of the hole's rim, its edge round and the groove. */
function webs(d: Design, path: Float32Array, direction: 1 | -1, end: FaceEnd): number[] {
  const layout = d.faceChannels!;
  const level = end.level;
  const clear = Math.max(0.3, dipStart(d, end) + 0.1);
  const found: number[] = [];
  for (let i = 0; i < path.length / 3; i++) {
    const p: [number, number, number] = [path[3 * i], path[3 * i + 1], path[3 * i + 2]];
    if (Math.abs(p[2] - level) > 0.3) continue;
    if (outlineOffsetAt(layout.holeOutline, p[0], p[1]).offset < clear) continue;
    if (outlineOffsetAt(d.wallSpec.outline, p[0], p[1]).offset > -(grooveShape(d.spec.wire.diameter).depth + 0.5)) continue;
    const hits = rayHits(d.mesh, p, [0, 0, direction]);
    if (hits.length >= 2) found.push(hits[1] - hits[0]);
  }
  return found;
}

/** Material over the bottom channel's roof, and under the top channel's floor, along each channel's centre line (mm). */
export function faceWebs(d: Design): { roof: number[]; floor: number[] } {
  const layout = d.faceChannels!;
  return {
    roof: layout.inner ? webs(d, d.innerEndLeadIn, 1, layout.inner) : [],
    floor: layout.outer ? webs(d, d.outerEndLeadOut, -1, layout.outer) : [],
  };
}

export const MIN_WEB = 1.2;
export const WEB_TOLERANCE = 0.05;
