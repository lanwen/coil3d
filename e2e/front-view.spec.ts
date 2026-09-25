import { expect, test, type Locator, type Page } from "@playwright/test";

// End-to-end checks for issue #79: the "Front" preset must face a FLAT side
// for square/triangle cores, not a corner. Before this fix, shapes.ts's own
// construction (corner 0 on local +X) put a CORNER toward the fixed "Front"
// camera direction for both shapes -- seen corner-on, the model's own
// diamond-oriented footprint no longer lined up with DimensionAxes.tsx's
// flush-to-flats measurement box, so Front read TWO ground spans at once
// (PR #75's own sq-front.png screenshot), one of them wider than the
// model's own on-screen silhouette, instead of the single across-flats
// width a classic front elevation shows. Solver/geometry numbers themselves
// are unaffected (vitest coverage is unchanged) -- this is purely a viewer
// presentation fix (frontFacing.ts), so these checks live at the viewer
// seam, alongside dimensions.spec.ts's own preset/axis coverage.

const SQUARE = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2&cap=on&shape=sq&sq.rc=15";
const TRIANGLE = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2&cap=on&shape=tri&tri.rc=15";
const ROUND = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2&cap=on";

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await page.waitForTimeout(500);
}

async function showPreset(page: Page, preset: "front" | "iso" | "wallRoom") {
  await page.getByTestId(`preset-${preset}`).click();
  await page.waitForTimeout(600);
}

async function readText(locator: Locator): Promise<string> {
  return (await locator.textContent()) ?? "";
}

function toCm(text: string): number {
  const match = text.match(/(-?\d+(?:\.\d+)?)\s*(mm|cm)/i);
  if (!match) throw new Error(`unrecognized dimension value: ${text}`);
  const value = Number(match[1]);
  return match[2].toLowerCase() === "mm" ? value / 10 : value;
}

async function dimensionCm(page: Page, which: "width" | "depth" | "height"): Promise<number> {
  return toCm(await readText(page.getByTestId(`dimension-${which}`)));
}

test.describe("Front view faces a flat, not a corner (issue #79)", () => {
  for (const [label, hash] of [
    ["square", SQUARE],
    ["triangle", TRIANGLE],
  ] as const) {
    test(`${label} core: Front reads a single, bounded width (not a corner-driven mismatch)`, async ({ page }) => {
      await gotoDesign(page, hash);
      const acrossFlatsCm = toCm(await readText(page.getByTestId("flange")));
      const acrossCornersCm = toCm(await readText(page.getByTestId("flange-across-corners")));

      await showPreset(page, "front");
      const width = await dimensionCm(page, "width");
      // A square's front elevation IS exactly its across-flats width (two
      // true opposite flats, one facing the camera, one facing away) --
      // the tight tolerance dimensions.spec.ts already holds it to. A
      // triangle has no opposite flat to match squarely against: facing ONE
      // flat at the camera, its own silhouette width is widened by the TWO
      // flanking rounded corners bulging past that flat's own straight
      // edge, so its honest front-elevation width reads wider than the
      // plain "2x inradius" acrossFlats number -- still real geometry, still
      // between across-flats and across-corners (this file's own
      // `front-view-triangle-front.png` baseline is what actually proves the
      // single-flat presentation; this check is the numeric sanity net
      // alongside it).
      if (label === "square") {
        expect(width).toBeCloseTo(acrossFlatsCm, 1);
      } else {
        expect(width).toBeGreaterThan(acrossFlatsCm - 0.15);
        expect(width).toBeLessThan(acrossCornersCm + 0.15);
      }
    });

    test(`${label} core: Iso sits 45 degrees off that same flat (width and depth both read between across-flats and across-corners)`, async ({ page }) => {
      await gotoDesign(page, hash);
      const acrossFlatsCm = toCm(await readText(page.getByTestId("flange")));
      const acrossCornersCm = toCm(await readText(page.getByTestId("flange-across-corners")));

      await showPreset(page, "iso");
      for (const which of ["width", "depth"] as const) {
        const cm = await dimensionCm(page, which);
        expect(cm, which).toBeGreaterThan(acrossFlatsCm - 0.15);
        expect(cm, which).toBeLessThan(acrossCornersCm + 0.15);
      }
    });
  }

  test("round core: Front is unaffected (still reads the true diameter both ways)", async ({ page }) => {
    await gotoDesign(page, ROUND);
    const flangeCm = toCm(await readText(page.getByTestId("flange")));
    await showPreset(page, "front");
    expect(await dimensionCm(page, "width")).toBeCloseTo(flangeCm, 1);
    expect(await dimensionCm(page, "depth")).toBeCloseTo(flangeCm, 1);
  });

  // Checked-in baselines (issue #78/#79 "look at them critically"): the
  // exact regression PR #75's own review screenshot showed -- a byte-level
  // guard against Front silently drifting back to a corner-on presentation.
  for (const [label, hash] of [
    ["square", SQUARE],
    ["triangle", TRIANGLE],
  ] as const) {
    test(`${label} core: Front/Iso screenshots`, async ({ page }) => {
      await gotoDesign(page, hash);
      const canvas = page.getByTestId("coil-viewer").locator("canvas");
      await showPreset(page, "front");
      await expect(canvas).toHaveScreenshot(`front-view-${label}-front.png`);
      await showPreset(page, "iso");
      await expect(canvas).toHaveScreenshot(`front-view-${label}-iso.png`);
    });
  }
});
