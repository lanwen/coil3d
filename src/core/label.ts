// Engraved label text on the top cap's room-facing face (issue #12,
// docs/design.md, Decisions: label text on the top cap face, only when it
// fits). Shared, backend-agnostic geometry description: font
// loading, text measurement, the annulus fit check, and glyph-outline
// flattening into plain polygons all live here so the mesh backend
// (manifold.ts, manifold-3d CrossSection) and the STEP backend
// (step/build.ts, replicad) extrude/cut the SAME outlines -- exactly the
// "two backends, one feature description" architecture the wall/joints
// already follow (wall.ts's WallProfile, joints.ts's jointGeometry).
//
// ENGRAVED, not embossed-raised (ticket: "pick one and justify it"): the top
// cap's print orientation flips the room-facing face onto the print bed
// (design.ts's printTransform comment -- the plate's local z=CAP_THICKNESS
// face, which is what carries the label, ends up at z=0, the very first
// layer). A RAISED bump on that face would need to protrude BELOW the bed
// plane at print time -- not printable in that orientation. A recessed
// (engraved) pocket instead removes material from the first few layers,
// which is ordinary, fully supported FDM printing.
//
// Font: Archivo Black (SIL Open Font License 1.1), a single very bold sans
// weight -- good stroke thickness for a shallow engraved groove to stay
// legible. Bundled as `../assets/fonts/ArchivoBlack-Regular.ttf` (+ its
// `OFL.txt`); `label-font-data.ts` is that same file base64-encoded (see
// `../assets/fonts/generate-base64.mjs`) so it loads with a plain string
// import -- no fetch(), no bundler asset-URL handling to keep working
// identically in the browser main thread, the geometry worker
// (geometry/worker.ts) and vitest/Node.

import opentype from "opentype.js";
import { ARCHIVO_BLACK_TTF_BASE64 } from "./label-font-data";
import { LABEL_CURVE_SEGMENTS, LABEL_MARGIN, LABEL_MAX_FONT_SIZE, LABEL_MIN_HEIGHT } from "./constants";
import { evalOutline } from "./shapes";
import type { ShapeOutline } from "./shapes";

/** A single closed polygon loop (mm), as plain [x, y] tuples -- consumed
 * directly by manifold-3d's `CrossSection` constructor and, one loop at a
 * time, by replicad's `makePolygon` (see step/build.ts). */
export type LabelLoop = Array<[number, number]>;

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

let fontPromise: Promise<opentype.Font> | undefined;

/** Parse the bundled font once and cache the promise (mirrors manifold.ts's
 * own `getWasm()` caching pattern). */
export function getLabelFont(): Promise<opentype.Font> {
  if (!fontPromise) {
    fontPromise = Promise.resolve().then(() => opentype.parse(decodeBase64(ARCHIVO_BLACK_TTF_BASE64)));
  }
  return fontPromise;
}

/** Flatten an opentype `Path` (as returned by `font.getPath`) into closed
 * polygon loops, subdividing quadratic/cubic Bezier segments into short
 * straight runs (`LABEL_CURVE_SEGMENTS` per curve -- plenty for FDM-scale
 * engraved text; see wall.ts's own fixed-segment-count precedent). */
export function pathToLoops(path: opentype.Path): LabelLoop[] {
  const loops: LabelLoop[] = [];
  let current: LabelLoop = [];
  let cursor: [number, number] = [0, 0];
  let start: [number, number] = [0, 0];

  const quad = (p0: [number, number], p1: [number, number], p2: [number, number]) => {
    for (let i = 1; i <= LABEL_CURVE_SEGMENTS; i++) {
      const t = i / LABEL_CURVE_SEGMENTS;
      const mt = 1 - t;
      current.push([mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0], mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]]);
    }
  };
  const cubic = (p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number]) => {
    for (let i = 1; i <= LABEL_CURVE_SEGMENTS; i++) {
      const t = i / LABEL_CURVE_SEGMENTS;
      const mt = 1 - t;
      current.push([
        mt * mt * mt * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t * t * t * p3[0],
        mt * mt * mt * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t * t * t * p3[1],
      ]);
    }
  };

  for (const cmd of path.commands) {
    if (cmd.type === "M") {
      if (current.length > 1) loops.push(current);
      current = [];
      cursor = [cmd.x, cmd.y];
      start = cursor;
      current.push(cursor);
    } else if (cmd.type === "L") {
      cursor = [cmd.x, cmd.y];
      current.push(cursor);
    } else if (cmd.type === "Q") {
      const p1: [number, number] = [cmd.x1, cmd.y1];
      const p2: [number, number] = [cmd.x, cmd.y];
      quad(cursor, p1, p2);
      cursor = p2;
    } else if (cmd.type === "C") {
      const p1: [number, number] = [cmd.x1, cmd.y1];
      const p2: [number, number] = [cmd.x2, cmd.y2];
      const p3: [number, number] = [cmd.x, cmd.y];
      cubic(cursor, p1, p2, p3);
      cursor = p3;
    } else if (cmd.type === "Z") {
      if (current.length > 1) loops.push(current);
      current = [];
      cursor = start;
    }
  }
  if (current.length > 1) loops.push(current);
  return loops.map(dedupeLoop).filter((loop) => loop.length >= 3);
}

/**
 * Drop consecutive duplicate points (within a tight epsilon) and a trailing
 * point that merely repeats the first -- glyph outlines commonly end each
 * contour with an explicit `L` back to its own start point before the `Z`,
 * which is otherwise a zero-length closing edge. manifold-3d's CrossSection
 * tolerates that edge (Clipper2 cleans it up internally), but replicad's
 * `makePolygon` (step/build.ts) does not: a `gp_Pnt`-to-itself edge throws a
 * native OCCT exception with no readable message. Fixed once here so
 * neither backend has to special-case it.
 */
function dedupeLoop(loop: LabelLoop): LabelLoop {
  const EPS = 1e-6;
  const out: LabelLoop = [];
  for (const p of loop) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > EPS) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= EPS) out.pop();
  return out;
}

/** Shoelace signed area (positive for a counter-clockwise loop in a
 * right-handed XY frame). */
function signedArea(loop: LabelLoop): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i];
    const [x2, y2] = loop[(i + 1) % loop.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/**
 * Split a glyph run's loops into solid (outer) and hole contours by the
 * SIGN of their signed area alone, not nesting -- empirically true for every
 * glyph in this font (checked against O/B/i/A/8, which cover a plain hole, a
 * double hole, two disjoint solids, and a solid with no hole at all): in the
 * font's own (un-flipped) coordinate space every outer contour has positive
 * area and every hole negative, a font-wide rasterization convention, not a
 * per-glyph accident. `labelLoops` flips the loops in Y for on-part
 * legibility (see its own doc comment), which negates every loop's signed
 * area uniformly (shoelace: negating one coordinate flips the sum's sign)
 * -- so on the loops this function actually receives (always already
 * flipped, both call sites use `labelLoops`'s output) the convention flips
 * too: solid is negative, hole positive. This is what lets step/build.ts
 * (replicad has no multi-contour nonzero-fill face primitive) union every
 * solid and cut every hole in one pass instead of computing point-in-polygon
 * nesting.
 */
export function classifyLabelLoops(loops: LabelLoop[]): { solids: LabelLoop[]; holes: LabelLoop[] } {
  const solids: LabelLoop[] = [];
  const holes: LabelLoop[] = [];
  for (const loop of loops) (signedArea(loop) <= 0 ? solids : holes).push(loop);
  return { solids, holes };
}

export interface LabelMetrics {
  /** Rendered ink bounding-box width per unit font size (mm at fontSize=1). */
  widthPerUnit: number;
  /** Rendered ink bounding-box height per unit font size (mm at fontSize=1). */
  heightPerUnit: number;
}

/** Measure a text run's ink bounding box, normalized to fontSize=1 so the
 * fit search below (`fitLabel`) can scale it algebraically instead of
 * re-laying-out glyphs at every candidate size (opentype scales paths
 * linearly with fontSize, so this is exact, not an approximation). */
export function measureLabel(font: opentype.Font, text: string): LabelMetrics {
  const bbox = font.getPath(text, 0, 0, 1).getBoundingBox();
  return { widthPerUnit: Math.max(0, bbox.x2 - bbox.x1), heightPerUnit: Math.max(0, bbox.y2 - bbox.y1) };
}

export interface LabelFit {
  /** The opentype fontSize (mm) that renders at the chosen ink height. */
  fontSize: number;
  /** Rendered ink width at `fontSize`, mm. */
  width: number;
  /** Rendered ink height at `fontSize`, mm. */
  height: number;
}

/**
 * The bearing (degrees, standard math convention: 0 = +X, 90 = +Y) the
 * text band's OWN radial axis points along -- i.e. which direction is
 * "outward" for this label. Round has no preferred direction (every
 * bearing is equally valid by symmetry): 90 degrees is the existing,
 * already-screenshotted convention, kept for round only so its render
 * doesn't change. sq/tri instead use flat side 0's own outward normal --
 * read directly off `evalOutline` (shapes.ts) rather than re-derived by
 * hand, since a side's normal is constant along its whole length (the
 * `u` parameter is irrelevant here, unlike a corner). Placing the band's
 * radial axis exactly along that bearing, not an arbitrary or
 * corner-pointing one, is what `fitLabel` below relies on: it lets the
 * (otherwise merely-conservative) `apothem` bound become the EXACT
 * boundary distance in that one specific direction (see `fitLabel`'s own
 * doc comment), and it keeps the rendered text centered on a flat side
 * instead of running diagonally toward a corner (issue #12 review).
 */
function sideBearingDeg(outline: ShapeOutline): number {
  const isRound = outline.cornerRadius === outline.apothem;
  if (isRound) return 90;
  const side0 = evalOutline(outline, { seg: 1, u: 0 }, 0); // seg 1 = side index 0 (seg odd => side (seg-1)/2); offset 0 for the outline's own outward normal
  return (Math.atan2(side0.ny, side0.nx) * 180) / Math.PI;
}

/**
 * The largest font size (from the one that renders at ink height
 * `minHeight` up to `maxFontSize`, issue #176's stroke cap) that fits the
 * annulus between `innerExclusion` and
 * `outerSafe` (mm, both measured along the band's own radial bearing --
 * see `sideBearingDeg`). For round, or for sq/tri aligned to a flat side's
 * own bearing (the only way this is called -- `resolveLabel` always passes
 * `boreOutline.apothem`/`outline.apothem + flangeMargin` computed at that
 * exact bearing), these are the EXACT boundary distances in that direction,
 * not just conservative worst-case bounds: `apothem` is BY DEFINITION the
 * center-to-flat-side distance (shapes.ts), and corner rounding never
 * reaches a side's own midpoint region, so evaluating exactly there always
 * gives that outline's true radius, whatever the corner radius. The text
 * sits as a band centered on the tangential axis (perpendicular to the
 * bearing), its near edge at `innerExclusion + margin`: as fontSize grows,
 * both the band's ink height and width grow (worse) while the outer radius
 * budget for width shrinks (also worse) -- monotonic, so a bisection
 * between the smallest size and `maxFontSize` finds the threshold. Text
 * whose ink is short for its font size (lowercase without ascenders, a lone
 * "-") would need a font above `maxFontSize`, with strokes too wide to print,
 * to reach `minHeight`; its smallest size is `maxFontSize` instead, so it is
 * the same letter size as capitals at their largest. Returns undefined if
 * even the smallest size doesn't fit -- the ticket's "hide it and emit a
 * warning" case.
 */
export function fitLabel(metrics: LabelMetrics, innerExclusion: number, outerSafe: number, minHeight: number = LABEL_MIN_HEIGHT, maxFontSize: number = LABEL_MAX_FONT_SIZE, margin: number = LABEL_MARGIN): LabelFit | undefined {
  if (metrics.heightPerUnit <= 0 || metrics.widthPerUnit <= 0) return undefined;

  const fits = (fontSize: number): boolean => {
    const h = metrics.heightPerUnit * fontSize;
    const w = metrics.widthPerUnit * fontSize;
    const rSafe = outerSafe - margin;
    const yTop = innerExclusion + margin + h;
    if (yTop > rSafe) return false;
    const halfWidthMax = Math.sqrt(Math.max(0, rSafe * rSafe - yTop * yTop));
    return w / 2 <= halfWidthMax;
  };

  const fMax = maxFontSize;
  const fMin = Math.min(minHeight / metrics.heightPerUnit, fMax);
  if (!fits(fMin)) return undefined;

  let fontSize = fMax;
  if (!fits(fMax)) {
    let lo = fMin;
    let hi = fMax;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    fontSize = lo;
  }
  return { fontSize, width: metrics.widthPerUnit * fontSize, height: metrics.heightPerUnit * fontSize };
}

/** A fitted label, ready to place: the text, the chosen font size (mm, ink
 * height), the near-edge radius its band starts at, and the bearing its
 * radial axis points along (`sideBearingDeg`). Both backends (manifold.ts,
 * step/build.ts) turn this into glyph loops via `labelLoops` below,
 * positioned identically. */
export interface ResolvedLabel {
  text: string;
  fontSize: number;
  /** Distance from center to the text band's near (bottom) edge, mm. */
  yLo: number;
  /** Bearing (degrees) the band's radial axis points along -- see `sideBearingDeg`. */
  bearingDeg: number;
}

/** How the label text sits on the cap: whether all of it fits, and the length
 * (in characters of the raw `spec.label`) of the longest prefix that does. */
export interface LabelFitInfo {
  fits: boolean;
  maxChars: number;
}

export interface LabelResolution {
  /** Set only when there is a top cap AND a non-blank label: whether the
   * label fits and how much of it would. */
  fit?: LabelFitInfo;
  /** Set only when there IS a top cap and the text fits at >= the minimum
   * legible height -- absent (with a `warning`) otherwise. */
  label?: ResolvedLabel;
  warning?: string;
}

/**
 * Resolve the spec's label text against the top cap's own geometry -- the
 * ONE place both backends call (design.ts for the mesh, step/build.ts for
 * STEP) so they can never fit the text differently. `outline`/`boreOutline`
 * are the core wall's own outline pair (issue #6/#9's ShapeOutline), i.e.
 * design.ts's `outline`/`boreOutline` locals (== wallSpec's), and
 * `flangeMargin` is `flangeSpec.margin`.
 *
 * The band is placed along `sideBearingDeg(outline)` -- for sq/tri, flat
 * side 0's own outward normal (a straight edge, not a corner), for round an
 * arbitrary-but-fixed 90 degrees. `boreOutline`/`outline` share that SAME
 * bearing convention (both are built from the same n and corner-angle
 * convention, offsetOutline/design.ts's inward wall-thickness offset never
 * rotates it), so `boreOutline.apothem` and `outline.apothem + flangeMargin`
 * are each the EXACT (not merely conservative) boundary distance at that
 * bearing -- see shapes.ts's apothem doc comment and `fitLabel`'s own.
 */
export async function resolveLabel(rawText: string | undefined, outline: ShapeOutline, boreOutline: ShapeOutline, flangeMargin: number, topCapEnabled: boolean): Promise<LabelResolution> {
  const text = (rawText ?? "").trim();
  if (!text) return {};
  if (!topCapEnabled) {
    return { warning: `Label text "${text}" is set, but there is no top cap to place it on -- it will not be shown. Enable the top cap to show it.` };
  }

  const font = await getLabelFont();
  const metrics = measureLabel(font, text);
  const bearingDeg = sideBearingDeg(outline);
  const innerExclusion = boreOutline.apothem;
  const outerSafe = outline.apothem + flangeMargin;
  const fit = fitLabel(metrics, innerExclusion, outerSafe);
  if (!fit) {
    // Longest prefix of the raw text that still fits; 0 when not even one character does.
    let maxChars = rawText!.length - 1;
    while (maxChars > 0) {
      const prefix = rawText!.slice(0, maxChars).trim();
      if (!prefix || fitLabel(measureLabel(font, prefix), innerExclusion, outerSafe)) break;
      maxChars--;
    }
    return {
      fit: { fits: false, maxChars: Math.max(0, maxChars) },
      warning: `Label text "${text}" doesn't fit the top cap at a legible height (>= ${LABEL_MIN_HEIGHT} mm) and has been hidden. Use shorter text or a bigger cap.`,
    };
  }
  return { fit: { fits: true, maxChars: rawText!.length }, label: { text, fontSize: fit.fontSize, yLo: innerExclusion + LABEL_MARGIN, bearingDeg } };
}

/**
 * The positioned glyph loops for a resolved label, in the plate's own local
 * XY frame (same frame `buildOutlineRing`'s plate uses): centered on the
 * tangential axis, occupying radial distance [label.yLo, label.yLo +
 * inkHeight] measured along `label.bearingDeg` (issue #12 review: the band
 * sits on a flat side for sq/tri, not a corner-pointing bearing -- see
 * `sideBearingDeg`).
 *
 * Built in a canonical (tangential, radial) frame -- exactly the old
 * (x, y) frame from before bearings existed, with "radial" flipped in Y
 * (empirically verified against rendered screenshots, not just reasoned
 * about up front: the cap's room-facing surface, +Z locally, see
 * manifold.ts's/step/build.ts's file headers, is viewed under
 * viewer/lineArt's oblique isometric camera -- `up: [0,0,1]`, looking down
 * -Z with +Y as screen-up -- and text placed in the font's own native
 * orientation there appears upside-down (flip both axes) or mirrored/
 * backwards (flip X only); flipping Y alone is the one single-axis
 * reflection that reads correctly; `classifyLabelLoops`'s doc comment
 * covers the winding-sign consequence for the STEP backend) -- then rotated
 * by `bearingDeg - 90` so the radial axis (old +Y) points along
 * `bearingDeg` instead of a fixed 90 degrees. At `bearingDeg === 90`
 * (round) this rotation is the identity, so round's render is byte-for-byte
 * unchanged from before bearings existed.
 */
export function labelLoops(font: opentype.Font, label: ResolvedLabel): LabelLoop[] {
  const path = font.getPath(label.text, 0, 0, label.fontSize);
  const bbox = path.getBoundingBox();
  const cx = (bbox.x1 + bbox.x2) / 2;
  const canonical = pathToLoops(path).map((loop) => loop.map(([x, y]): [number, number] => [x - cx, label.yLo + (bbox.y2 - y)]));

  const delta = ((label.bearingDeg - 90) * Math.PI) / 180;
  if (delta === 0) return canonical;
  const cos = Math.cos(delta);
  const sin = Math.sin(delta);
  return canonical.map((loop) => loop.map(([x, y]): [number, number] => [x * cos - y * sin, x * sin + y * cos]));
}
