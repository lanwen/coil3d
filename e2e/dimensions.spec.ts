import { expect, test, type Page } from "@playwright/test";

// End-to-end checks for issue #50: IKEA-style overall-dimension lines (the
// assembled coil's width/diameter and height, in cm) drawn next to the
// model, attached to its own projected bounds. Solver/geometry numbers
// themselves are covered by vitest against the public `design()` interface;
// these check the viewer overlay <-> design seam: the two dimension labels
// exist, read the right shape of value (a literal "Ø" diameter for round,
// a plain value for sq/tri), track the SAME numbers the result panel shows,
// and disappear in exploded view.

const ROUND_NO_CAP = "#v=1&L=1000&d=4&lock=outer,ly&size=50&h=40&ly=1&cap=off";
const ROUND_CAP = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2&cap=on";
const SQUARE = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2&cap=on&shape=sq&sq.rc=15";
const TRIANGLE = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2&cap=on&shape=tri&tri.rc=15";

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  await page.waitForTimeout(1000);
}

/** `.innerText()` requires a laid-out HTML element; the dimension labels
 * are plain SVG `<text>` nodes (no layout box of their own kind Playwright
 * expects there), so this reads `.textContent()` instead -- works for both
 * those and the ordinary HTML result-panel rows this file also reads. */
async function readText(locator: ReturnType<Page["getByTestId"]>): Promise<string> {
  return (await locator.textContent()) ?? "";
}

/** Parses a "<number> <unit>" result-panel value into cm, regardless of
 * which unit it's actually shown in (mm today; tolerant of a future switch
 * to cm elsewhere in the app -- this file only needs to agree with
 * whatever `design()` itself reports, not hardcode a specific display
 * unit). */
function toCm(text: string): number {
  const match = text.match(/(-?\d+(?:\.\d+)?)\s*(mm|cm)/i);
  if (!match) throw new Error(`unrecognized dimension value: ${text}`);
  const value = Number(match[1]);
  return match[2].toLowerCase() === "mm" ? value / 10 : value;
}

test.describe("overall-dimension lines (issue #50)", () => {
  test("round core: width reads as a diameter (Ø), height matches the result panel", async ({ page }) => {
    await gotoDesign(page, ROUND_NO_CAP);
    await expect(page.getByTestId("dimension-width")).toHaveText(/^Ø\s*\d+\.\d cm$/);
    await expect(page.getByTestId("dimension-height")).toHaveText(/^\d+\.\d cm$/);

    const flangeCm = toCm(await readText(page.getByTestId("flange")));
    const widthText = await readText(page.getByTestId("dimension-width"));
    expect(Number(widthText.replace(/[^\d.]/g, ""))).toBeCloseTo(flangeCm, 1);

    // No cap (cap=off): overall height equals the core's own height.
    const coreHeightCm = toCm(await readText(page.getByTestId("height")));
    const heightCm = Number((await readText(page.getByTestId("dimension-height"))).replace(/[^\d.]/g, ""));
    await expect(page.getByTestId("caps")).toContainText(/^off/);
    expect(heightCm).toBeCloseTo(coreHeightCm, 1);
  });

  test("round core with a cap: overall height exceeds the bare core height by the cap's own thickness", async ({ page }) => {
    await gotoDesign(page, ROUND_CAP);
    await expect(page.getByTestId("caps")).toContainText(/^on/);
    const coreHeightCm = toCm(await readText(page.getByTestId("height")));
    const heightCm = Number((await readText(page.getByTestId("dimension-height"))).replace(/[^\d.]/g, ""));
    expect(heightCm).toBeGreaterThan(coreHeightCm);
    // CAP_THICKNESS is 3mm == 0.3cm (core/constants.ts) -- a loose band
    // rather than an exact literal, so this doesn't silently need updating
    // if that constant ever changes.
    expect(heightCm - coreHeightCm).toBeGreaterThan(0.1);
    expect(heightCm - coreHeightCm).toBeLessThan(0.6);
  });

  test("square core: width is a plain value (no Ø), still matches the flange size", async ({ page }) => {
    await gotoDesign(page, SQUARE);
    await expect(page.getByTestId("dimension-width")).toHaveText(/^\d+\.\d cm$/);
    const flangeCm = toCm(await readText(page.getByTestId("flange")));
    const widthCm = Number((await readText(page.getByTestId("dimension-width"))).replace(/[^\d.]/g, ""));
    expect(widthCm).toBeCloseTo(flangeCm, 1);
  });

  test("triangle core: width is a plain value (no Ø), still matches the flange size", async ({ page }) => {
    await gotoDesign(page, TRIANGLE);
    await expect(page.getByTestId("dimension-width")).toHaveText(/^\d+\.\d cm$/);
    const flangeCm = toCm(await readText(page.getByTestId("flange")));
    const widthCm = Number((await readText(page.getByTestId("dimension-width"))).replace(/[^\d.]/g, ""));
    expect(widthCm).toBeCloseTo(flangeCm, 1);
  });

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
