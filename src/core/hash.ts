// Versioned URL hash codec (docs/research.md §7). Omits defaults, always
// stamps `v=1`, and falls back to defaults with a notice on garbage input.

import type { CoilSpec } from "./types";

export const DEFAULT_SPEC: CoilSpec = {
  wireLength: 2000,
  wireDiameter: 3.8,
  coreSize: 30,
};

const HASH_VERSION = "1";

interface FieldRange {
  key: keyof CoilSpec;
  param: string;
  min: number;
  max: number;
}

const FIELDS: FieldRange[] = [
  { key: "wireLength", param: "L", min: 1, max: 15000 },
  { key: "wireDiameter", param: "d", min: 0.5, max: 20 },
  { key: "coreSize", param: "size", min: 5, max: 500 },
];

export interface ParsedHash {
  spec: CoilSpec;
  /** Set when the hash was unreadable and defaults were substituted. */
  notice?: string;
}

/** Parse a `location.hash`-style string (with or without the leading `#`). */
export function parseHash(hash: string): ParsedHash {
  const qs = hash.replace(/^#/, "");
  if (!qs) return { spec: { ...DEFAULT_SPEC } };

  const params = new URLSearchParams(qs);
  const v = params.get("v");
  if (v !== null && v !== HASH_VERSION) {
    return {
      spec: { ...DEFAULT_SPEC },
      notice: `Unsupported link version "${v}" — showing default values instead.`,
    };
  }

  const spec = { ...DEFAULT_SPEC };
  for (const field of FIELDS) {
    const raw = params.get(field.param);
    if (raw === null) continue; // omitted -> keep the default, silently
    const value = Number(raw);
    if (!Number.isFinite(value) || value < field.min || value > field.max) {
      return {
        spec: { ...DEFAULT_SPEC },
        notice: `Could not read "${field.param}" from the link — showing default values instead.`,
      };
    }
    spec[field.key] = value;
  }
  return { spec };
}

/** Encode a spec into a hash string (with leading `#`), omitting defaults. */
export function toHash(spec: CoilSpec): string {
  const params = new URLSearchParams();
  params.set("v", HASH_VERSION);
  for (const field of FIELDS) {
    const value = spec[field.key];
    if (value !== DEFAULT_SPEC[field.key]) {
      params.set(field.param, String(value));
    }
  }
  return `#${params.toString()}`;
}
