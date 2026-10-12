import { z } from "zod";
import {
  BED_SIZE_MAX,
  BED_SIZE_MIN,
  DEFAULT_BASE,
  DEFAULT_BED_SIZE,
  DEFAULT_THROUGH_HOLE_DIAMETER,
  DEFAULT_TOLERANCE,
  LABEL_MAX_LENGTH,
  MAX_WIRE_LENGTH,
  THROUGH_HOLE_DIAMETER_MAX,
  THROUGH_HOLE_DIAMETER_MIN,
  TOLERANCE_MAX,
  TOLERANCE_MIN,
} from "./constants";
import { defaultCornerRadius } from "./shapes";
import { DEFAULT_CUSTOM_BEND_MULTIPLIER } from "./types";
import type { BaseMode, CoilSpec, CoreSizeLock, JointKind, KeyholeRotation, Lock, MountKind, ShapeKind, ShapeSpec, TopCapMode, WireTypeId } from "./types";

const DOC_VERSION = 2;

const DEFAULT_OUTER_SIZE = 36;
const DEFAULT_HEIGHT = 40;
const DEFAULT_LAYERS = 1;

export const DEFAULT_SPEC: CoilSpec = {
  wire: { length: 2000, diameter: 3.8, type: "usb" },
  shape: { kind: "round" },
  windingQuality: 0.7,
  coreSize: { locked: true, dimension: "outer", value: DEFAULT_OUTER_SIZE },
  height: { locked: false },
  layers: { locked: true, value: DEFAULT_LAYERS },
  objective: "minVolume",
  base: DEFAULT_BASE,
  topCap: "auto",
  joint: "press",
  tolerance: DEFAULT_TOLERANCE,
  print: { bedX: DEFAULT_BED_SIZE, bedY: DEFAULT_BED_SIZE, bedZ: DEFAULT_BED_SIZE },
  mount: "none",
  plateJoint: "glue",
  keyholeRotation: 0,
  skadisLatch: true,
  strapSlots: false,
  throughHoleDiameter: DEFAULT_THROUGH_HOLE_DIAMETER,
};

export const DEFAULT_SHOW_WIRE = true;

export type ViewMode = "design" | "guide";
const DEFAULT_VIEW: ViewMode = "design";

const DEFAULT_LOCK_TOKENS = ["outer", "ly"] as const;
const LOCK_TOKENS = ["outer", "inner", "h", "ly"] as const;
type LockToken = (typeof LOCK_TOKENS)[number];

export interface ParsedHash {
  spec: CoilSpec;
  showWire: boolean;
  view: ViewMode;
  notice?: string;
}

function fallback(notice: string): ParsedHash {
  return { spec: cloneSpec(DEFAULT_SPEC), showWire: DEFAULT_SHOW_WIRE, view: DEFAULT_VIEW, notice };
}

function cloneSpec(spec: CoilSpec): CoilSpec {
  return {
    wire: { ...spec.wire },
    shape: { ...spec.shape },
    windingQuality: spec.windingQuality,
    coreSize: { ...spec.coreSize },
    height: { ...spec.height },
    layers: { ...spec.layers },
    objective: spec.objective,
    base: spec.base,
    topCap: spec.topCap,
    joint: spec.joint,
    tolerance: spec.tolerance,
    print: { ...spec.print },
    label: spec.label,
    mount: spec.mount,
    plateJoint: spec.plateJoint,
    keyholeRotation: spec.keyholeRotation,
    skadisLatch: spec.skadisLatch,
    strapSlots: spec.strapSlots,
    throughHoleDiameter: spec.throughHoleDiameter,
  };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(encoded: string): Uint8Array {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeDoc(doc: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(doc)));
}

function decodeDoc(encoded: string): unknown | undefined {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBytes(encoded)));
  } catch {
    return undefined;
  }
}

const DocSchema = z
  .object({
    v: z.literal(DOC_VERSION),
    L: z.number().finite().positive().max(MAX_WIRE_LENGTH).optional(),
    d: z.number().finite().min(0.5).max(20).optional(),
    wt: z.enum(["usb", "flex", "stiff", "custom"]).optional(),
    mbr: z.number().finite().positive().max(50).optional(),
    q: z.number().finite().min(0).max(1).optional(),
    obj: z.literal("ar").optional(),
    shape: z.enum(["sq", "tri", "pill"]).optional(),
    rc: z.number().finite().min(0).max(1000).optional(),
    mount: z.enum(["keyhole", "through", "skadis", "skadis-tclip"]).optional(),
    latch: z.literal(false).optional(),
    strap: z.literal(true).optional(),
    kr: z.union([z.literal(0), z.literal(45)]).optional(),
    thd: z.number().finite().min(THROUGH_HOLE_DIAMETER_MIN).max(THROUGH_HOLE_DIAMETER_MAX).optional(),
    lock: z.array(z.enum(LOCK_TOKENS)).max(LOCK_TOKENS.length).optional(),
    size: z.number().finite().min(1).max(1000).optional(),
    h: z.number().finite().min(1).max(1000).optional(),
    ly: z.number().int().min(1).max(100).optional(),
    cap: z.enum(["on", "off"]).optional(),
    base: z.enum(["on", "off"]).optional(),
    joint: z.enum(["bayonet", "snap"]).optional(),
    tol: z.number().finite().min(TOLERANCE_MIN).max(TOLERANCE_MAX).optional(),
    bx: z.number().finite().min(BED_SIZE_MIN).max(BED_SIZE_MAX).optional(),
    by: z.number().finite().min(BED_SIZE_MIN).max(BED_SIZE_MAX).optional(),
    bz: z.number().finite().min(BED_SIZE_MIN).max(BED_SIZE_MAX).optional(),
    label: z.string().max(LABEL_MAX_LENGTH).optional(),
    ui: z
      .object({
        wire: z.literal(false).optional(),
        view: z.literal("guide").optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type Doc = z.infer<typeof DocSchema>;

function validateLockTokens(tokens: Iterable<string>): string | undefined {
  const set = new Set(tokens);
  for (const t of set) {
    if (!(LOCK_TOKENS as readonly string[]).includes(t)) {
      return `Unknown lock "${t}" in the link: showing default values instead.`;
    }
  }
  if (set.has("outer") && set.has("inner")) {
    return "The link locks both the outer and inner size: showing default values instead.";
  }
  return undefined;
}

function capMaxTwoLocked(tokens: Set<string>): { tokens: Set<string>; droppedLayers: boolean } {
  const sizeLocked = tokens.has("outer") || tokens.has("inner");
  if (sizeLocked && tokens.has("h") && tokens.has("ly")) {
    const next = new Set(tokens);
    next.delete("ly");
    return { tokens: next, droppedLayers: true };
  }
  return { tokens, droppedLayers: false };
}

function buildParsed(p: {
  L?: number;
  d?: number;
  wt?: WireTypeId;
  mbr?: number;
  q?: number;
  obj?: "ar";
  shapeKind: ShapeKind;
  rc?: number;
  mount?: MountKind;
  latch?: false;
  strap?: true;
  kr?: KeyholeRotation;
  thd?: number;
  lockTokens: Set<string>;
  size?: number;
  h?: number;
  ly?: number;
  showWire: boolean;
  view: ViewMode;
  cap?: TopCapMode;
  base?: BaseMode;
  joint?: JointKind;
  tol?: number;
  bx?: number;
  by?: number;
  bz?: number;
  label?: string;
}): ParsedHash {
  const shape: ShapeSpec =
    p.shapeKind === "round" ? { kind: "round" } : { kind: p.shapeKind, cornerRadius: p.rc ?? defaultCornerRadius(p.shapeKind) };

  const coreSize: CoreSizeLock = p.lockTokens.has("outer")
    ? { locked: true, dimension: "outer", value: p.size ?? DEFAULT_OUTER_SIZE }
    : p.lockTokens.has("inner")
      ? { locked: true, dimension: "inner", value: p.size ?? DEFAULT_OUTER_SIZE }
      : { locked: false };
  const height: Lock<number> = p.lockTokens.has("h") ? { locked: true, value: p.h ?? DEFAULT_HEIGHT } : { locked: false };
  const layers: Lock<number> = p.lockTokens.has("ly") ? { locked: true, value: p.ly ?? DEFAULT_LAYERS } : { locked: false };

  const spec: CoilSpec = {
    wire: {
      length: p.L ?? DEFAULT_SPEC.wire.length,
      diameter: p.d ?? DEFAULT_SPEC.wire.diameter,
      type: p.wt ?? DEFAULT_SPEC.wire.type,
      customBendMultiplier: p.wt === "custom" ? (p.mbr ?? DEFAULT_CUSTOM_BEND_MULTIPLIER) : undefined,
    },
    shape,
    windingQuality: p.q ?? DEFAULT_SPEC.windingQuality,
    coreSize,
    height,
    layers,
    objective: p.obj === "ar" ? "aspectRatio" : "minVolume",
    base: p.base ?? DEFAULT_SPEC.base,
    topCap: p.cap ?? DEFAULT_SPEC.topCap,
    joint: p.joint ?? DEFAULT_SPEC.joint,
    tolerance: p.tol ?? DEFAULT_SPEC.tolerance,
    print: {
      bedX: p.bx ?? DEFAULT_SPEC.print.bedX,
      bedY: p.by ?? DEFAULT_SPEC.print.bedY,
      bedZ: p.bz ?? DEFAULT_SPEC.print.bedZ,
    },
    label: p.label || undefined,
    mount: p.mount ?? "none",
    plateJoint: DEFAULT_SPEC.plateJoint,
    keyholeRotation: p.kr ?? DEFAULT_SPEC.keyholeRotation,
    skadisLatch: p.latch ?? DEFAULT_SPEC.skadisLatch,
    strapSlots: p.strap ?? DEFAULT_SPEC.strapSlots,
    throughHoleDiameter: p.thd ?? DEFAULT_SPEC.throughHoleDiameter,
  };
  return { spec, showWire: p.showWire, view: p.view };
}

function parseDocHash(encoded: string): ParsedHash {
  const decoded = decodeDoc(encoded);
  if (decoded === undefined) {
    return fallback('Could not read this link ("s" is not a valid encoded document): showing default values instead.');
  }
  const rawVersion = decoded && typeof decoded === "object" ? (decoded as Record<string, unknown>).v : undefined;
  if (rawVersion !== undefined && rawVersion !== DOC_VERSION) {
    return fallback(`Unsupported link version "${rawVersion}": showing default values instead.`);
  }

  const result = DocSchema.safeParse(decoded);
  if (!result.success) {
    return fallback('Could not read this link ("lock" and shape parameters are validated together): showing default values instead.');
  }
  const p = result.data;

  const requestedLockTokens = new Set<string>(p.lock ?? DEFAULT_LOCK_TOKENS);
  const lockNotice = validateLockTokens(requestedLockTokens);
  if (lockNotice) return fallback(lockNotice);
  const { tokens: lockTokens, droppedLayers } = capMaxTwoLocked(requestedLockTokens);

  if (p.wt !== "custom" && p.mbr !== undefined) {
    return fallback('The link sets a custom bend multiplier ("mbr") without wt=custom: showing default values instead.');
  }
  if (p.shape === undefined && p.rc !== undefined) {
    return fallback('The link sets a corner radius ("rc") without selecting a shape that uses one: showing default values instead.');
  }
  if (p.mount !== "keyhole" && p.kr !== undefined) {
    return fallback('The link sets a keyhole rotation ("kr") without mount=keyhole: showing default values instead.');
  }
  if (p.mount !== "through" && p.thd !== undefined) {
    return fallback('The link sets a through-hole diameter ("thd") without mount=through: showing default values instead.');
  }
  if (p.mount !== "skadis" && p.latch !== undefined) {
    return fallback('The link sets the SKÅDIS latch ("latch") without mount=skadis: showing default values instead.');
  }

  const parsed = buildParsed({
    L: p.L,
    d: p.d,
    wt: p.wt,
    mbr: p.mbr,
    q: p.q,
    obj: p.obj,
    shapeKind: p.shape ?? "round",
    rc: p.rc,
    mount: p.mount,
    latch: p.latch,
    strap: p.strap,
    kr: p.kr,
    thd: p.thd,
    lockTokens,
    size: p.size,
    h: p.h,
    ly: p.ly,
    showWire: p.ui?.wire ?? DEFAULT_SHOW_WIRE,
    view: p.ui?.view ?? DEFAULT_VIEW,
    cap: p.cap,
    base: p.base,
    joint: p.joint,
    tol: p.tol,
    bx: p.bx,
    by: p.by,
    bz: p.bz,
    label: p.label,
  });
  return droppedLayers
    ? { ...parsed, notice: "This link locks core size, height and layers all at once: something has to stay free to fit the cable length, so layers was left free." }
    : parsed;
}

export function parseHash(hash: string): ParsedHash {
  const qs = hash.replace(/^#/, "");
  if (!qs) return { spec: cloneSpec(DEFAULT_SPEC), showWire: DEFAULT_SHOW_WIRE, view: DEFAULT_VIEW };

  return parseDocHash(new URLSearchParams(qs).get("s") ?? "");
}

export function toHash(spec: CoilSpec, showWire: boolean = DEFAULT_SHOW_WIRE, view: ViewMode = DEFAULT_VIEW): string {
  const doc: Doc = { v: DOC_VERSION };

  if (spec.wire.length !== DEFAULT_SPEC.wire.length) doc.L = spec.wire.length;
  if (spec.wire.diameter !== DEFAULT_SPEC.wire.diameter) doc.d = spec.wire.diameter;
  if (spec.wire.type !== DEFAULT_SPEC.wire.type) doc.wt = spec.wire.type;
  if (spec.wire.type === "custom" && (spec.wire.customBendMultiplier ?? DEFAULT_CUSTOM_BEND_MULTIPLIER) !== DEFAULT_CUSTOM_BEND_MULTIPLIER) {
    doc.mbr = spec.wire.customBendMultiplier;
  }
  if (spec.windingQuality !== DEFAULT_SPEC.windingQuality) doc.q = spec.windingQuality;
  if (spec.objective !== DEFAULT_SPEC.objective) doc.obj = "ar";

  if (spec.shape.kind !== "round") {
    doc.shape = spec.shape.kind;
    if (spec.shape.cornerRadius !== defaultCornerRadius(spec.shape.kind)) doc.rc = spec.shape.cornerRadius;
  }

  const lockTokens: LockToken[] = [];
  if (spec.coreSize.locked) {
    lockTokens.push(spec.coreSize.dimension);
    if (spec.coreSize.value !== DEFAULT_OUTER_SIZE) doc.size = spec.coreSize.value;
  }
  if (spec.height.locked) {
    lockTokens.push("h");
    if (spec.height.value !== DEFAULT_HEIGHT) doc.h = spec.height.value;
  }
  if (spec.layers.locked) {
    lockTokens.push("ly");
    if (spec.layers.value !== DEFAULT_LAYERS) doc.ly = spec.layers.value;
  }
  if (lockTokens.join(",") !== DEFAULT_LOCK_TOKENS.join(",")) doc.lock = lockTokens;

  if (spec.topCap !== "auto") doc.cap = spec.topCap;
  if (spec.joint !== "press") doc.joint = spec.joint;
  if (spec.base !== undefined && spec.base !== DEFAULT_SPEC.base) doc.base = spec.base;
  if (spec.tolerance !== DEFAULT_SPEC.tolerance) doc.tol = spec.tolerance;
  if (spec.label) doc.label = spec.label;
  if (spec.mount === "keyhole" || spec.mount === "through" || spec.mount === "skadis" || spec.mount === "skadis-tclip") doc.mount = spec.mount;
  if (spec.mount === "skadis" && spec.skadisLatch === false) doc.latch = false;
  if (spec.strapSlots) doc.strap = true;
  if (spec.mount === "keyhole" && spec.keyholeRotation !== DEFAULT_SPEC.keyholeRotation) doc.kr = spec.keyholeRotation;
  if (spec.mount === "through" && spec.throughHoleDiameter !== DEFAULT_SPEC.throughHoleDiameter) doc.thd = spec.throughHoleDiameter;

  if (spec.print.bedX !== DEFAULT_SPEC.print.bedX) doc.bx = spec.print.bedX;
  if (spec.print.bedY !== DEFAULT_SPEC.print.bedY) doc.by = spec.print.bedY;
  if (spec.print.bedZ !== DEFAULT_SPEC.print.bedZ) doc.bz = spec.print.bedZ;

  const ui: NonNullable<Doc["ui"]> = {};
  if (showWire !== DEFAULT_SHOW_WIRE) ui.wire = false;
  if (view !== DEFAULT_VIEW) ui.view = "guide";
  if (Object.keys(ui).length > 0) doc.ui = ui;

  return `#s=${encodeDoc(doc)}`;
}
