import { expect, test, type Locator, type Page } from "@playwright/test";

// End-to-end checks for issue #8 (bottom rim keyhole and inner channel):
// docs/research.md "Wire ends" -- "keyhole in the bottom flange rim at the
// groove start, with a recessed radial channel on the flange's inner face
// so layers don't wind over a bump". Solver/geometry/manifold checks
// themselves live in test/innerEnd.test.ts against the public `design()`
// interface; these check the actual render: the feature is visible, and
// the wound-cable toggle visibly changes it (the schematic's lead-in runs
// from the keyhole through the channel, wire.ts's `buildInnerEndLeadIn`).
//
// A short, single-layer core (small `h`) keeps the bottom flange a large
// fraction of the frame, so a modest zoom toward it (mirrors
// e2e/top-cap.spec.ts's own "zoom near the pointer" technique) reaches a
// real close-up without the orbit zoom's re-centering (observed empirically:
// many more wheel notches drift the view back toward the model's vertical
// centre, away from the flange) pushing the keyhole out of frame.
const ROUND = "#v=1&L=800&d=4&size=60&h=20";
const SQUARE = "#v=1&L=800&d=4&size=60&h=20&shape=sq&sq.rc=20";

// A fixed viewport (not the project default): the zoom targets below are
// tuned pixel fractions of the canvas, found empirically for this exact
// size -- a different canvas aspect ratio points the same fractions at a
// different part of the model.
test.use({ viewport: { width: 900, height: 700 } });

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  await page.waitForTimeout(800);
}

async function zoomAt(page: Page, canvas: Locator, fx: number, fy: number, notches: number) {
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
  for (let i = 0; i < notches; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(150);
}

test.describe("bottom rim keyhole + channel close-up (issue #8)", () => {
  test("round core: the keyhole is visible, and toggling the wound cable changes the render", async ({ page }) => {
    await gotoDesign(page, ROUND);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");

    await zoomAt(page, canvas, 0.7, 0.78, 6);
    await zoomAt(page, canvas, 0.72, 0.68, 5);

    await expect(canvas).toHaveScreenshot("inner-end-round-keyhole-wire.png");
    const withWire = await canvas.screenshot();

    await page.getByTestId("toggle-wire").uncheck();
    await page.waitForTimeout(300);
    await expect(canvas).toHaveScreenshot("inner-end-round-keyhole-nowire.png");
    const withoutWire = await canvas.screenshot();

    // The lead-in (wire.ts's buildInnerEndLeadIn) draws a real, additional
    // line from the keyhole into the channel only when the cable is shown;
    // an exact byte comparison (not the tolerant toHaveScreenshot diff)
    // proves the toggle actually changes THIS close-up, not just the coil
    // as a whole.
    expect(withWire.equals(withoutWire), "the wound-cable toggle must change the keyhole close-up").toBe(false);
  });

  test("rounded-square core: the keyhole is visible, and toggling the wound cable changes the render", async ({ page }) => {
    await gotoDesign(page, SQUARE);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");

    await zoomAt(page, canvas, 0.73, 0.79, 6);
    await zoomAt(page, canvas, 0.79, 0.72, 6);

    await expect(canvas).toHaveScreenshot("inner-end-square-keyhole-wire.png");
    const withWire = await canvas.screenshot();

    await page.getByTestId("toggle-wire").uncheck();
    await page.waitForTimeout(300);
    await expect(canvas).toHaveScreenshot("inner-end-square-keyhole-nowire.png");
    const withoutWire = await canvas.screenshot();

    expect(withWire.equals(withoutWire), "the wound-cable toggle must change the keyhole close-up").toBe(false);
  });

  test("a heavy-cord design (large channel width relative to the flange) still renders and stays manifold-clean (no console errors)", async ({ page }) => {
    // A thick, stiff cord: the same class of design that once reproduced a
    // spurious extra genus in the mesh backend (a wide channel reaching
    // past the wall into the bore, see src/core/manifold.ts's
    // `outlineBlocker`) before that clip was added -- kept here as an e2e
    // guard that the app never surfaces that as a broken render/console
    // error, on top of test/innerEnd.test.ts's own vitest genus check.
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    await gotoDesign(page, "#v=1&L=2000&d=8&wt=stiff&lock=outer,ly&size=60&ly=1");
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
    expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
  });
});
