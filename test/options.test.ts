import { describe, expect, it } from "vitest";
import { DEFAULT_SPEC, design, parseHash, toHash } from "../src/core";
import type { CoilSpec, Solution } from "../src/core";

// Issue #192: the result panel shows each solver alternative as a card and
// renders it when picked, by changing existing spec fields only. These pin
// the contract that makes a card honest: the alternative's numbers are
// exactly what `design()` builds for the picked spec, after a trip through
// the link (`toHash`/`parseHash`).

function spec(overrides: Partial<CoilSpec>): CoilSpec {
  return { ...DEFAULT_SPEC, base: "on", ...overrides };
}

/** Through the URL hash and back, as a shared link would. */
function viaLink(s: CoilSpec): CoilSpec {
  return parseHash(toHash(s, true, "design")).spec;
}

function expectSameBuild(built: Solution, card: Solution) {
  expect(built.outerSize).toBeCloseTo(card.outerSize, 9);
  expect(built.height).toBeCloseTo(card.height, 9);
  expect(built.layers).toBe(card.layers);
  expect(built.topCapEnabled).toBe(card.topCapEnabled);
  expect(card.flangeExtent).toBeDefined();
  expect(card.overallHeight).toBeDefined();
  expect(built.flangeExtent!.acrossFlats).toBeCloseTo(card.flangeExtent!.acrossFlats, 9);
  expect(built.flangeExtent!.acrossCorners).toBeCloseTo(card.flangeExtent!.acrossCorners, 9);
  expect(built.overallHeight!).toBeCloseTo(card.overallHeight!, 9);
}

const TWO_FREE = spec({ height: { locked: false }, layers: { locked: false } });
const THREE_FREE = spec({ coreSize: { locked: false }, height: { locked: false }, layers: { locked: false } });

describe("solver alternatives can be picked through the spec (issue #192)", () => {
  for (const mount of ["none", "keyhole"] as const) {
    it(`two free dimensions (${mount} mount): flipping the objective builds the alternative, and the old pick becomes the alternative`, async () => {
      const before = await design({ ...TWO_FREE, mount });
      expect(before.solution.alternates).toHaveLength(1);
      const alt = before.solution.alternates[0];
      expect(alt.objectiveUsed).toBe("aspectRatio");

      const picked = viaLink({ ...TWO_FREE, mount, objective: alt.objectiveUsed! });
      expect(picked.objective).toBe("aspectRatio");
      const after = await design(picked);
      expectSameBuild(after.solution, alt);
      expect(after.solution.alternates).toHaveLength(1);
      expectSameBuild(before.solution, after.solution.alternates[0]);
    });

    it(`three free dimensions (${mount} mount): locking an alternative's layers and height builds it exactly`, async () => {
      const before = await design({ ...THREE_FREE, mount });
      expect(before.solution.alternates.length).toBeGreaterThanOrEqual(2);
      for (const alt of before.solution.alternates) {
        const picked = viaLink({ ...THREE_FREE, mount, layers: { locked: true, value: alt.layers }, height: { locked: true, value: alt.height } });
        expect(picked.coreSize.locked).toBe(false);
        const after = await design(picked);
        expectSameBuild(after.solution, alt);
      }
    });
  }
});

describe("design() notices (issue #192)", () => {
  it("tags every message as a problem or a note, and `warnings` lists the same messages in order", async () => {
    const d = await design(spec({ print: { bedX: 256, bedY: 256, bedZ: 20 }, label: "a label far too long for this small top cap" , layers: { locked: true, value: 2 } }));
    expect(d.notices.length).toBeGreaterThan(0);
    expect(d.warnings).toEqual(d.notices.map((n) => n.message));
    for (const n of d.notices) expect(["problem", "note"]).toContain(n.severity);
    // Too tall for the bed and the label hidden: both need the user's attention.
    expect(d.notices.filter((n) => n.severity === "problem").map((n) => n.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/tall; your printer fits 2 cm/), expect.stringMatching(/doesn't fit on the top cap/)]),
    );
    // An automatic flange adjustment is only a note.
    expect(d.notices.some((n) => n.severity === "note" && /^Flange margin increased/.test(n.message))).toBe(true);
    expect(d.fitsBed).toBe(false);
  });

  it("the default design has no problems and fits the default bed", async () => {
    const d = await design(DEFAULT_SPEC);
    expect(d.notices.filter((n) => n.severity === "problem")).toEqual([]);
    expect(d.fitsBed).toBe(true);
  });
});
