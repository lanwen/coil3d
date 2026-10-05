import { expect, test, type Page } from "@playwright/test";
import { encodeHashDoc } from "./hashDoc";

// End-to-end checks for issue #254, part 2: the cable's inner end is held in the bore (docs/design.md, Cable ends): it
// hangs out of the top of the bore, runs down a rib on the bore wall, crosses the open bottom and leaves under the wall
// into the groove. Geometry, solver and bend-radius checks live in vitest against the public `design()` interface
// (test/centreEnds.test.ts, test/cableBend.test.ts); these check the actual render: the rib, its keyhole and the cable
// are visible, and the wound-cable toggle visibly changes the close-up.
//
// Close-up framing: `?debugFocusInnerEnd=1` (CoilViewer.tsx) rotates the rendered geometry about the coil axis so the
// inner end's own (data-dependent) azimuth lines up with the default "iso" preset's camera azimuth, and substitutes a
// small framing geometry (the `debugFocusRadius` mm of the inner end nearest its free end) for LineArtRenderer's fit.
const FOCUS = "?debugFocusInnerEnd=1&debugFocusRadius=22";
const ROUND = `${FOCUS}${encodeHashDoc({ L: 800, d: 4, size: 60, h: 60 })}`;
const SQUARE = `${FOCUS}${encodeHashDoc({ L: 800, d: 4, size: 60, h: 60, shape: "sq", rc: 20 })}`;

test.use({ viewport: { width: 900, height: 700 } });

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  // Wait for the FINAL-resolution mesh before settling: the draft->final
  // swap (issue #7) is CPU-time-, not wall-clock-bound, so a fixed sleep
  // alone can race it under a loaded/slow CI run (see line-art.spec.ts's
  // gotoDesign, issue #61/#62, for the full story).
  await expect(page.getByTestId("download-stl")).toBeEnabled();
}

test.describe("centre-held inner end close-up (issue #254)", () => {
  test("round core: the rib and its keyhole are visible, and toggling the wound cable changes the render", async ({ page }) => {
    await gotoDesign(page, ROUND);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");

    await expect(canvas).toHaveScreenshot("inner-end-round-rib-wire.png");
    const withWire = await canvas.screenshot();

    await page.getByTestId("toggle-wire").uncheck();
    await expect(canvas).toHaveScreenshot("inner-end-round-rib-nowire.png");
    const withoutWire = await canvas.screenshot();

    // The inner end is drawn with the cable only; an exact byte comparison (not the tolerant toHaveScreenshot diff)
    // proves the toggle actually changes THIS close-up, not just the coil as a whole.
    expect(withWire.equals(withoutWire), "the wound-cable toggle must change the inner-end close-up").toBe(false);
  });

  test("rounded-square core: the rib and its keyhole are visible, and toggling the wound cable changes the render", async ({ page }) => {
    await gotoDesign(page, SQUARE);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");

    await expect(canvas).toHaveScreenshot("inner-end-square-rib-wire.png");
    const withWire = await canvas.screenshot();

    await page.getByTestId("toggle-wire").uncheck();
    await expect(canvas).toHaveScreenshot("inner-end-square-rib-nowire.png");
    const withoutWire = await canvas.screenshot();

    expect(withWire.equals(withoutWire), "the wound-cable toggle must change the inner-end close-up").toBe(false);
  });

  test("a heavy-cord design (a big core, a long tunnel under the wall) still renders without a design error", async ({ page }) => {
    await gotoDesign(page, encodeHashDoc({ L: 2000, d: 8, wt: "stiff", size: 60, ly: 1 }));
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
    await expect(page.getByTestId("design-error")).toHaveCount(0);
  });
});
