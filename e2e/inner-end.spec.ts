import { expect, test, type Page } from "@playwright/test";
import { encodeHashDoc } from "./hashDoc";

// End-to-end checks for issue #8 (bottom rim keyhole and inner channel):
// docs/design.md, Cable ends: a recessed channel on the flange's inner face
// so layers don't wind over a bump, ending in a clip at the rim. Solver/geometry/manifold checks
// themselves live in test/innerEnd.test.ts against the public `design()`
// interface; these check the actual render: the feature is visible, and
// the wound-cable toggle visibly changes it (the schematic's lead-in runs
// from the keyhole through the channel, innerEnd.ts's `leadIn`).
//
// Close-up framing: `?debugFocusInnerEnd=1` (CoilViewer.tsx, mirroring the
// existing `?debugAxis=1` screenshot-only debug convention) rotates the
// rendered geometry about the coil axis so the keyhole's own (data-
// dependent) azimuth lines up with the default "iso" preset's camera
// azimuth, and substitutes a SMALL framing geometry (just
// `innerEndLeadIn`'s own extent, keyhole to groove start) for
// LineArtRenderer's fit -- so the existing iso camera, unchanged, ends up
// looking down at the keyhole/channel from iso's own ~32 degree elevation,
// zoomed in tight, with the actual rendered scene (core + wire) unaffected.
// A plain mouse-wheel zoom was tried first and rejected: LineArtRenderer
// re-locks the orbit target to the WHOLE model's own centre every frame
// (its "self-healing" reframe, see that file's own useFrame comment), so
// no amount of scrolling/panning keeps an off-centre feature like the
// bottom flange in frame once zoomed in far enough.
const ROUND = `?debugFocusInnerEnd=1${encodeHashDoc({ L: 800, d: 4, size: 60, h: 20 })}`;
const SQUARE = `?debugFocusInnerEnd=1${encodeHashDoc({ L: 800, d: 4, size: 60, h: 20, shape: "sq", rc: 20 })}`;

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

test.describe("bottom rim keyhole + channel close-up (issue #8)", () => {
  test("round core: the keyhole is centred and visible, and toggling the wound cable changes the render", async ({ page }) => {
    await gotoDesign(page, ROUND);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");

    await expect(canvas).toHaveScreenshot("inner-end-round-keyhole-wire.png");
    const withWire = await canvas.screenshot();

    await page.getByTestId("toggle-wire").uncheck();
    await expect(canvas).toHaveScreenshot("inner-end-round-keyhole-nowire.png");
    const withoutWire = await canvas.screenshot();

    // The lead-in (innerEnd.ts's leadIn) draws a real, additional
    // line from the keyhole into the channel only when the cable is shown;
    // an exact byte comparison (not the tolerant toHaveScreenshot diff)
    // proves the toggle actually changes THIS close-up, not just the coil
    // as a whole.
    expect(withWire.equals(withoutWire), "the wound-cable toggle must change the keyhole close-up").toBe(false);
  });

  test("rounded-square core: the keyhole is centred and visible, and toggling the wound cable changes the render", async ({ page }) => {
    await gotoDesign(page, SQUARE);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");

    await expect(canvas).toHaveScreenshot("inner-end-square-keyhole-wire.png");
    const withWire = await canvas.screenshot();

    await page.getByTestId("toggle-wire").uncheck();
    await expect(canvas).toHaveScreenshot("inner-end-square-keyhole-nowire.png");
    const withoutWire = await canvas.screenshot();

    expect(withWire.equals(withoutWire), "the wound-cable toggle must change the keyhole close-up").toBe(false);
  });

  test("a heavy-cord design (large channel width relative to the flange) still renders and stays manifold-clean (no design error)", async ({ page }) => {
    // A thick, stiff cord: the same class of design that once reproduced a
    // spurious extra genus in the mesh backend (a wide channel reaching
    // past the wall into the bore, see src/core/manifold.ts's
    // `outlineBlocker`) before that clip was added -- kept here as an e2e
    // guard that the app never surfaces that as a broken render, on top of
    // test/innerEnd.test.ts's own vitest genus check.
    //
    // This used to listen for `console.error` instead, but `src` has no
    // `console.error` call at all -- a thrown `design()` failure is caught
    // by `useDesignPreview` and rendered as App.tsx's own `data-testid=
    // design-error` banner, so that check passed for an unrelated reason
    // (a negative control with no teeth). Asserting the banner itself is
    // absent is the real, failing-for-the-right-reason check.
    await gotoDesign(page, encodeHashDoc({ L: 2000, d: 8, wt: "stiff", size: 60, ly: 1 }));
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
    await expect(page.getByTestId("design-error")).toHaveCount(0);
  });
});
