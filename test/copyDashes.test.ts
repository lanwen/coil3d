import { describe, expect, it } from "vitest";
import { DEFAULT_SPEC, design, parseHash } from "../src/core";
import type { CoilSpec, MountKind, ShapeSpec } from "../src/core";

const DASH = "--";

function spec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return { ...DEFAULT_SPEC, ...overrides };
}

const doc = (value: unknown) => `#s=${Buffer.from(JSON.stringify(value)).toString("base64url")}`;

const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 8.3 }, { kind: "tri", cornerRadius: 7.7 }];
const MOUNTS: MountKind[] = ["none", "keyhole", "through", "skadis", "opengrid"];

function sweep(): Array<{ name: string; spec: CoilSpec }> {
  const cases: Array<{ name: string; spec: CoilSpec }> = [{ name: "default", spec: spec() }];
  for (const shape of SHAPES) {
    for (const size of [30, 55.5, 90]) {
      for (const topCap of ["on", "off"] as const) {
        cases.push({
          name: `${shape.kind} core=${size} cap=${topCap}`,
          spec: spec({ shape, topCap, base: "on", coreSize: { locked: true, dimension: "outer", value: size } }),
        });
      }
    }
  }
  for (const mount of MOUNTS) {
    cases.push({ name: `mount=${mount}`, spec: spec({ mount, base: "on" }) });
    cases.push({ name: `mount=${mount} sq tight core`, spec: spec({ mount, base: "on", shape: SHAPES[1], coreSize: { locked: true, dimension: "outer", value: 20 } }) });
  }
  cases.push({ name: "strap slots", spec: spec({ strapSlots: true, base: "on", topCap: "on" }) });
  cases.push({ name: "thin flange", spec: spec({ wire: { length: 1000, diameter: 2.4, type: "usb" }, shape: SHAPES[2], mount: "keyhole", base: "on", topCap: "on", height: { locked: true, value: 33 } }) });
  cases.push({
    name: "loose winding shortfall",
    spec: spec({ wire: { length: 3000, diameter: 4, type: "usb" }, coreSize: { locked: true, dimension: "outer", value: 60 }, height: { locked: false }, layers: { locked: false } }),
  });
  cases.push({
    name: "over-constrained",
    spec: spec({ wire: { length: 5000, diameter: 3.8, type: "usb" }, coreSize: { locked: true, dimension: "outer", value: 64 }, height: { locked: true, value: 40 }, layers: { locked: true, value: 1 } }),
  });
  cases.push({
    name: "locked tiny size",
    spec: spec({ wire: { length: 2000, diameter: 3.8, type: "usb" }, shape: SHAPES[2], coreSize: { locked: true, dimension: "outer", value: 20 }, height: { locked: true, value: 40 }, layers: { locked: true, value: 1 } }),
  });
  cases.push({
    name: "huge footprint",
    spec: spec({ wire: { length: 15000, diameter: 8, type: "usb" }, coreSize: { locked: true, dimension: "outer", value: 480 }, layers: { locked: true, value: 3 }, height: { locked: false } }),
  });
  return cases;
}

const MALFORMED_LINKS: Array<[string, string]> = [
  ["not base64url", "#s=not-valid-base64!!!"],
  ["not JSON", `#s=${Buffer.from("this is not json").toString("base64url")}`],
  ["unsupported version", doc({ v: 99, L: 5000 })],
  ["cable length out of range", doc({ v: 2, L: 999999 })],
  ["unknown key", doc({ v: 2, bogusKey: 1 })],
  ["unknown ui key", doc({ v: 2, ui: { bogus: true } })],
  ["unknown lock token", doc({ v: 2, lock: ["bogus"] })],
  ["outer and inner both locked", doc({ v: 2, lock: ["outer", "inner"], size: 40 })],
  ["all three locked", doc({ v: 2, lock: ["outer", "h", "ly"], size: 60, h: 60, ly: 2 })],
  ["custom bend multiplier without wt=custom", doc({ v: 2, mbr: 3 })],
  ["corner radius without a shape that uses one", doc({ v: 2, rc: 20 })],
  ["keyhole rotation without mount=keyhole", doc({ v: 2, kr: 45 })],
  ["through-hole diameter without mount=through", doc({ v: 2, thd: 6 })],
  ["latch without mount=skadis", doc({ v: 2, latch: false })],
  ["strap slots off", doc({ v: 2, strap: false })],
  ["unknown base value", doc({ v: 2, base: "maybe" })],
  ["tolerance out of range", doc({ v: 2, tol: 5 })],
  ["unknown cap value", doc({ v: 2, cap: "maybe" })],
  ["garbage ui.wire", doc({ v: 2, ui: { wire: true } })],
  ["garbage ui.view", doc({ v: 2, ui: { view: "bogus" } })],
];

describe("shown text uses no double-hyphen dash (issue #318)", () => {
  const cases = sweep();

  it.each(cases)("design() notices and the solver message: $name", async ({ spec: s }) => {
    const d = await design(s, "draft");
    for (const n of d.notices) expect(n.message, n.message).not.toContain(DASH);
    for (const w of d.warnings) expect(w, w).not.toContain(DASH);
    expect(d.solution.diagnosis.message).not.toContain(DASH);
  });

  it("the sweep reaches the solver's own notes, so the check above is not vacuous", async () => {
    const messages = (await Promise.all(cases.map(async ({ spec: s }) => (await design(s, "draft")).notices.map((n) => n.message)))).flat();
    for (const fragment of [/loose winding may not fit/, /Envelope footprint/]) {
      expect(messages.some((m) => fragment.test(m)), String(fragment)).toBe(true);
    }
    const diagnoses = await Promise.all(cases.map(async ({ spec: s }) => (await design(s, "draft")).solution.diagnosis));
    expect(diagnoses.some((g) => g.status === "over-constrained")).toBe(true);
  });

  it.each(MALFORMED_LINKS)("parseHash on a malformed link: %s", (_name, hash) => {
    const { notice } = parseHash(hash);
    expect(notice).toBeDefined();
    expect(notice).not.toContain(DASH);
  });
});
