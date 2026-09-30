import { expect, test, type Page } from "@playwright/test";
import { decodeHashDoc } from "./hashDoc";

// End-to-end checks for issue #17 (the printable, IKEA-style assembly
// guide). The guide is generated from the current design via `&view=guide`
// in the URL hash -- a legacy-format trailing param that still works on
// load, but once the app rewrites the URL (issue #56) the view lives nested
// under the document's own `ui.view`, see `./hashDoc.ts` -- so these check
// that seam -- hash -> UI -> step content/screenshots -- not the solver
// itself (see test/design.test.ts for that). Every step's illustration
// reuses the same line-art pipeline as the interactive viewer
// (src/viewer/CoilScene.tsx, src/viewer/GuideFigure.tsx).

const ONE_LAYER = "#v=1&L=1000&d=4&size=40"; // layers=1 (default): no top cap, so the two cap steps are skipped
const TWO_LAYER_CAP = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2"; // layers=2: top cap auto-on

// The guide's own screenshots render several distinct WebGL figures at
// once (one per step), so they're the heaviest screenshots in the whole
// suite -- real GitHub-hosted runners (2 shared vCPUs, no GPU) need much
// more than this repo's usual per-assertion default for these specifically
// (see playwright.config.ts and issue #18's PR for the general CI-speed
// finding); test.slow() below covers the surrounding test's own timeout,
// not this per-assertion one.
const GUIDE_SCREENSHOT_TIMEOUT = process.env.CI ? 120_000 : 25_000;

async function gotoGuide(page: Page, hash: string) {
  await page.goto(`/${hash}&view=guide`);
  await expect(page.getByTestId("guide-view")).toBeVisible();
  // Wait for the FINAL-resolution design, not just the fast draft the guide
  // may still be showing right after load: the draft->final swap (issue #7)
  // is CPU-time-, not wall-clock-bound, so a fixed sleep alone can race it
  // under a loaded/slow CI run (see line-art.spec.ts's gotoDesign, issue
  // #61/#62, for the full story; Guide.tsx exposes the same signal here as
  // `data-resolution` since the design view's own `download-stl` isn't in
  // the DOM while viewing the guide).
  await expect(page.getByTestId("guide-view")).toHaveAttribute("data-resolution", "final", { timeout: GUIDE_SCREENSHOT_TIMEOUT });
}

test.describe("printable assembly guide (issue #17)", () => {
  // Also covers: a shared link with &view=guide opens the guide directly,
  // generated from that design (gotoGuide's own goto IS that direct
  // `&view=guide` load -- a separate test asserting only guide-step-1's text
  // duplicated this one's first assertion with no distinct risk); the
  // unwind-by-rotating tip; and the generic (no mount selected) wall-mount
  // step wording. All three used to be their own tests, but each loaded this
  // identical ONE_LAYER design and only read text already covered here, so
  // they're folded in rather than paying for three more page loads.
  test("a 1-layer design (no top cap) skips the two cap steps: print, thread, wind, mount, unwind", async ({ page }) => {
    await gotoGuide(page, ONE_LAYER);
    await expect(page.getByTestId("guide-step-1")).toContainText("Print the parts");
    await expect(page.getByTestId("guide-step-2")).toContainText("Clip in the inner cable end");
    await expect(page.getByTestId("guide-step-3")).toContainText("Wind the cable");
    await expect(page.getByTestId("guide-step-4")).toContainText("Mount on the wall");
    await expect(page.getByTestId("guide-step-4")).toContainText("mounts are coming soon");
    await expect(page.getByTestId("guide-step-5")).toContainText("Unwinding");
    await expect(page.getByTestId("guide-step-5")).toContainText(/rotate the coil/i);
    await expect(page.getByTestId("guide-step-5")).toContainText(/don't pull the cable/i);
    await expect(page.getByTestId("guide-step-6")).toHaveCount(0);

    // One part (no cap) -> exactly one print-orientation figure.
    await expect(page.getByTestId("guide-print-part-core")).toBeVisible();
    await expect(page.getByTestId("guide-print-part-top-cap")).toHaveCount(0);
    await expect(page.getByTestId("guide-step-1")).toContainText("1 part");
  });

  test("a 2-layer design with a top cap includes the cap steps, and both parts print separately", async ({ page }) => {
    await gotoGuide(page, TWO_LAYER_CAP);
    await expect(page.getByTestId("guide-step-1")).toContainText("Print the parts");
    await expect(page.getByTestId("guide-step-1")).toContainText("2 parts");
    await expect(page.getByTestId("guide-step-2")).toContainText("Clip in the inner cable end");
    await expect(page.getByTestId("guide-step-3")).toContainText("Wind the cable");
    await expect(page.getByTestId("guide-step-3")).toContainText("2 layers");
    await expect(page.getByTestId("guide-step-4")).toContainText("Fit the top cap");
    await expect(page.getByTestId("guide-step-5")).toContainText("Secure the outer end");
    await expect(page.getByTestId("guide-step-6")).toContainText("Mount on the wall");
    await expect(page.getByTestId("guide-step-7")).toContainText("Unwinding");
    await expect(page.getByTestId("guide-step-8")).toHaveCount(0);

    await expect(page.getByTestId("guide-print-part-core")).toBeVisible();
    await expect(page.getByTestId("guide-print-part-top-cap")).toBeVisible();
  });

  // A hash-only `page.goto` is a same-document fragment navigation (the
  // browser never reloads, so the SPA never re-reads the new hash) -- each
  // joint/mount case therefore needs its own `page.goto`-from-scratch test,
  // matching the rest of this suite's convention (e.g. top-cap.spec.ts's
  // JOINTS loop), rather than reusing one page across several `gotoGuide` calls.
  const JOINTS: Array<{ id: "press" | "bayonet" | "snap"; wording: string }> = [
    { id: "press", wording: "Press the cap down" },
    { id: "bayonet", wording: "twist to lock" },
    { id: "snap", wording: "clips click" },
  ];
  for (const { id, wording } of JOINTS) {
    test(`joint=${id}: the fit-the-cap step uses joint-specific wording, plus the glue note`, async ({ page }) => {
      await gotoGuide(page, `${TWO_LAYER_CAP}&joint=${id}`);
      await expect(page.getByTestId("guide-step-4")).toContainText(wording);
      // Every joint is permanent (docs/research.md): the glue note always appears.
      await expect(page.getByTestId("guide-step-4")).toContainText("glue");
    });
  }

  test("the wall-mount step gives real instructions once the screw-keyhole mount is selected", async ({ page }) => {
    await gotoGuide(page, `${ONE_LAYER}&mount=keyhole`);
    await expect(page.getByTestId("guide-step-4")).toContainText("keyhole slot on a screw");
  });

  // Issue #14 landed the SKÅDIS clip mount after this guide shipped (issue
  // #17 PR review round 2, on #14's own PR): mountLine() must give it real
  // wording too, not the generic "coming soon" fallback meant only for
  // "none" (and "opengrid", which isn't reachable -- see mountLine's own
  // doc comment in Guide.tsx).
  // Issue #106: the plate gets its own "fit the plate" step (printed pegs +
  // glue), then the mount step shows the clips face-on against the drawn
  // SKÅDIS slot grid.
  test("the SKÅDIS clip mount gets a fit-the-plate step, then a mount step with the clips in the board's slots", async ({ page }) => {
    await gotoGuide(page, `${ONE_LAYER}&mount=skadis`);
    await expect(page.getByTestId("guide-step-4")).toContainText(/mount plate/i);
    await expect(page.getByTestId("guide-step-4")).toContainText(/two printed pegs/i);
    // Issue #132: the pegs are printed parts, shown once in step 1 as x2.
    await expect(page.getByTestId("guide-step-1")).toContainText(/Alignment peg ×2/);
    await expect(page.getByTestId("guide-step-1")).toContainText("4 parts");
    await expect(page.getByTestId("guide-step-5")).toContainText(/SK.DIS/i);
    await expect(page.getByTestId("guide-step-5")).toContainText(/slots/i);
    await expect(page.getByTestId("guide-step-5")).not.toContainText("coming soon");
    await expect(page.getByTestId("guide-step-5").locator(".guide-overlay-slot").first()).toBeVisible();
    await expect(page.getByTestId("guide-step-6")).toContainText(/unwind/i);
    await expect(page.getByTestId("guide-step-4")).toHaveScreenshot("guide-skadis-fit-plate.png", { timeout: GUIDE_SCREENSHOT_TIMEOUT });
    await expect(page.getByTestId("guide-step-5")).toHaveScreenshot("guide-skadis-mount.png", { timeout: GUIDE_SCREENSHOT_TIMEOUT });
  });

  // Issue #70 landed the through-hole mount after this guide shipped, the
  // same way issue #14's SKÅDIS case did above. "through" is a new mount
  // kind added after issue #56's `#v=1&...` legacy format was frozen (see
  // mount.spec.ts's own comment on this), so this navigates via the current
  // `#s=<base64url(JSON)>` document format directly instead.
  test("the wall-mount step gives real instructions once the through-hole mount is selected", async ({ page }) => {
    const doc = { v: 2, L: 1000, d: 4, size: 40 };
    await gotoGuide(page, `#s=${Buffer.from(JSON.stringify({ ...doc, mount: "through" })).toString("base64url")}`);
    await expect(page.getByTestId("guide-step-4")).toContainText(/screw straight through/i);
    await expect(page.getByTestId("guide-step-4")).not.toContainText("coming soon");
  });

  test("the toolbar opens the guide from the design view and back again, without losing the design", async ({ page }) => {
    await page.goto(`/${TWO_LAYER_CAP}`);
    await expect(page.getByTestId("coil-viewer")).toBeVisible();
    await page.waitForTimeout(500);

    await page.getByTestId("open-guide").click();
    await expect(page.getByTestId("guide-view")).toBeVisible();
    await expect(async () => expect(decodeHashDoc(page.url()).ui).toMatchObject({ view: "guide" })).toPass();

    await page.getByTestId("guide-back").click();
    await expect(page.getByTestId("coil-viewer")).toBeVisible();
    await expect(async () => expect((decodeHashDoc(page.url()).ui as { view?: string } | undefined)?.view).toBeUndefined()).toPass();
    // Still the same (2-layer) design after returning.
    await expect(page.getByTestId("layers")).toHaveText("2");
  });

  test("print CSS hides the toolbar and puts every odd-numbered step on its own page", async ({ page }) => {
    await gotoGuide(page, TWO_LAYER_CAP);
    await page.emulateMedia({ media: "print" });
    await page.waitForTimeout(300);

    await expect(page.getByTestId("guide-toolbar")).toBeHidden();

    const breaks = await page.evaluate(() => Array.from(document.querySelectorAll(".guide-step")).map((el) => getComputedStyle(el).pageBreakBefore));
    // 7 steps for this design (2-layer, top cap on): 1 (avoid, it's first),
    // 2 (auto/no break), 3 (always), 4 (auto), 5 (always), 6 (auto), 7 (always)
    // -- pairing them up two-to-a-page.
    expect(breaks).toEqual(["avoid", "auto", "always", "auto", "always", "auto", "always"]);
  });

  // Each guide screenshot renders several WebGL canvases at once (every
  // step's figure, plus a zoom/rotated inset on some steps) -- slower than
  // the single-canvas screenshots elsewhere in this suite, especially under
  // heavy parallel SwiftShader contention. `test.slow()` triples this
  // test's own overall timeout (not just the assertion's), on top of the
  // generous `toHaveScreenshot` timeout below.
  test.describe("screenshots (visual review)", () => {
    test("1-layer design (no cap)", async ({ page }) => {
      test.slow();
      await gotoGuide(page, ONE_LAYER);
      await expect(page.getByTestId("guide-view")).toHaveScreenshot("guide-one-layer.png", { timeout: GUIDE_SCREENSHOT_TIMEOUT });
    });

    test("2-layer design with a top cap (bayonet joint)", async ({ page }) => {
      test.slow();
      await gotoGuide(page, `${TWO_LAYER_CAP}&joint=bayonet`);
      await expect(page.getByTestId("guide-view")).toHaveScreenshot("guide-two-layer-cap.png", { timeout: GUIDE_SCREENSHOT_TIMEOUT });
    });

    test("with the screw-keyhole wall mount", async ({ page }) => {
      test.slow();
      await gotoGuide(page, `${ONE_LAYER}&mount=keyhole`);
      await expect(page.getByTestId("guide-view")).toHaveScreenshot("guide-keyhole-mount.png", { timeout: GUIDE_SCREENSHOT_TIMEOUT });
    });

    // Issue #71: the keyhole mount's own rotation option -- the mount-side
    // inset (StepMountKeyhole's `guide-mount-inset`) shows the real, built
    // geometry (rotated by design()'s own `mountAxisDeg`), so a screenshot
    // at each rotation is a visual check that the cut and the illustration
    // never disagree, on top of test/mount.test.ts's own numeric coverage.
    for (const kr of [0, 45] as const) {
      test(`with the screw-keyhole wall mount, rotated ${kr} degrees`, async ({ page }) => {
        test.slow();
        const doc = { v: 2, shape: "sq", rc: 15, L: 1000, d: 4, size: 60, mount: "keyhole", ...(kr !== 0 ? { kr } : {}) };
        await gotoGuide(page, `#s=${Buffer.from(JSON.stringify(doc)).toString("base64url")}`);
        await expect(page.getByTestId("guide-view")).toHaveScreenshot(`guide-keyhole-mount-rotated-${kr}.png`, { timeout: GUIDE_SCREENSHOT_TIMEOUT });
      });
    }

    // Issue #70: the new through-hole mount -- one full guide-page screenshot
    // (round, matching the keyhole mount's own precedent above); dedicated
    // mount-side face-on close-ups per shape are below.
    test("with the through-hole wall mount", async ({ page }) => {
      test.slow();
      const doc = { v: 2, L: 1000, d: 4, size: 60, mount: "through" };
      await gotoGuide(page, `#s=${Buffer.from(JSON.stringify(doc)).toString("base64url")}`);
      await expect(page.getByTestId("guide-view")).toHaveScreenshot("guide-through-mount.png", { timeout: GUIDE_SCREENSHOT_TIMEOUT });
    });

    // Dedicated, higher-resolution close-ups of JUST the mount-side inset
    // (not the whole guide page) -- much clearer for visually reviewing
    // slot/hole placement than the small corner circle above. `guide-mount-
    // inset` renders at a fixed 100 CSS px (overlays.tsx's `INSET_SIZE`), so
    // a 3x `deviceScaleFactor` supersamples it to a genuinely sharp ~300px
    // capture instead of a soft, hard-to-inspect one.
    test.describe("mount-side face-on close-ups", () => {
      test.use({ deviceScaleFactor: 3 });

      for (const kr of [0, 45] as const) {
        test(`keyhole rotated ${kr} degrees`, async ({ page }) => {
          test.slow();
          const doc = { v: 2, shape: "sq", rc: 15, L: 1000, d: 4, size: 60, mount: "keyhole", ...(kr !== 0 ? { kr } : {}) };
          await gotoGuide(page, `#s=${Buffer.from(JSON.stringify(doc)).toString("base64url")}`);
          await expect(page.getByTestId("guide-mount-inset")).toHaveScreenshot(`mount-face-keyhole-rotated-${kr}.png`, { timeout: GUIDE_SCREENSHOT_TIMEOUT });
        });
      }

      // Issue #70 AC: "Screenshots: mount-side face-on view for round/sq/tri".
      for (const shape of ["round", "sq", "tri"] as const) {
        test(`through-hole mount (${shape})`, async ({ page }) => {
          test.slow();
          const doc = { v: 2, L: 1000, d: 4, size: 60, mount: "through", ...(shape !== "round" ? { shape, rc: 15 } : {}) };
          await gotoGuide(page, `#s=${Buffer.from(JSON.stringify(doc)).toString("base64url")}`);
          await expect(page.getByTestId("guide-mount-inset")).toHaveScreenshot(`mount-face-through-${shape}.png`, { timeout: GUIDE_SCREENSHOT_TIMEOUT });
        });
      }
    });

    test("print-media emulation", async ({ page }) => {
      test.slow();
      await gotoGuide(page, TWO_LAYER_CAP);
      await page.emulateMedia({ media: "print" });
      await expect(page).toHaveScreenshot("guide-print-media.png", { timeout: GUIDE_SCREENSHOT_TIMEOUT });
    });
  });
});
