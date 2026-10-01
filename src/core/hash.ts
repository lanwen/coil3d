// Versioned URL hash codec (docs/design.md, URL hash; issue #56). The hash is
// `#s=<base64url(JSON)>`: a compact, schema-validated (zod) document that
// omits defaults and always stamps a numeric `v`. Falls back to defaults
// with a notice on garbage input.
//
// The document holds the WHOLE hash-worthy app state, not just `CoilSpec`:
// the top-level keys mirror `CoilSpec` (lengths stay mm; the cm display in
// the controls is a UI-only conversion, see ControlsForm), and a nested
// `ui` object carries the view-only state that isn't part of the spec at
// all -- the wire-visibility toggle (`ui.wire`) and the design/guide screen
// switch (`ui.view`), both omitted when at their default. Neither changes
// what `design()` computes; they only round-trip here because a shared link
// should be able to reproduce the exact screen the user was looking at.
//
// There is no compatibility layer for older link formats (the project is in
// beta): anything that isn't a readable `#s=` document, including the old
// flat key=value query string, falls back to defaults with a notice.
//
// Compression: deliberately NOT applied. `CompressionStream` is a streaming,
// async API, which would make this codec's public interface async too (every
// other seam -- `design()`, `exportDesign()` -- already draws exactly that
// line between sync business logic and async I/O, see core/index.ts); a
// synchronous alternative would mean adding `fflate` as a new dependency,
// which this repo already chose not to do for 3MF's own zip (see
// threeMf.ts's file header) in favour of hand-rolling the little it needed.
// Given links are already short once defaults are omitted (see the vitest
// "typical links stay short" case, and the 3 example lengths reported on
// the PR), a compression step would only add a dependency and a few bytes
// of deflate-stream overhead for no measurable win.
//
// `label` (issue #12) is the top cap's engraved text -- a real `CoilSpec`
// field (unlike `ui.wire`/`ui.view`: it changes the geometry, not just the
// view). It survives the JSON + UTF-8 + base64url round trip losslessly,
// unlike the old `URLSearchParams`-encoded query string -- see
// `bytesToBase64Url`/`base64UrlToBytes` below -- so unicode labels (issue
// #56 AC) need no special-casing here at all.

import { z } from "zod";
import {
  BED_SIZE_MAX,
  BED_SIZE_MIN,
  DEFAULT_BED_SIZE,
  DEFAULT_CORNER_RADIUS,
  DEFAULT_THROUGH_HOLE_DIAMETER,
  DEFAULT_TOLERANCE,
  LABEL_MAX_LENGTH,
  MAX_WIRE_LENGTH,
  THROUGH_HOLE_DIAMETER_MAX,
  THROUGH_HOLE_DIAMETER_MIN,
  TOLERANCE_MAX,
  TOLERANCE_MIN,
} from "./constants";
import { DEFAULT_CUSTOM_BEND_MULTIPLIER } from "./types";
import type { CoilSpec, CoreSizeLock, JointKind, KeyholeRotation, Lock, MountKind, PlateJoint, ShapeKind, ShapeSpec, TopCapMode, WireTypeId } from "./types";

/** The current (`#s=`) document version. Bump this and add a migration branch if the shape ever changes incompatibly. */
const DOC_VERSION = 2;

const DEFAULT_OUTER_SIZE = 30;
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
  topCap: "auto",
  joint: "press",
  tolerance: DEFAULT_TOLERANCE,
  print: { bedX: DEFAULT_BED_SIZE, bedY: DEFAULT_BED_SIZE, bedZ: DEFAULT_BED_SIZE },
  mount: "none",
  plateJoint: "glue",
  keyholeRotation: 0,
  throughHoleDiameter: DEFAULT_THROUGH_HOLE_DIAMETER,
};

export const DEFAULT_SHOW_WIRE = true;

/** The design/guide screen switch (issue #17). `"design"` is the default, never written to `ui.view`. */
export type ViewMode = "design" | "guide";
const DEFAULT_VIEW: ViewMode = "design";

const DEFAULT_LOCK_TOKENS = ["outer", "ly"] as const;
const LOCK_TOKENS = ["outer", "inner", "h", "ly"] as const;
type LockToken = (typeof LOCK_TOKENS)[number];

export interface ParsedHash {
  spec: CoilSpec;
  /** Whether the schematic wound-cable render should be shown (issue #4). */
  showWire: boolean;
  /** Which screen the app should show (issue #17). */
  view: ViewMode;
  /** Set when the hash was unreadable and defaults were substituted. */
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
    topCap: spec.topCap,
    joint: spec.joint,
    tolerance: spec.tolerance,
    print: { ...spec.print },
    label: spec.label,
    mount: spec.mount,
    plateJoint: spec.plateJoint,
    keyholeRotation: spec.keyholeRotation,
    throughHoleDiameter: spec.throughHoleDiameter,
  };
}

// --- base64url <-> bytes -----------------------------------------------
//
// Plain `btoa`/`atob` (available as globals in both the browser and Node 22,
// no import needed) only round-trip a "binary string" (one Latin-1 code
// point per byte); JSON labels can carry any unicode character, so the JSON
// string is first turned into UTF-8 bytes (`TextEncoder`/`TextDecoder`,
// also global) and those bytes -- not the string itself -- are what gets
// base64-encoded. The base64 alphabet's `+`/`/` (and its `=` padding, which
// would otherwise collide with `URLSearchParams`' own `key=value` split) are
// swapped/stripped for the URL-safe "base64url" variant, restored before
// decoding.

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

/** Returns `undefined` on any malformed input (bad base64, bad UTF-8, bad JSON) -- callers fall back to defaults. */
function decodeDoc(encoded: string): unknown | undefined {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBytes(encoded)));
  } catch {
    return undefined;
  }
}

// --- the `#s=` document schema ------------------------------------------
//
// Flat, with short keys (nesting `lock` as a real JSON array is the only
// structural win worth taking here -- see the header comment).

const DocSchema = z
  .object({
    v: z.literal(DOC_VERSION),
    L: z.number().finite().positive().max(MAX_WIRE_LENGTH).optional(),
    d: z.number().finite().min(0.5).max(20).optional(),
    wt: z.enum(["usb", "flex", "stiff", "custom"]).optional(),
    mbr: z.number().finite().positive().max(50).optional(),
    q: z.number().finite().min(0).max(1).optional(),
    obj: z.literal("ar").optional(),
    shape: z.enum(["sq", "tri"]).optional(),
    rc: z.number().finite().min(0).max(1000).optional(),
    // "opengrid" is deliberately NOT in this list (issue #14 PR review, issue
    // #38): the underlying mount kind is implemented, but its connector
    // geometry is a placeholder, so a shared link can't be allowed to
    // silently produce it -- any value other than "keyhole"/"through"/
    // "skadis" fails this schema, the same as any other garbage input
    // (defaults + notice).
    mount: z.enum(["keyhole", "through", "skadis"]).optional(),
    pj: z.literal("snap").optional(),
    // Issue #71: only ever one of KEYHOLE_ROTATION_OPTIONS (90 is not
    // offered -- see that constant's own doc comment).
    kr: z.union([z.literal(0), z.literal(45)]).optional(),
    // Issue #70: through-hole (screw-shank clearance) diameter, mm.
    thd: z.number().finite().min(THROUGH_HOLE_DIAMETER_MIN).max(THROUGH_HOLE_DIAMETER_MAX).optional(),
    lock: z.array(z.enum(LOCK_TOKENS)).max(LOCK_TOKENS.length).optional(),
    size: z.number().finite().min(1).max(1000).optional(),
    h: z.number().finite().min(1).max(1000).optional(),
    ly: z.number().int().min(1).max(100).optional(),
    cap: z.enum(["on", "off"]).optional(),
    joint: z.enum(["bayonet", "snap"]).optional(),
    tol: z.number().finite().min(TOLERANCE_MIN).max(TOLERANCE_MAX).optional(),
    bx: z.number().finite().min(BED_SIZE_MIN).max(BED_SIZE_MAX).optional(),
    by: z.number().finite().min(BED_SIZE_MIN).max(BED_SIZE_MAX).optional(),
    bz: z.number().finite().min(BED_SIZE_MIN).max(BED_SIZE_MAX).optional(),
    label: z.string().max(LABEL_MAX_LENGTH).optional(),
    // View-only state (issue #17's design/guide switch, issue #4's wire
    // toggle): NOT `CoilSpec` fields, but still part of "the whole hash
    // worthy state" this document holds -- nested here rather than flattened
    // alongside the spec keys above so the two categories stay visually
    // distinct. Omitted entirely (not just its own keys) when both are at
    // their default -- see `toHash`.
    ui: z
      .object({
        wire: z.literal(false).optional(),
        view: z.literal("guide").optional(),
      })
      .strict()
      .optional(),
  })
  // Reject unrecognised keys outright (rather than silently ignoring them):
  // a hand-crafted/corrupted `#s=` payload with stray keys is exactly the
  // "garbage payload" case the AC asks to fall back on, and there's no
  // forward-compat reason yet to be lenient.
  .strict();

type Doc = z.infer<typeof DocSchema>;

/** Validates the lock-token set, returning a notice on failure. */
function validateLockTokens(tokens: Iterable<string>): string | undefined {
  const set = new Set(tokens);
  for (const t of set) {
    if (!(LOCK_TOKENS as readonly string[]).includes(t)) {
      return `Unknown lock "${t}" in the link -- showing default values instead.`;
    }
  }
  if (set.has("outer") && set.has("inner")) {
    return "The link locks both the outer and inner size -- showing default values instead.";
  }
  return undefined;
}

/**
 * Issue #119: the UI now enforces "at most 2 of {core size, height, layers}
 * locked at once" (something has to stay free to fit the cable length), so
 * a link asking to lock all three is no longer a state the app can produce
 * itself. Rather than fail the whole link (`fallback`, which would also
 * discard every OTHER field the link set), this drops one lock and keeps
 * going: a documented, deterministic tie-break -- always "ly" (layers),
 * since a locked core size + height already pins the tube's own geometry,
 * and letting the solver pick the layer count is the same "free" that
 * choosing objective="minVolume" already defaults to elsewhere. Only ever
 * called from `parseDocHash`.
 */
function capMaxTwoLocked(tokens: Set<string>): { tokens: Set<string>; droppedLayers: boolean } {
  const sizeLocked = tokens.has("outer") || tokens.has("inner");
  if (sizeLocked && tokens.has("h") && tokens.has("ly")) {
    const next = new Set(tokens);
    next.delete("ly");
    return { tokens: next, droppedLayers: true };
  }
  return { tokens, droppedLayers: false };
}

/** Builds the resolved `CoilSpec` + `showWire` once every raw field is validated and typed. */
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
  pj?: PlateJoint;
  kr?: KeyholeRotation;
  thd?: number;
  lockTokens: Set<string>;
  size?: number;
  h?: number;
  ly?: number;
  showWire: boolean;
  view: ViewMode;
  cap?: TopCapMode;
  joint?: JointKind;
  tol?: number;
  bx?: number;
  by?: number;
  bz?: number;
  label?: string;
}): ParsedHash {
  const shape: ShapeSpec =
    p.shapeKind === "round" ? { kind: "round" } : { kind: p.shapeKind, cornerRadius: p.rc ?? DEFAULT_CORNER_RADIUS };

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
    plateJoint: p.pj ?? DEFAULT_SPEC.plateJoint,
    keyholeRotation: p.kr ?? DEFAULT_SPEC.keyholeRotation,
    throughHoleDiameter: p.thd ?? DEFAULT_SPEC.throughHoleDiameter,
  };
  return { spec, showWire: p.showWire, view: p.view };
}

function parseDocHash(encoded: string): ParsedHash {
  const decoded = decodeDoc(encoded);
  if (decoded === undefined) {
    return fallback('Could not read this link ("s" is not a valid encoded document) -- showing default values instead.');
  }
  // Check the version before full schema validation so a future/foreign
  // version gets its own clearer notice.
  const rawVersion = decoded && typeof decoded === "object" ? (decoded as Record<string, unknown>).v : undefined;
  if (rawVersion !== undefined && rawVersion !== DOC_VERSION) {
    return fallback(`Unsupported link version "${rawVersion}" -- showing default values instead.`);
  }

  const result = DocSchema.safeParse(decoded);
  if (!result.success) {
    return fallback('Could not read this link ("lock" and shape parameters are validated together) -- showing default values instead.');
  }
  const p = result.data;

  const requestedLockTokens = new Set<string>(p.lock ?? DEFAULT_LOCK_TOKENS);
  const lockNotice = validateLockTokens(requestedLockTokens);
  if (lockNotice) return fallback(lockNotice);
  // Issue #119: normalize (not fallback) a link locking all three -- see
  // `capMaxTwoLocked`'s own doc comment for why this drops "ly" specifically.
  const { tokens: lockTokens, droppedLayers } = capMaxTwoLocked(requestedLockTokens);

  if (p.wt !== "custom" && p.mbr !== undefined) {
    return fallback('The link sets a custom bend multiplier ("mbr") without wt=custom -- showing default values instead.');
  }
  if (p.shape !== "sq" && p.shape !== "tri" && p.rc !== undefined) {
    return fallback('The link sets a corner radius ("rc") without selecting a shape that uses one -- showing default values instead.');
  }
  if (p.mount !== "keyhole" && p.kr !== undefined) {
    return fallback('The link sets a keyhole rotation ("kr") without mount=keyhole -- showing default values instead.');
  }
  if (p.mount !== "through" && p.thd !== undefined) {
    return fallback('The link sets a through-hole diameter ("thd") without mount=through -- showing default values instead.');
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
    pj: p.pj,
    kr: p.kr,
    thd: p.thd,
    lockTokens,
    size: p.size,
    h: p.h,
    ly: p.ly,
    showWire: p.ui?.wire ?? DEFAULT_SHOW_WIRE,
    view: p.ui?.view ?? DEFAULT_VIEW,
    cap: p.cap,
    joint: p.joint,
    tol: p.tol,
    bx: p.bx,
    by: p.by,
    bz: p.bz,
    label: p.label,
  });
  return droppedLayers
    ? { ...parsed, notice: "This link locks core size, height and layers all at once -- something has to stay free to fit the cable length, so layers was left free." }
    : parsed;
}

/**
 * Parse a `location.hash`-style string (with or without the leading `#`).
 * Reads the `#s=<base64url(JSON)>` format; anything else falls back to
 * defaults with a notice.
 */
export function parseHash(hash: string): ParsedHash {
  const qs = hash.replace(/^#/, "");
  if (!qs) return { spec: cloneSpec(DEFAULT_SPEC), showWire: DEFAULT_SHOW_WIRE, view: DEFAULT_VIEW };

  // Only the `s` param is read: a hash without it (e.g. an old flat
  // query-string link) decodes as garbage and falls back like any other
  // unreadable link, and any other param next to `s` is ignored.
  return parseDocHash(new URLSearchParams(qs).get("s") ?? "");
}

/** Encode a spec (+ the view-only `showWire`/`view` state) into a hash string (with leading `#`), omitting defaults. Always writes the current `#s=` format. */
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
    if (spec.shape.cornerRadius !== DEFAULT_CORNER_RADIUS) doc.rc = spec.shape.cornerRadius;
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

  // Narrowed against the literal default (not `DEFAULT_SPEC.topCap`/`.joint`,
  // whose own declared types are the full `TopCapMode`/`JointKind` unions,
  // which wouldn't narrow `spec.topCap`/`spec.joint` down to the doc's
  // stricter "only the non-default values" field types below).
  if (spec.topCap !== "auto") doc.cap = spec.topCap;
  if (spec.joint !== "press") doc.joint = spec.joint;
  if (spec.tolerance !== DEFAULT_SPEC.tolerance) doc.tol = spec.tolerance;
  if (spec.label) doc.label = spec.label;
  // "opengrid" is unreachable through the UI (ControlsForm hides it) and
  // rejected on parse (see DocSchema's `mount` comment); if it ever got
  // here anyway, omitting it (falls back to "none" on reload) is safer
  // than writing a value this same codec can't read back.
  if (spec.mount === "keyhole" || spec.mount === "through" || spec.mount === "skadis") doc.mount = spec.mount;
  if ((spec.mount === "skadis" || spec.mount === "opengrid") && spec.plateJoint === "snap") doc.pj = "snap";
  if (spec.mount === "keyhole" && spec.keyholeRotation !== DEFAULT_SPEC.keyholeRotation) doc.kr = spec.keyholeRotation;
  if (spec.mount === "through" && spec.throughHoleDiameter !== DEFAULT_SPEC.throughHoleDiameter) doc.thd = spec.throughHoleDiameter;

  if (spec.print.bedX !== DEFAULT_SPEC.print.bedX) doc.bx = spec.print.bedX;
  if (spec.print.bedY !== DEFAULT_SPEC.print.bedY) doc.by = spec.print.bedY;
  if (spec.print.bedZ !== DEFAULT_SPEC.print.bedZ) doc.bz = spec.print.bedZ;

  // View-only state, nested under `ui` (see this file's own header) --
  // omitted entirely when both are at their default.
  const ui: NonNullable<Doc["ui"]> = {};
  if (showWire !== DEFAULT_SHOW_WIRE) ui.wire = false;
  if (view !== DEFAULT_VIEW) ui.view = "guide";
  if (Object.keys(ui).length > 0) doc.ui = ui;

  return `#s=${encodeDoc(doc)}`;
}
