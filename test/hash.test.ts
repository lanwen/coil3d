import { describe, expect, it } from "vitest";
import { DEFAULT_SPEC, parseHash, toHash } from "../src/core";
import type { CoilSpec } from "../src/core";

describe("parseHash / toHash", () => {
  it("parses an empty hash as the defaults, with no notice", () => {
    expect(parseHash("")).toEqual({ spec: DEFAULT_SPEC });
    expect(parseHash("#")).toEqual({ spec: DEFAULT_SPEC });
  });

  it("round-trips a non-default spec", () => {
    const spec: CoilSpec = { wireLength: 5000, wireDiameter: 8, coreSize: 60 };
    const hash = toHash(spec);
    expect(parseHash(hash)).toEqual({ spec });
  });

  it("always stamps the version, and omits fields equal to the default", () => {
    const hash = toHash(DEFAULT_SPEC);
    expect(hash).toBe("#v=1");
  });

  it("accepts a hash that only overrides one field", () => {
    const hash = "#v=1&d=6";
    expect(parseHash(hash)).toEqual({
      spec: { ...DEFAULT_SPEC, wireDiameter: 6 },
    });
  });

  it("falls back to defaults with a notice on an unsupported version", () => {
    const { spec, notice } = parseHash("#v=99&L=5000");
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toMatch(/version/i);
  });

  it("falls back to defaults with a notice on a garbage value", () => {
    const { spec, notice } = parseHash("#v=1&L=not-a-number");
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("falls back to defaults with a notice on an out-of-range value", () => {
    const { spec, notice } = parseHash("#v=1&L=999999");
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });
});
