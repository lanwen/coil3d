import type opentype from "opentype.js";
import { ARCHIVO_BLACK_TTF_BASE64 } from "./label-font-data";
import { LABEL_CURVE_SEGMENTS, LABEL_MARGIN, LABEL_MAX_FONT_SIZE, LABEL_MIN_HEIGHT } from "./constants";
import { evalOutline, isFullCircle } from "./shapes";
import type { ShapeOutline } from "./shapes";

export type LabelLoop = Array<[number, number]>;

const COINCIDENT_POINT_EPSILON = 1e-6;
const ROUND_BEARING_DEG = 90;
const FIRST_SIDE = { seg: 1, u: 0 };
const OUTLINE_OFFSET_ZERO = 0;
const FIT_BISECTION_STEPS = 40;

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

let fontPromise: Promise<opentype.Font> | undefined;

export function getLabelFont(): Promise<opentype.Font> {
  if (!fontPromise) {
    fontPromise = import("opentype.js")
      .then(({ default: lib }) => lib.parse(decodeBase64(ARCHIVO_BLACK_TTF_BASE64)))
      .catch((error: unknown) => {
        fontPromise = undefined;
        throw error;
      });
  }
  return fontPromise;
}

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

function dedupeLoop(loop: LabelLoop): LabelLoop {
  const out: LabelLoop = [];
  for (const p of loop) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > COINCIDENT_POINT_EPSILON) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= COINCIDENT_POINT_EPSILON) out.pop();
  return out;
}

function signedArea(loop: LabelLoop): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i];
    const [x2, y2] = loop[(i + 1) % loop.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function classifyLabelLoops(loops: LabelLoop[]): { solids: LabelLoop[]; holes: LabelLoop[] } {
  const solids: LabelLoop[] = [];
  const holes: LabelLoop[] = [];
  for (const loop of loops) (signedArea(loop) <= 0 ? solids : holes).push(loop);
  return { solids, holes };
}

export interface LabelMetrics {
  widthPerUnit: number;
  heightPerUnit: number;
}

export function measureLabel(font: opentype.Font, text: string): LabelMetrics {
  const bbox = font.getPath(text, 0, 0, 1).getBoundingBox();
  return { widthPerUnit: Math.max(0, bbox.x2 - bbox.x1), heightPerUnit: Math.max(0, bbox.y2 - bbox.y1) };
}

export interface LabelFit {
  fontSize: number;
  width: number;
  height: number;
}

function sideBearingDeg(outline: ShapeOutline): number {
  const isRound = isFullCircle(outline);
  if (isRound) return ROUND_BEARING_DEG;
  const firstSide = evalOutline(outline, FIRST_SIDE, OUTLINE_OFFSET_ZERO);
  return (Math.atan2(firstSide.ny, firstSide.nx) * 180) / Math.PI;
}

export function fitLabel(metrics: LabelMetrics, innerExclusion: number, outerSafe: number, halfStraight: number, minHeight: number = LABEL_MIN_HEIGHT, maxFontSize: number = LABEL_MAX_FONT_SIZE, margin: number = LABEL_MARGIN): LabelFit | undefined {
  if (metrics.heightPerUnit <= 0 || metrics.widthPerUnit <= 0) return undefined;

  const fits = (fontSize: number): boolean => {
    const h = metrics.heightPerUnit * fontSize;
    const w = metrics.widthPerUnit * fontSize;
    const rSafe = outerSafe - margin;
    const yTop = innerExclusion + margin + h;
    if (yTop > rSafe) return false;
    const halfWidthMax = halfStraight + Math.sqrt(Math.max(0, rSafe * rSafe - yTop * yTop));
    return w / 2 <= halfWidthMax;
  };

  const fMax = maxFontSize;
  const fMin = Math.min(minHeight / metrics.heightPerUnit, fMax);
  if (!fits(fMin)) return undefined;

  let fontSize = fMax;
  if (!fits(fMax)) {
    let lo = fMin;
    let hi = fMax;
    for (let i = 0; i < FIT_BISECTION_STEPS; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    fontSize = lo;
  }
  return { fontSize, width: metrics.widthPerUnit * fontSize, height: metrics.heightPerUnit * fontSize };
}

export interface ResolvedLabel {
  text: string;
  fontSize: number;
  yLo: number;
  bearingDeg: number;
}

export interface LabelFitInfo {
  fits: boolean;
  maxChars: number;
}

export interface LabelResolution {
  fit?: LabelFitInfo;
  label?: ResolvedLabel;
  warning?: string;
}

function longestFittingPrefixLength(font: opentype.Font, rawText: string, innerExclusion: number, outerSafe: number, halfStraight: number): number {
  let maxChars = rawText.length - 1;
  while (maxChars > 0) {
    const prefix = rawText.slice(0, maxChars).trim();
    if (!prefix || fitLabel(measureLabel(font, prefix), innerExclusion, outerSafe, halfStraight)) break;
    maxChars--;
  }
  return Math.max(0, maxChars);
}

export async function resolveLabel(rawText: string | undefined, outline: ShapeOutline, boreOutline: ShapeOutline, flangeMargin: number, topCapEnabled: boolean): Promise<LabelResolution> {
  const text = (rawText ?? "").trim();
  if (!text) return {};
  if (!topCapEnabled) {
    return { warning: `The label "${text}" needs a top cap, so it isn't engraved. Turn the top cap on to show it.` };
  }

  const font = await getLabelFont();
  const metrics = measureLabel(font, text);
  const bearingDeg = sideBearingDeg(outline);
  const innerExclusion = boreOutline.apothem;
  const outerSafe = outline.apothem + flangeMargin;
  const halfStraight = outline.halfStraight ?? 0;
  const fit = fitLabel(metrics, innerExclusion, outerSafe, halfStraight);
  if (!fit) {
    return {
      fit: { fits: false, maxChars: longestFittingPrefixLength(font, rawText!, innerExclusion, outerSafe, halfStraight) },
      warning: `The label "${text}" doesn't fit on the top cap with letters at least ${LABEL_MIN_HEIGHT / 10} cm tall, so it's hidden. Use shorter text or a bigger core.`,
    };
  }
  return { fit: { fits: true, maxChars: rawText!.length }, label: { text, fontSize: fit.fontSize, yLo: innerExclusion + LABEL_MARGIN, bearingDeg } };
}

export function labelLoops(font: opentype.Font, label: ResolvedLabel): LabelLoop[] {
  const path = font.getPath(label.text, 0, 0, label.fontSize);
  const bbox = path.getBoundingBox();
  const cx = (bbox.x1 + bbox.x2) / 2;
  const upright = pathToLoops(path).map((loop) => loop.map(([x, y]): [number, number] => [x - cx, label.yLo + (bbox.y2 - y)]));

  const turnFromRound = ((label.bearingDeg - ROUND_BEARING_DEG) * Math.PI) / 180;
  if (turnFromRound === 0) return upright;
  const cos = Math.cos(turnFromRound);
  const sin = Math.sin(turnFromRound);
  return upright.map((loop) => loop.map(([x, y]): [number, number] => [x * cos - y * sin, x * sin + y * cos]));
}
