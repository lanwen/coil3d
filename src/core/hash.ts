// Versioned URL hash codec (docs/research.md §7, issue #56). The hash is
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
// Legacy links (`#v=1&L=..&d=..&...`, the flat key=value format this ticket
// replaces) still parse -- `parseLegacyHash` below is that original codec,
// kept byte-for-byte in behaviour, including its own flat `wire=0/1` and
// (read leniently, unvalidated, exactly like the pre-#56 `App.tsx` used to)
// `view=guide` params. `toHash` always re-emits the new `#s=` format with
// `ui` embedded, so `App.tsx`'s `replaceState` on load silently migrates
// any legacy link the moment it's opened (issue #56 AC: "Legacy links
// migrate losslessly"). The short-lived intermediate format this ticket
// briefly shipped (`#s=...&wire=0`/`&view=guide`, `ui` as literal companion
// params rather than inside the document) is ALSO still read the same
// lenient way, purely so any link generated during that window keeps
// migrating forward too -- see `parseHash`'s own comment.
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
/** The legacy (`#v=1&...`) flat query-string version this ticket replaces. Still parsed, never written. */
const LEGACY_HASH_VERSION = "1";

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
// Flat, like the legacy query string it replaces (nesting `lock` as a real
// JSON array is the only structural win worth taking here -- see the header
// comment) and reusing the same short keys/tokens established there, so the
// two codecs stay easy to read side by side.

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
    // Issue #71: only ever one of KEYHOLE_ROTATION_OPTIONS.
    kr: z.union([z.literal(0), z.literal(45), z.literal(90)]).optional(),
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
  // Reject unrecognised keys outright (rather than silently ignoring them,
  // as the legacy `QuerySchema` does): a hand-crafted/corrupted `#s=`
  // payload with stray keys is exactly the "garbage payload" case the AC
  // asks to fall back on, and there's no forward-compat reason yet to be
  // lenient about a document format this ticket is only just introducing.
  .strict();

type Doc = z.infer<typeof DocSchema>;

/** Shared by both codecs: validates the lock-token set, returning a notice on failure. */
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

/** Shared by both codecs: builds the resolved `CoilSpec` + `showWire` once every raw field is validated and typed. */
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
  // version gets its own clearer notice, same as the legacy codec's `v` check.
  const rawVersion = decoded && typeof decoded === "object" ? (decoded as Record<string, unknown>).v : undefined;
  if (rawVersion !== undefined && rawVersion !== DOC_VERSION) {
    return fallback(`Unsupported link version "${rawVersion}" -- showing default values instead.`);
  }

  const result = DocSchema.safeParse(decoded);
  if (!result.success) {
    return fallback('Could not read this link ("lock" and shape parameters are validated together) -- showing default values instead.');
  }
  const p = result.data;

  const lockTokens = new Set<string>(p.lock ?? DEFAULT_LOCK_TOKENS);
  const lockNotice = validateLockTokens(lockTokens);
  if (lockNotice) return fallback(lockNotice);

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

  return buildParsed({
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
}

// --- the legacy (`#v=1&...`) flat query string --------------------------
//
// Kept as its own, self-contained codec (rather than reusing `DocSchema`)
// because its shape genuinely differs -- `sq.rc`/`tri.rc` namespacing,
// comma-joined `lock`, string `"0"/"1"` wire flag -- and every legacy value
// this ticket ships must keep parsing exactly as it did before (issue #56
// AC: "legacy links migrate losslessly"). `toHash` never writes this format
// again; it only exists to be read.

const LegacyQuerySchema = z.object({
  v: z.string().optional(),
  L: z.coerce.number().finite().positive().max(MAX_WIRE_LENGTH).optional(),
  d: z.coerce.number().finite().min(0.5).max(20).optional(),
  wt: z.enum(["usb", "flex", "stiff", "custom"]).optional(),
  mbr: z.coerce.number().finite().positive().max(50).optional(),
  q: z.coerce.number().finite().min(0).max(1).optional(),
  obj: z.enum(["mv", "ar"]).optional(),
  shape: z.enum(["round", "sq", "tri"]).optional(),
  "sq.rc": z.coerce.number().finite().min(0).max(1000).optional(),
  "tri.rc": z.coerce.number().finite().min(0).max(1000).optional(),
  mount: z.enum(["none", "keyhole", "skadis"]).optional(),
  pj: z.enum(["glue", "snap"]).optional(),
  lock: z.string().optional(),
  size: z.coerce.number().finite().min(1).max(1000).optional(),
  h: z.coerce.number().finite().min(1).max(1000).optional(),
  ly: z.coerce.number().int().min(1).max(100).optional(),
  wire: z.enum(["0", "1"]).optional(),
  cap: z.enum(["auto", "on", "off"]).optional(),
  joint: z.enum(["press", "bayonet", "snap"]).optional(),
  tol: z.coerce.number().finite().min(TOLERANCE_MIN).max(TOLERANCE_MAX).optional(),
  bx: z.coerce.number().finite().min(BED_SIZE_MIN).max(BED_SIZE_MAX).optional(),
  by: z.coerce.number().finite().min(BED_SIZE_MIN).max(BED_SIZE_MAX).optional(),
  bz: z.coerce.number().finite().min(BED_SIZE_MIN).max(BED_SIZE_MAX).optional(),
  label: z.string().max(LABEL_MAX_LENGTH).optional(),
});

function parseLegacyHash(qs: string): ParsedHash {
  const raw = Object.fromEntries(new URLSearchParams(qs).entries());
  if (raw.v !== undefined && raw.v !== LEGACY_HASH_VERSION) {
    return fallback(`Unsupported link version "${raw.v}" -- showing default values instead.`);
  }

  const result = LegacyQuerySchema.safeParse(raw);
  if (!result.success) {
    return fallback('Could not read this link ("lock" and shape parameters are validated together) -- showing default values instead.');
  }
  const p = result.data;

  const lockTokens = new Set<string>(p.lock !== undefined ? p.lock.split(",").filter(Boolean) : DEFAULT_LOCK_TOKENS);
  const lockNotice = validateLockTokens(lockTokens);
  if (lockNotice) return fallback(lockNotice);

  const wireType: WireTypeId = p.wt ?? DEFAULT_SPEC.wire.type;
  if (wireType !== "custom" && p.mbr !== undefined) {
    return fallback('The link sets a custom bend multiplier ("mbr") without wt=custom -- showing default values instead.');
  }

  const shapeKind: ShapeKind = p.shape ?? "round";
  if (shapeKind !== "sq" && p["sq.rc"] !== undefined) {
    return fallback('The link sets a square corner radius ("sq.rc") without shape=sq -- showing default values instead.');
  }
  if (shapeKind !== "tri" && p["tri.rc"] !== undefined) {
    return fallback('The link sets a triangle corner radius ("tri.rc") without shape=tri -- showing default values instead.');
  }
  const rc = shapeKind === "sq" ? p["sq.rc"] : shapeKind === "tri" ? p["tri.rc"] : undefined;

  // `view` was never part of this schema even before issue #56 -- pre-#56
  // `App.tsx` read it with a bare, unvalidated `=== "guide"` check on the
  // raw hash string, so a shared `&view=guide` link kept working no matter
  // what else was on the URL. Matching that same leniency here (reading
  // straight off `raw`, not through `LegacyQuerySchema`) means an unrelated
  // typo in `view` can't turn into a whole-hash parse failure.
  const view: ViewMode = raw.view === "guide" ? "guide" : DEFAULT_VIEW;

  return buildParsed({
    L: p.L,
    d: p.d,
    wt: wireType,
    mbr: p.mbr,
    q: p.q,
    obj: p.obj === "ar" ? "ar" : undefined,
    shapeKind,
    rc,
    mount: p.mount,
    pj: p.pj,
    lockTokens,
    size: p.size,
    h: p.h,
    ly: p.ly,
    showWire: p.wire !== undefined ? p.wire !== "0" : DEFAULT_SHOW_WIRE,
    view,
    cap: p.cap,
    joint: p.joint,
    tol: p.tol,
    bx: p.bx,
    by: p.by,
    bz: p.bz,
    label: p.label,
  });
}

/**
 * Parse a `location.hash`-style string (with or without the leading `#`).
 * Reads the current `#s=<base64url(JSON)>` format, or a legacy `#v=1&...`
 * link (migrated in place, never rewritten by this function itself --
 * `App.tsx`'s own `history.replaceState` on `toHash`'s output is what
 * actually rewrites the URL bar, issue #56 AC).
 */
export function parseHash(hash: string): ParsedHash {
  const qs = hash.replace(/^#/, "");
  if (!qs) return { spec: cloneSpec(DEFAULT_SPEC), showWire: DEFAULT_SHOW_WIRE, view: DEFAULT_VIEW };

  const params = new URLSearchParams(qs);
  const s = params.get("s");
  if (s === null) return parseLegacyHash(qs);

  const parsed = parseDocHash(s);
  if (parsed.notice) return parsed;

  // Backward compat with the short-lived companion-param format this ticket
  // briefly shipped (`#s=...&wire=0`/`&view=guide`, before `ui` existed
  // inside the document): read them here too, but only as a fallback when
  // the document itself doesn't already carry `ui.wire`/`ui.view` -- so a
  // link from that window still opens correctly, and the very next
  // `toHash` (App.tsx's own replaceState) folds them into `ui`, migrating
  // it forward exactly like every other legacy field already does.
  const rawWire = params.get("wire");
  if (rawWire !== null && rawWire !== "0" && rawWire !== "1") {
    return fallback('Could not read this link ("wire" must be "0" or "1") -- showing default values instead.');
  }
  const showWire = parsed.showWire !== DEFAULT_SHOW_WIRE ? parsed.showWire : rawWire !== null ? rawWire !== "0" : DEFAULT_SHOW_WIRE;
  const view: ViewMode = parsed.view === "guide" || params.get("view") === "guide" ? "guide" : DEFAULT_VIEW;

  return { ...parsed, showWire, view };
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
