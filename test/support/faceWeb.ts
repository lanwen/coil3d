import type { Design } from "../../src/core";
import { outlineOffsetAt } from "../../src/core/shapes";
import { grooveShape } from "../../src/core/wall";
import { rayHits } from "./rays";

/** The channel's own level bounds the samples that count: those on the face, in the ring and clear of the hole's rim and the groove. */
function webs(d: Design, path: Float32Array, direction: 1 | -1, level: number): number[] {
  const layout = d.faceChannels!;
  const found: number[] = [];
  for (let i = 0; i < path.length / 3; i++) {
    const p: [number, number, number] = [path[3 * i], path[3 * i + 1], path[3 * i + 2]];
    if (Math.abs(p[2] - level) > 0.3) continue;
    if (outlineOffsetAt(layout.holeOutline, p[0], p[1]).offset < 0.3) continue;
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
    roof: webs(d, d.innerEndLeadIn, 1, layout.inner.level),
    floor: layout.outer ? webs(d, d.outerEndLeadOut, -1, layout.outer.level) : [],
  };
}

export const MIN_WEB = 1.2;
export const WEB_TOLERANCE = 0.05;
