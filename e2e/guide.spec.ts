import { expect, test, type Locator, type Page } from "@playwright/test";
import { decodeHashDoc, encodeHashDoc, withHashDoc } from "./hashDoc";
import { expectSettled } from "./settled";

// End-to-end checks for issue #17 (the printable, IKEA-style assembly
// guide). The guide is generated from the current design via `ui.view` in
// the URL hash's document (see `./hashDoc.ts`) -- so these check
// that seam -- hash -> UI -> step content/screenshots -- not the solver
// itself (see test/design.test.ts for that). Every step's illustration
// reuses the same line-art pipeline as the interactive viewer
// (src/viewer/CoilScene.tsx, src/viewer/GuideFigure.tsx).

const ONE_LAYER = encodeHashDoc({ L: 1000, d: 4, size: 40 }); // the default design: a bare core, layers=1, so no base and no top cap
const BASED_ONE_LAYER = withHashDoc(ONE_LAYER, { base: "on" }); // with the base: the inner end clips into its rim
const TWO_LAYER_CAP = encodeHashDoc({ L: 3800, d: 3.8, lock: ["outer", "h"], size: 60, h: 60, base: "on", cap: "on" }); // layers=2 with the base and the cap switched on (auto is off)

// The guide's own screenshots render several distinct WebGL figures at
// once (one per step), so they're the heaviest screenshots in the whole
// suite -- real GitHub-hosted runners (2 shared vCPUs, no GPU) need much
// more than this repo's usual per-assertion default for these specifically
// (see playwright.config.ts and issue #18's PR for the general CI-speed
// finding); test.slow() below covers the surrounding test's own timeout,
// not this per-assertion one.
const GUIDE_SCREENSHOT_TIMEOUT = process.env.CI ? 120_000 : 25_000;

// A guide figure only renders while it is near the viewport (GuideFigure), and
// `data-rendered` says it has drawn. A screenshot of the whole guide, or of a
// figure far down the page, has to scroll each figure in first.
async function revealFigures(page: Page, scope: Locator = page.locator("body")) {
  const figures = scope.locator("xpath=descendant-or-self::*[@data-rendered]");
  const count = await figures.count();
  for (let i = 0; i < count; i++) {
    await figures.nth(i).scrollIntoViewIfNeeded();
    await expect(figures.nth(i)).toHaveAttribute("data-rendered", "true", { timeout: GUIDE_SCREENSHOT_TIMEOUT });
  }
}

async function gotoGuide(page: Page, hash: string, { reveal = false } = {}) {
  await page.goto(`/${withHashDoc(hash, { ui: { view: "guide" } })}`);
  await expect(page.getByTestId("guide-view")).toBeVisible();
  // Wait for the FINAL-resolution design, not just the fast draft the guide
  // may still be showing right after load: the draft->final swap (issue #7)
  // is CPU-time-, not wall-clock-bound, so a fixed sleep alone can race it
  // under a loaded/slow CI run (see line-art.spec.ts's gotoDesign, issue
  // #61/#62, for the full story; Guide.tsx exposes the same signal here as
  // `data-resolution` since the design view's own `download-stl` isn't in
  // the DOM while viewing the guide).
  await expect(page.getByTestId("guide-view")).toHaveAttribute("data-resolution", "final", { timeout: GUIDE_SCREENSHOT_TIMEOUT });
  if (reveal) await revealFigures(page);
}

// Counts the dark line pixels in the middle of every zoom inset in the guide (the half of each visible circle's radius), read straight from the inset's canvas, labelled by the step it belongs to.
async function insetInkPixels(page: Page): Promise<Array<{ inset: string; ink: number }>> {
  return page.getByTestId("guide-view").evaluate((view) => {
    return Array.from(view.querySelectorAll<HTMLElement>(".guide-zoom-inset")).map((wrap, index) => {
      const canvas = wrap.querySelector("canvas") as HTMLCanvasElement;
      const step = wrap.closest("[data-testid^='guide-step-']")?.getAttribute("data-testid") ?? "no step";
      const visible = wrap.getBoundingClientRect();
      const frame = canvas.getBoundingClientRect();
      const scale = canvas.width / frame.width;
      const copy = document.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext("2d")!;
      context.drawImage(canvas, 0, 0);
      const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
      const cx = (visible.left + visible.width / 2 - frame.left) * scale;
      const cy = (visible.top + visible.height / 2 - frame.top) * scale;
      const radius = (visible.width / 2) * 0.5 * scale;
      let ink = 0;
      for (let y = Math.floor(cy - radius); y < cy + radius; y++) {
        for (let x = Math.floor(cx - radius); x < cx + radius; x++) {
          if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue;
          const at = (y * copy.width + x) * 4;
          if (pixels[at + 3] > 0 && pixels[at] < 100) ink++;
        }
      }
      return { inset: `${step} inset ${index + 1}`, ink };
    });
  });
}

// Reads the zoom inset of a step, with the ink around each point it marks as its focus (the inset publishes those as fractions of its own box in `data-focus`): the dark line pixels within `radiusFraction` of the point, and whether the point lies inside the visible circle.
async function insetFocusInk(page: Page, stepTestId: string, radiusFraction: number): Promise<Array<{ inside: boolean; ink: number }>> {
  return page.getByTestId(stepTestId).evaluate((step, radiusFraction) => {
    const wrap = step.querySelector<HTMLElement>(".guide-zoom-inset");
    const focus: Array<{ x: number; y: number }> = JSON.parse(wrap?.dataset.focus ?? "[]");
    const canvas = wrap?.querySelector("canvas") as HTMLCanvasElement;
    const visible = wrap!.getBoundingClientRect();
    const frame = canvas.getBoundingClientRect();
    const scale = canvas.width / frame.width;
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d")!;
    context.drawImage(canvas, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    return focus.map((p) => {
      const cx = (visible.left + p.x * visible.width - frame.left) * scale;
      const cy = (visible.top + p.y * visible.height - frame.top) * scale;
      const radius = visible.width * radiusFraction * scale;
      let ink = 0;
      for (let y = Math.floor(cy - radius); y < cy + radius; y++) {
        for (let x = Math.floor(cx - radius); x < cx + radius; x++) {
          if (x < 0 || y < 0 || x >= copy.width || y >= copy.height || (x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue;
          const at = (y * copy.width + x) * 4;
          if (pixels[at + 3] > 0 && pixels[at] < 100) ink++;
        }
      }
      return { inside: (p.x - 0.5) ** 2 + (p.y - 0.5) ** 2 < 0.45 ** 2, ink };
    });
  }, radiusFraction);
}

test.describe("printable assembly guide (issue #17)", () => {
  // Also covers: a shared link with ui.view=guide opens the guide directly,
  // generated from that design (gotoGuide's own goto IS that direct
  // `ui.view` load -- a separate test asserting only guide-step-1's text
  // duplicated this one's first assertion with no distinct risk); the
  // unwind-by-rotating tip; and the generic (no mount selected) wall-mount
  // step wording. All three used to be their own tests, but each loaded this
  // identical ONE_LAYER design and only read text already covered here, so
  // they're folded in rather than paying for three more page loads.
  test("the default bare core has no base or cap steps: print, lay in the inner end, wind, lay in the outer end, unwind", async ({ page }) => {
    await gotoGuide(page, ONE_LAYER);
    await expect(page.getByTestId("guide-step-1")).toContainText("Print the parts");
    await expect(page.getByTestId("guide-step-1")).toContainText("1 part");
    await expect(page.getByTestId("guide-step-2")).toContainText("Lay in the inner cable end");
    await expect(page.getByTestId("guide-step-2")).toContainText("bottom face");
    await expect(page.getByTestId("guide-step-3")).toContainText("Wind the cable");
    await expect(page.getByTestId("guide-step-4")).toContainText("Lay in the outer cable end");
    await expect(page.getByTestId("guide-step-4")).toContainText("top face");
    await expect(page.getByTestId("guide-step-5")).toContainText("Unwinding");
    await expect(page.getByTestId("guide-step-6")).toHaveCount(0);
    await expect(page.getByText("Clip in the inner cable end")).toHaveCount(0);
    await expect(page.getByText("Mount on the wall")).toHaveCount(0);
    await expect(page.getByText("Fit the top cap")).toHaveCount(0);
    await expect(page.locator(".guide-header")).toContainText("Print, thread, wind.");
  });

  test("a 1-layer design with the base (no top cap) skips the cap steps and lays the outer end in the top hole: print, thread, wind, outer end, mount, unwind", async ({ page }) => {
    await gotoGuide(page, BASED_ONE_LAYER);
    await expect(page.getByTestId("guide-step-1")).toContainText("Print the parts");
    await expect(page.getByTestId("guide-step-2")).toContainText("Clip in the inner cable end");
    await expect(page.getByTestId("guide-step-3")).toContainText("Wind the cable");
    await expect(page.getByTestId("guide-step-4")).toContainText("Lay in the outer cable end");
    await expect(page.getByTestId("guide-step-5")).toContainText("Mount on the wall");
    await expect(page.getByTestId("guide-step-5")).toContainText("mounts are coming soon");
    await expect(page.getByTestId("guide-step-6")).toContainText("Unwinding");
    await expect(page.getByTestId("guide-step-6")).toContainText(/rotate the coil/i);
    await expect(page.getByTestId("guide-step-6")).toContainText(/don't pull the cable/i);
    await expect(page.getByTestId("guide-step-7")).toHaveCount(0);

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
      await gotoGuide(page, withHashDoc(TWO_LAYER_CAP, { joint: id === "press" ? undefined : id }));
      await expect(page.getByTestId("guide-step-4")).toContainText(wording);
      // Every joint is permanent (docs/design.md, Decisions): the glue note always appears.
      await expect(page.getByTestId("guide-step-4")).toContainText("glue");
    });
  }

  test("the wall-mount step gives real instructions once the screw-keyhole mount is selected", async ({ page }) => {
    await gotoGuide(page, withHashDoc(ONE_LAYER, { mount: "keyhole" }));
    await expect(page.getByTestId("guide-step-5")).toContainText("keyhole slot on a screw");
  });

  // Issue #14 landed the SKÅDIS mount after this guide shipped (issue #17 PR
  // review round 2, on #14's own PR): mountLine() must give it real wording
  // too, not the generic "coming soon" fallback meant only for "none" (and
  // "opengrid", which isn't reachable -- see mountLine's own doc comment in
  // Guide.tsx). Issue #207: the rim clips print as separate parts (step 1,
  // one figure per kind), and the mount step shows them face-on against the
  // drawn SKÅDIS slot grid.
  test("the SKÅDIS rim clips are printed parts, and the mount step shows them in the board's slots", async ({ page }) => {
    await gotoGuide(page, withHashDoc(ONE_LAYER, { size: 85, mount: "skadis" })); // one layer, no top cap: 1 top + 2 bottom clips
    await expect(page.getByTestId("guide-step-1")).toContainText(/Top clip ×1/);
    await expect(page.getByTestId("guide-step-1")).toContainText(/Bottom clip ×2/);
    await expect(page.getByTestId("guide-step-1")).toContainText("4 parts");
    await expect(page.getByTestId("guide-step-1")).toContainText(/clips lying on their side/i);
    await expect(page.getByTestId("guide-step-5")).toContainText(/SK.DIS/i);
    await expect(page.getByTestId("guide-step-5")).toContainText(/bottom clip/i);
    await expect(page.getByTestId("guide-step-5")).toContainText(/clicks/i);
    await expect(page.getByTestId("guide-step-5")).not.toContainText("coming soon");
    await expect(page.getByTestId("guide-step-5").locator(".guide-overlay-slot").first()).toBeVisible();
    await expect(page.getByTestId("guide-step-6")).toContainText(/unwind/i);
    await expect(page.getByTestId("guide-step-1")).toHaveScreenshot("guide-skadis-print.png", { timeout: GUIDE_SCREENSHOT_TIMEOUT });
    await expect(page.getByTestId("guide-step-5")).toHaveScreenshot("guide-skadis-mount.png", { timeout: GUIDE_SCREENSHOT_TIMEOUT });
  });

  // Issue #213: the T-clips print as one figure, x3, and the mount step shows them turned across the board's
  // slots, with a close-up of one T bar (not a whole-coil inset, which reads as a blob at that size, #215).
  // Issue #221: they are reached through the core, and turned by their fins.
  test("the SKÅDIS T-clips are printed parts, and the mount step shows a close-up of one locked behind the board", async ({ page }) => {
    await gotoGuide(page, withHashDoc(ONE_LAYER, { size: 85, mount: "skadis-tclip" }));
    await expect(page.getByTestId("guide-step-1")).toContainText(/T-clip ×3/);
    await expect(page.getByTestId("guide-step-1")).toContainText("4 parts");
    await expect(page.getByTestId("guide-step-5")).toContainText(/quarter turn clockwise/i);
    await expect(page.getByTestId("guide-step-5")).toContainText(/reach through the core/i);
    await expect(page.getByTestId("guide-step-5")).toContainText(/pinch the fin and turn/i);
    await expect(page.getByTestId("guide-step-5").locator(".guide-overlay-slot").first()).toBeVisible();
    await expect(page.getByTestId("guide-mount-inset")).toHaveCount(0);
    await expect(page.getByTestId("guide-step-1")).toHaveScreenshot("guide-skadis-tclip-print.png", { timeout: GUIDE_SCREENSHOT_TIMEOUT });
    await expect(page.getByTestId("guide-step-5")).toHaveScreenshot("guide-skadis-tclip-mount.png", { timeout: GUIDE_SCREENSHOT_TIMEOUT });
  });

  // Issue #70 landed the through-hole mount after this guide shipped, the
  // same way issue #14's SKÅDIS case did above. "through" is a new mount
  // kind added after this guide shipped, so this navigates with the
  // `#s=<base64url(JSON)>` document format directly.
  test("the wall-mount step gives real instructions once the through-hole mount is selected", async ({ page }) => {
    const doc = { L: 1000, d: 4, size: 40 };
    await gotoGuide(page, encodeHashDoc({ ...doc, mount: "through" }));
    await expect(page.getByTestId("guide-step-5")).toContainText(/countersunk screw through each hole/i);
    await expect(page.getByTestId("guide-step-5")).not.toContainText("coming soon");
  });

  test("the toolbar opens the guide from the design view and back again, without losing the design", async ({ page }) => {
    await page.goto(`/${TWO_LAYER_CAP}`);
    await expect(page.getByTestId("coil-viewer")).toBeVisible();
    await expectSettled(page);

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
  test("a figure far below the viewport does not render until it scrolls into view", async ({ page }) => {
    await gotoGuide(page, TWO_LAYER_CAP);
    const figures = page.locator("[data-rendered]");
    const first = figures.first();
    const last = figures.last();
    await expect(first).toHaveAttribute("data-rendered", "true", { timeout: GUIDE_SCREENSHOT_TIMEOUT });
    expect(await figures.count()).toBeGreaterThan(3);
    // Give a wrongly eager figure time to draw before asserting it did not.
    await page.waitForTimeout(1000);
    await expect(last).toHaveAttribute("data-rendered", "false");
    expect(await last.evaluate((el) => (el.querySelector("canvas") as HTMLCanvasElement).toDataURL().length)).toBeLessThan(
      await first.evaluate((el) => (el.querySelector("canvas") as HTMLCanvasElement).toDataURL().length),
    );

    await last.scrollIntoViewIfNeeded();
    await expect(last).toHaveAttribute("data-rendered", "true", { timeout: GUIDE_SCREENSHOT_TIMEOUT });
  });

  test("the print button draws every figure before it opens the print dialog", async ({ page }) => {
    // A browser prints the canvases as they are, so a figure still waiting to scroll into view would print blank.
    await page.addInitScript(() => {
      window.print = () => {
        const figures = Array.from(document.querySelectorAll("[data-rendered]"));
        (window as unknown as { __printState: string }).__printState = `${figures.filter((f) => f.getAttribute("data-rendered") === "true").length}/${figures.length}`;
      };
    });
    await gotoGuide(page, TWO_LAYER_CAP);
    const total = await page.locator("[data-rendered]").count();
    await expect(page.locator("[data-rendered='false']")).not.toHaveCount(0);
    await page.getByTestId("guide-print").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __printState?: string }).__printState), { timeout: GUIDE_SCREENSHOT_TIMEOUT }).toBe(`${total}/${total}`);
  });

  // Issue #253: a figure that has drawn and then resizes while off screen (a full-page capture or the print layout does this) lost its
  // pixels, and the zoom inset showed an empty circle. The full-guide screenshot below is that resize. Issue #274: every inset of
  // every design below, not only step 2's, and the guide must show at least the insets that design has.
  test.describe("every zoom inset shows its close-up (issues #253, #274)", () => {
    const MIN_INK_PIXELS = 50;
    const DESIGNS = [
      { name: "1-layer bare core (the default)", hash: ONE_LAYER, minInsets: 2 },
      { name: "2-layer round with a bayonet top cap", hash: withHashDoc(TWO_LAYER_CAP, { joint: "bayonet" }), minInsets: 2 },
      { name: "square core with a top cap and the screw-keyhole mount", hash: encodeHashDoc({ shape: "sq", rc: 15, L: 3800, d: 3.8, lock: ["outer", "h"], size: 60, h: 60, mount: "keyhole", cap: "on" }), minInsets: 3 },
      { name: "triangle core, 3 layers, through-hole mount", hash: encodeHashDoc({ shape: "tri", rc: 12, L: 5000, d: 3, lock: ["outer", "ly"], size: 70, ly: 3, mount: "through", cap: "on" }), minInsets: 3 },
      { name: "1-layer SKÅDIS rim clips", hash: withHashDoc(ONE_LAYER, { size: 85, mount: "skadis" }), minInsets: 2 },
      { name: "1-layer SKÅDIS T-clips", hash: withHashDoc(ONE_LAYER, { size: 85, mount: "skadis-tclip" }), minInsets: 2 },
    ];
    for (const { name, hash, minInsets } of DESIGNS) {
      test(`${name}: every inset circle has line pixels, also after a full-guide capture`, async ({ page }) => {
        test.slow();
        await gotoGuide(page, hash, { reveal: true });
        const blank = async () => (await insetInkPixels(page)).filter((i) => i.ink <= MIN_INK_PIXELS).map((i) => `${i.inset}: ${i.ink} ink pixels`);
        expect((await insetInkPixels(page)).length, "the insets the guide draws").toBeGreaterThanOrEqual(minInsets);
        await expect.poll(blank, { timeout: GUIDE_SCREENSHOT_TIMEOUT }).toEqual([]);
        await page.getByTestId("guide-view").screenshot();
        await expect.poll(blank, { timeout: GUIDE_SCREENSHOT_TIMEOUT }).toEqual([]);
      });
    }
  });

  // Issue #289: step 2's inset looks at the bottom face from below, so the channel and the hole it ends in are drawn, not hidden behind the wall.
  test.describe("step 2's inset shows the bottom-face channel and the hole (issue #289)", () => {
    const MIN_INK_AT_FOCUS = 60; // the view from below draws 89 or more pixels at each point; the old iso view drew 31 or fewer at the hole entrance, or had it outside the circle
    const FOCUS_RADIUS = 0.1;
    const SHAPES = [
      { name: "round", doc: { L: 1000, d: 4, size: 40 } },
      { name: "square", doc: { shape: "sq", rc: 15, L: 1000, d: 4, size: 60 } },
      { name: "triangle", doc: { shape: "tri", rc: 12, L: 1000, d: 4, size: 70 } },
    ];
    for (const { name, doc } of SHAPES) {
      test(`${name}: the groove's start and the hole entrance are inside the circle, with line work around each`, async ({ page }) => {
        test.slow();
        await gotoGuide(page, encodeHashDoc(doc), { reveal: true });
        await expect(page.getByTestId("guide-step-2").locator(".guide-zoom-inset")).toHaveAttribute("data-focus", /.+/);
        const probe = async () => (await insetFocusInk(page, "guide-step-2", FOCUS_RADIUS)).map((f) => (f.inside ? f.ink : -1));
        await expect.poll(async () => (await probe()).length, { timeout: GUIDE_SCREENSHOT_TIMEOUT }).toBe(2);
        await expect.poll(async () => (await probe()).every((ink) => ink >= MIN_INK_AT_FOCUS), { timeout: GUIDE_SCREENSHOT_TIMEOUT, message: `ink around the groove's start and the hole entrance: ${await probe()}` }).toBe(true);
      });
    }
  });

  test.describe("screenshots (visual review)", () => {
    test("1-layer design (no cap)", async ({ page }) => {
      test.slow();
      await gotoGuide(page, ONE_LAYER, { reveal: true });
      await expect(page.getByTestId("guide-view")).toHaveScreenshot("guide-one-layer.png", { timeout: GUIDE_SCREENSHOT_TIMEOUT });
    });

    test("2-layer design with a top cap (bayonet joint)", async ({ page }) => {
      test.slow();
      await gotoGuide(page, withHashDoc(TWO_LAYER_CAP, { joint: "bayonet" }), { reveal: true });
      await expect(page.getByTestId("guide-view")).toHaveScreenshot("guide-two-layer-cap.png", { timeout: GUIDE_SCREENSHOT_TIMEOUT });
    });

    test("with the screw-keyhole wall mount", async ({ page }) => {
      test.slow();
      await gotoGuide(page, withHashDoc(ONE_LAYER, { mount: "keyhole" }), { reveal: true });
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
        const doc = { shape: "sq", rc: 15, L: 1000, d: 4, size: 60, mount: "keyhole", ...(kr !== 0 ? { kr } : {}) };
        await gotoGuide(page, encodeHashDoc(doc), { reveal: true });
        await expect(page.getByTestId("guide-view")).toHaveScreenshot(`guide-keyhole-mount-rotated-${kr}.png`, { timeout: GUIDE_SCREENSHOT_TIMEOUT });
      });
    }

    // Issue #70: the new through-hole mount -- one full guide-page screenshot
    // (round, matching the keyhole mount's own precedent above); dedicated
    // mount-side face-on close-ups per shape are below.
    test("with the through-hole wall mount", async ({ page }) => {
      test.slow();
      const doc = { L: 1000, d: 4, size: 60, mount: "through" };
      await gotoGuide(page, encodeHashDoc(doc), { reveal: true });
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
          const doc = { shape: "sq", rc: 15, L: 1000, d: 4, size: 60, mount: "keyhole", ...(kr !== 0 ? { kr } : {}) };
          await gotoGuide(page, encodeHashDoc(doc));
          await revealFigures(page, page.getByTestId("guide-mount-inset"));
          await expect(page.getByTestId("guide-mount-inset")).toHaveScreenshot(`mount-face-keyhole-rotated-${kr}.png`, { timeout: GUIDE_SCREENSHOT_TIMEOUT });
        });
      }

      // Issue #70 AC: "Screenshots: mount-side face-on view for round/sq/tri".
      for (const shape of ["round", "sq", "tri"] as const) {
        test(`through-hole mount (${shape})`, async ({ page }) => {
          test.slow();
          const doc = { L: 1000, d: 4, size: 60, mount: "through", ...(shape !== "round" ? { shape, rc: 15 } : {}) };
          await gotoGuide(page, encodeHashDoc(doc));
          await revealFigures(page, page.getByTestId("guide-mount-inset"));
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
