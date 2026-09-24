// Versioned URL hash codec (docs/research.md §7). Omits defaults, always
// stamps `v=1`, and falls back to defaults with a notice on garbage input.
//
// Lock encoding (issue #5): `lock` is a comma list drawn from
// {"outer", "inner", "h", "ly"} naming which of {core size, height, layers}
// are locked (e.g. `lock=h,outer`). A locked core-size dimension's value
// goes in `size`; height's in `h`; layers' in `ly`. Free dimensions carry no
// value -- the solver recomputes them. When `lock` itself is omitted, the
// default lock (outer size + layers, height free) applies, so old links
// from before this ticket (`v=1&L=..&d=..&size=..`) keep working.

import { z } from "zod";
import { MAX_WIRE_LENGTH } from "./constants";
import { DEFAULT_CUSTOM_BEND_MULTIPLIER } from "./types";
import type { CoilSpec, CoreSizeLock, Lock, WireTypeId } from "./types";

const HASH_VERSION = "1";

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
};

const DEFAULT_LOCK_TOKENS = ["outer", "ly"] as const;
const LOCK_TOKENS = ["outer", "inner", "h", "ly"] as const;
type LockToken = (typeof LOCK_TOKENS)[number];

const QuerySchema = z.object({
  v: z.string().optional(),
  L: z.coerce.number().finite().positive().max(MAX_WIRE_LENGTH).optional(),
  d: z.coerce.number().finite().min(0.5).max(20).optional(),
  wt: z.enum(["usb", "flex", "stiff", "custom"]).optional(),
  mbr: z.coerce.number().finite().positive().max(50).optional(),
  q: z.coerce.number().finite().min(0).max(1).optional(),
  obj: z.enum(["mv", "ar"]).optional(),
  lock: z.string().optional(),
  size: z.coerce.number().finite().min(1).max(1000).optional(),
  h: z.coerce.number().finite().min(1).max(1000).optional(),
  ly: z.coerce.number().int().min(1).max(100).optional(),
});

export interface ParsedHash {
  spec: CoilSpec;
  /** Set when the hash was unreadable and defaults were substituted. */
  notice?: string;
}

function fallback(notice: string): ParsedHash {
  return { spec: cloneSpec(DEFAULT_SPEC), notice };
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
  };
}

/** Parse a `location.hash`-style string (with or without the leading `#`). */
export function parseHash(hash: string): ParsedHash {
  const qs = hash.replace(/^#/, "");
  if (!qs) return { spec: cloneSpec(DEFAULT_SPEC) };

  const raw = Object.fromEntries(new URLSearchParams(qs).entries());
  if (raw.v !== undefined && raw.v !== HASH_VERSION) {
    return fallback(`Unsupported link version "${raw.v}" -- showing default values instead.`);
  }

  const result = QuerySchema.safeParse(raw);
  if (!result.success) {
    return fallback('Could not read this link ("lock" and shape parameters are validated together) -- showing default values instead.');
  }
  const p = result.data;

  const lockTokens = new Set<string>(p.lock !== undefined ? p.lock.split(",").filter(Boolean) : DEFAULT_LOCK_TOKENS);
  for (const t of lockTokens) {
    if (!(LOCK_TOKENS as readonly string[]).includes(t)) {
      return fallback(`Unknown lock "${t}" in the link -- showing default values instead.`);
    }
  }
  if (lockTokens.has("outer") && lockTokens.has("inner")) {
    return fallback("The link locks both the outer and inner size -- showing default values instead.");
  }

  const wireType: WireTypeId = p.wt ?? DEFAULT_SPEC.wire.type;
  if (wireType !== "custom" && p.mbr !== undefined) {
    return fallback('The link sets a custom bend multiplier ("mbr") without wt=custom -- showing default values instead.');
  }

  const coreSize: CoreSizeLock = lockTokens.has("outer")
    ? { locked: true, dimension: "outer", value: p.size ?? DEFAULT_OUTER_SIZE }
    : lockTokens.has("inner")
      ? { locked: true, dimension: "inner", value: p.size ?? DEFAULT_OUTER_SIZE }
      : { locked: false };
  const height: Lock<number> = lockTokens.has("h") ? { locked: true, value: p.h ?? DEFAULT_HEIGHT } : { locked: false };
  const layers: Lock<number> = lockTokens.has("ly") ? { locked: true, value: p.ly ?? DEFAULT_LAYERS } : { locked: false };

  const spec: CoilSpec = {
    wire: {
      length: p.L ?? DEFAULT_SPEC.wire.length,
      diameter: p.d ?? DEFAULT_SPEC.wire.diameter,
      type: wireType,
      customBendMultiplier: wireType === "custom" ? (p.mbr ?? DEFAULT_CUSTOM_BEND_MULTIPLIER) : undefined,
    },
    shape: { kind: "round" },
    windingQuality: p.q ?? DEFAULT_SPEC.windingQuality,
    coreSize,
    height,
    layers,
    objective: p.obj === "ar" ? "aspectRatio" : "minVolume",
  };
  return { spec };
}

/** Encode a spec into a hash string (with leading `#`), omitting defaults. */
export function toHash(spec: CoilSpec): string {
  const params = new URLSearchParams();
  params.set("v", HASH_VERSION);

  if (spec.wire.length !== DEFAULT_SPEC.wire.length) params.set("L", String(spec.wire.length));
  if (spec.wire.diameter !== DEFAULT_SPEC.wire.diameter) params.set("d", String(spec.wire.diameter));
  if (spec.wire.type !== DEFAULT_SPEC.wire.type) params.set("wt", spec.wire.type);
  if (spec.wire.type === "custom" && (spec.wire.customBendMultiplier ?? DEFAULT_CUSTOM_BEND_MULTIPLIER) !== DEFAULT_CUSTOM_BEND_MULTIPLIER) {
    params.set("mbr", String(spec.wire.customBendMultiplier));
  }
  if (spec.windingQuality !== DEFAULT_SPEC.windingQuality) params.set("q", String(spec.windingQuality));
  if (spec.objective !== DEFAULT_SPEC.objective) params.set("obj", spec.objective === "minVolume" ? "mv" : "ar");

  const lockTokens: LockToken[] = [];
  if (spec.coreSize.locked) {
    lockTokens.push(spec.coreSize.dimension);
    if (spec.coreSize.value !== DEFAULT_OUTER_SIZE) params.set("size", String(spec.coreSize.value));
  }
  if (spec.height.locked) {
    lockTokens.push("h");
    if (spec.height.value !== DEFAULT_HEIGHT) params.set("h", String(spec.height.value));
  }
  if (spec.layers.locked) {
    lockTokens.push("ly");
    if (spec.layers.value !== DEFAULT_LAYERS) params.set("ly", String(spec.layers.value));
  }
  if (lockTokens.join(",") !== DEFAULT_LOCK_TOKENS.join(",")) params.set("lock", lockTokens.join(","));

  return `#${params.toString()}`;
}
