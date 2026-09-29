import { expect, test, type Page } from "@playwright/test";

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
//
// A numeric "sanity net" alongside these screenshots used to read the
// `dimension-*` result-panel labels at Front/Iso, but those values come from
// `measureDimensionFrame(parts, viewMode === "standing" ? ... : undefined)`
// (CoilViewer.tsx), which depends only on `viewMode` -- Front and Iso are
// both "standing" -- and never on the actual camera preset. So that check
// couldn't fail on a #79 regression (a camera facing the wrong direction
// still reports the same "standing" dimensions); the name "Iso sits 45
// degrees off" promised a camera-angle check it never made. The real,
// camera-aware #79 guard is the screenshot baselines below: they capture the
// actual rendered silhouette under the live Front/Iso camera, which is
// exactly what regresses if a corner faces the camera again.

const SQUARE = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2&cap=on&shape=sq&sq.rc=15";
const TRIANGLE = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2&cap=on&shape=tri&tri.rc=15";

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

test.describe("Front view faces a flat, not a corner (issue #79)", () => {
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
