import { expect, test, type Locator, type Page } from "@playwright/test";

// End-to-end checks for issue #50: IKEA-style overall-dimension lines (the
// assembled coil's width/diameter and height, in cm) drawn technical-drawing
// style outside the model. Solver/geometry numbers themselves are covered by
// vitest against the public `design()` interface; these check the viewer
// overlay <-> design seam: the two dimension labels exist, read the right
// shape of value (a literal "Ø" diameter for round, a plain measured width
// for sq/tri), agree with design()'s own numbers, stay put across views,
// keep clear of the overlay controls, and disappear in exploded view.
//
// Issue #63 (PR #59 review) found the numbers themselves didn't actually
// agree: the result panel's old "Flange size" was a solver envelope
// estimate, not the real built flange -- wrong for non-round shapes and
// whenever a mount grew the margin -- and its "Core height" excluded the
// bottom flange/cap entirely. The panel now has real "Flange width"
// (+ "Flange width (across corners)" for sq/tri) and "Overall height" rows,
// computed once in the core (design.ts/flange.ts) and read by both the
// panel and this dimension overlay -- several tests below were tightened
// to assert against those real numbers directly, not just loose bounds.

const ROUND_NO_CAP = "#v=1&L=1000&d=4&lock=outer,ly&size=50&h=40&ly=1&cap=off";
const ROUND_CAP = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2&cap=on";
const ROUND_CAP_OFF = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2&cap=off";
const SQUARE = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2&cap=on&shape=sq&sq.rc=15";
const TRIANGLE = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2&cap=on&shape=tri&tri.rc=15";
const PRESETS = ["front", "iso", "wallRoom"] as const;

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  // Wait for the FINAL-resolution mesh (download-stl is gated on it, see
  // e2e/line-art.spec.ts): the dimensions are measured off the part meshes,
  // so a draft mesh would give draft numbers and placement.
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await page.waitForTimeout(500);
}

async function showPreset(page: Page, preset: (typeof PRESETS)[number]) {
  await page.getByTestId(`preset-${preset}`).click();
  await page.waitForTimeout(600);
}

/** `.innerText()` requires a laid-out HTML element; the dimension labels
 * are plain SVG `<text>` nodes (no layout box of their own kind Playwright
 * expects there), so this reads `.textContent()` instead -- works for both
 * those and the ordinary HTML result-panel rows this file also reads. */
async function readText(locator: Locator): Promise<string> {
  return (await locator.textContent()) ?? "";
}

/** Parses a "<number> <unit>" value into cm, whichever unit it's shown in. */
function toCm(text: string): number {
  const match = text.match(/(-?\d+(?:\.\d+)?)\s*(mm|cm)/i);
  if (!match) throw new Error(`unrecognized dimension value: ${text}`);
  const value = Number(match[1]);
  return match[2].toLowerCase() === "mm" ? value / 10 : value;
}

async function dimensionCm(page: Page, which: "width" | "height"): Promise<number> {
  return toCm(await readText(page.getByTestId(`dimension-${which}`)));
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test.describe("overall-dimension lines (issue #50)", () => {
  test("round core: width reads as the flange diameter (Ø), the same in every view, and matches the result panel's real flange width (issue #63)", async ({ page }) => {
    await gotoDesign(page, ROUND_NO_CAP);
    await expect(page.getByTestId("dimension-width")).toHaveText(/^Ø\s*\d+\.\d cm$/);
    await expect(page.getByTestId("dimension-height")).toHaveText(/^\d+\.\d cm$/);
    const flangeCm = toCm(await readText(page.getByTestId("flange")));
    for (const preset of PRESETS) {
      await showPreset(page, preset);
      expect(await dimensionCm(page, "width"), preset).toBeCloseTo(flangeCm, 1);
    }
  });

  test("height is the overall assembled height: the core plus its bottom flange, the same in every view, and matches the result panel's own 'overall height' row (issue #63)", async ({ page }) => {
    await gotoDesign(page, ROUND_NO_CAP);
    await expect(page.getByTestId("caps")).toContainText(/^off/);
    // The result panel's "Core height" is the winding height only; the
    // bottom flange sits below it, so the overall height is taller -- by a
    // flange's thickness, a few mm.
    const coreHeightCm = toCm(await readText(page.getByTestId("height")));
    // The panel's own "Overall height" row (issue #63) is design()'s exact
    // analytic overallHeight -- the SAME number the dimension line below
    // reads off the real meshes -- so this must match far more tightly
    // than the loose "a few mm taller" band above.
    const overallHeightCm = toCm(await readText(page.getByTestId("overall-height")));
    const heights: number[] = [];
    for (const preset of PRESETS) {
      await showPreset(page, preset);
      heights.push(await dimensionCm(page, "height"));
    }
    expect(heights[0] - coreHeightCm).toBeGreaterThan(0.1);
    expect(heights[0] - coreHeightCm).toBeLessThan(1.5);
    expect(heights[0]).toBeCloseTo(overallHeightCm, 1);
    expect(heights[1]).toBe(heights[0]);
    expect(heights[2]).toBe(heights[0]);
  });

  test("a top cap adds exactly its own thickness to the overall height", async ({ page, context }) => {
    await gotoDesign(page, ROUND_CAP_OFF);
    await expect(page.getByTestId("caps")).toContainText(/^off/);
    const withoutCap = await dimensionCm(page, "height");
    const capped = await context.newPage(); // a fresh load: a hash-only goto wouldn't reparse the design
    await gotoDesign(capped, ROUND_CAP);
    await expect(capped.getByTestId("caps")).toContainText(/^on/);
    const withCap = await dimensionCm(capped, "height");
    // CAP_THICKNESS is 3mm == 0.3cm (core/constants.ts) -- a loose band
    // rather than an exact literal, so this doesn't silently need updating
    // if that constant ever changes.
    expect(withCap - withoutCap).toBeGreaterThan(0.1);
    expect(withCap - withoutCap).toBeLessThan(0.6);
  });

  for (const [label, hash] of [
    ["square", SQUARE],
    ["triangle", TRIANGLE],
  ] as const) {
    test(`${label} core: width is a plain measured value (no Ø), always between the result panel's real across-flats/across-corners flange extent (issue #63)`, async ({ page }) => {
      await gotoDesign(page, hash);
      // Issue #63: the panel now reports the flange's own two real extents
      // -- "across flats" (the `flange` row -- narrower) and "across
      // corners" (wider) -- computed from the SAME resolved outline/margin
      // the flange mesh is built from. Whichever direction the dimension
      // line happens to measure on screen, it must fall between them (a
      // convex shape's radius at any angle is bounded by its narrowest and
      // widest real extents).
      const acrossFlatsCm = toCm(await readText(page.getByTestId("flange")));
      const acrossCornersCm = toCm(await readText(page.getByTestId("flange-across-corners")));
      expect(acrossCornersCm).toBeGreaterThan(acrossFlatsCm);
      for (const preset of PRESETS) {
        await showPreset(page, preset);
        await expect(page.getByTestId("dimension-width")).toHaveText(/^\d+\.\d cm$/);
        const widthCm = await dimensionCm(page, "width");
        expect(widthCm, preset).toBeGreaterThan(acrossFlatsCm - 0.15);
        expect(widthCm, preset).toBeLessThan(acrossCornersCm + 0.15);
      }
    });
  }

  for (const [label, hash] of [
    ["round", ROUND_CAP],
    ["square", SQUARE],
    ["triangle", TRIANGLE],
  ] as const) {
    test(`${label}: both labels stay inside the viewer and clear of the overlay controls in every view`, async ({ page }) => {
      await gotoDesign(page, hash);
      for (const preset of PRESETS) {
        await showPreset(page, preset);
        const frame = (await page.getByTestId("coil-viewer").boundingBox())!;
        const controls = await Promise.all(
          [".wire-toggle", ".explode-toggle", ".view-controls", ".wall-view-caption"].map(async (selector) => (await page.locator(selector).count()) ? page.locator(selector).boundingBox() : null),
        );
        for (const which of ["width", "height"] as const) {
          const box = (await page.getByTestId(`dimension-${which}`).boundingBox())!;
          expect(box, `${preset} ${which}`).not.toBeNull();
          expect(box.x, `${preset} ${which}`).toBeGreaterThanOrEqual(frame.x);
          expect(box.y, `${preset} ${which}`).toBeGreaterThanOrEqual(frame.y);
          expect(box.x + box.width, `${preset} ${which}`).toBeLessThanOrEqual(frame.x + frame.width);
          expect(box.y + box.height, `${preset} ${which}`).toBeLessThanOrEqual(frame.y + frame.height);
          for (const control of controls) if (control) expect(overlaps(box, control), `${preset} ${which} vs a control`).toBe(false);
        }
      }
    });
  }

  test("hidden in exploded view, reappears once collapsed", async ({ page }) => {
    await gotoDesign(page, ROUND_CAP);
    await expect(page.getByTestId("dimension-overlay")).toBeVisible();

    await page.getByTestId("toggle-exploded").check();
    await page.waitForTimeout(1200);
    await expect(page.getByTestId("dimension-overlay")).toHaveCount(0);

    await page.getByTestId("toggle-exploded").uncheck();
    await page.waitForTimeout(1200);
    await expect(page.getByTestId("dimension-overlay")).toBeVisible();
  });

  test("updates when the view changes (wall-mount preset)", async ({ page }) => {
    await gotoDesign(page, ROUND_CAP);
    const before = await page.getByTestId("dimension-overlay").screenshot();

    await page.getByTestId("preset-wallRoom").click();
    await page.waitForTimeout(900);
    const after = await page.getByTestId("dimension-overlay").screenshot();
    expect(before.equals(after), "the dimension overlay must redraw for the new projected bounds").toBe(false);

    // The VALUES themselves are physical properties of the design, not of
    // the current camera -- they must stay the same across the view change.
    await expect(page.getByTestId("dimension-width")).toHaveText(/^Ø\s*\d+\.\d cm$/);
  });

  test("readable at phone width too", async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    await gotoDesign(page, ROUND_CAP);
    await expect(page.getByTestId("dimension-overlay")).toBeVisible();
    await expect(page.getByTestId("dimension-width")).toBeVisible();
    await expect(page.getByTestId("dimension-height")).toBeVisible();
  });
});
