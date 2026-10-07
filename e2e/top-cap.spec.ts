import { expect, test, type Page } from "@playwright/test";
import { decodeHashDoc, encodeHashDoc, withHashDoc } from "./hashDoc";
import { expectSettled } from "./settled";

// End-to-end checks for issue #9 (top cap, joints, exploded view,
// docs/design.md, Parts and printing and Tolerances). Solver/geometry
// numbers themselves are covered by vitest against the public `design()`
// interface (test/topCap.test.ts); these tests check the URL hash <-> UI <->
// viewer seam: the cap/joint/tolerance controls, the auto-cap decision
// showing/hiding the exploded-view toggle, and the exploded animation itself.

// outer=60, height=60 (both locked), layers=2 locked -> layers > 1, so the
// top cap is auto-on and every joint has room for its features (>= the
// JOINT_ENGAGE_DEPTH + margin floor in src/core/constants.ts).
const TWO_LAYER = encodeHashDoc({ L: 5000, d: 3.8, lock: ["outer", "h"], size: 60, h: 60, base: "on" });
const ONE_LAYER = encodeHashDoc({ L: 1000, d: 4, size: 40, base: "on" }); // layers=1 (default): no top cap

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  // Wait for the FINAL-resolution mesh before settling: the draft->final
  // swap (issue #7) is CPU-time-, not wall-clock-bound, so a fixed sleep
  // alone can race it under a loaded/slow CI run (see line-art.spec.ts's
  // gotoDesign, issue #61/#62, for the full story).
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await expectSettled(page);
}

test.describe("top cap controls and auto-decision (issue #9)", () => {
  test("layers=1 (auto): no top cap, no exploded-view toggle, result panel says off", async ({ page }) => {
    await gotoDesign(page, ONE_LAYER);
    await expect(page.getByTestId("caps")).toContainText("off");
    await expect(page.getByTestId("toggle-exploded")).toHaveCount(0);
    await expect(page.getByTestId("mesh-detail")).toContainText("1 part");
    // Issue #119: untouched, the top-cap switch shows the auto tag and the
    // CURRENT automatic state (off, since layers === 1) -- and no "reset to
    // auto" link, since it's already auto.
    await expect(page.getByTestId("topCap")).not.toBeChecked();
    await expect(page.getByTestId("topCap-auto-tag")).toBeVisible();
    await expect(page.getByTestId("topCap-reset-auto")).toHaveCount(0);
  });

  test("layers=2 (auto): a top cap is added, and the exploded-view toggle appears", async ({ page }) => {
    await gotoDesign(page, TWO_LAYER);
    await expect(page.getByTestId("caps")).toContainText("on");
    await expect(page.getByTestId("toggle-exploded")).toBeVisible();
    await expect(page.getByTestId("mesh-detail")).toContainText("2 parts");
    // Issue #119: still auto, but now showing "on" (layers > 1).
    await expect(page.getByTestId("topCap")).toBeChecked();
    await expect(page.getByTestId("topCap-auto-tag")).toBeVisible();
    await expect(page.getByTestId("topCap-reset-auto")).toHaveCount(0);
  });

  test("overriding the top cap off removes it even with layers=2", async ({ page }) => {
    await gotoDesign(page, withHashDoc(TWO_LAYER, { cap: "off" }));
    // Issue #119: an explicit override -- unchecked, no auto tag, and a way
    // back to auto.
    await expect(page.getByTestId("topCap")).not.toBeChecked();
    await expect(page.getByTestId("topCap-auto-tag")).toHaveCount(0);
    await expect(page.getByTestId("topCap-reset-auto")).toBeVisible();
    await expect(page.getByTestId("caps")).toContainText("off");
    await expect(page.getByTestId("toggle-exploded")).toHaveCount(0);
  });

  test("touching the top-cap switch makes it explicit (stored in the hash), and 'reset to auto' restores auto (issue #119)", async ({ page }) => {
    await gotoDesign(page, TWO_LAYER); // auto -> currently "on" (layers=2)
    await expect(page.getByTestId("topCap-auto-tag")).toBeVisible();
    expect(decodeHashDoc(page.url()).cap).toBeUndefined(); // auto is never written to the hash

    // Touching it while it already reads "on" flips it OFF (a real state
    // change), and that becomes an explicit, hash-stored override.
    await page.getByTestId("topCap").uncheck();
    await expect(page.getByTestId("topCap-auto-tag")).toHaveCount(0);
    await expect(page.getByTestId("caps")).toContainText("off");
    await expect(async () => expect(decodeHashDoc(page.url()).cap).toBe("off")).toPass();

    await page.getByTestId("topCap-reset-auto").click();
    await expect(page.getByTestId("topCap-auto-tag")).toBeVisible();
    await expect(page.getByTestId("topCap-reset-auto")).toHaveCount(0);
    await expect(page.getByTestId("caps")).toContainText("on"); // back to the automatic layers>1 decision
    await expect(async () => expect(decodeHashDoc(page.url()).cap).toBeUndefined()).toPass();

    await page.reload();
    await expect(page.getByTestId("topCap-auto-tag")).toBeVisible();
    await expect(page.getByTestId("topCap")).toBeChecked();
  });

  test("changing the joint and tolerance controls updates the hash, and reloading reproduces them", async ({ page }) => {
    await gotoDesign(page, TWO_LAYER);
    await page.getByTestId("select-joint").selectOption("bayonet");
    await expect(async () => expect(decodeHashDoc(page.url()).joint).toBe("bayonet")).toPass();

    const tol = page.getByTestId("input-tolerance");
    await tol.fill("0.35");
    await tol.blur();
    await expect(async () => expect(decodeHashDoc(page.url()).tol).toBe(0.35)).toPass();

    await page.reload();
    await expect(page.getByTestId("select-joint")).toHaveValue("bayonet");
    await expect(page.getByTestId("input-tolerance")).toHaveValue("0.35");
  });
});

// Issue #131 AC #4: the joint/tolerance/label controls only apply to a cap
// that actually exists -- hidden whenever the cap is off, whether that's
// the current automatic (layers <= 1) decision or an explicit override, and
// shown again the moment the cap comes back (auto or explicit).
test.describe("cap-only controls hide when the cap is off (issue #131)", () => {
  test("layers=1 (auto-off): joint, tolerance and label are all hidden; touching the cap on reveals them, and 'reset to auto' hides them again", async ({ page }) => {
    await gotoDesign(page, ONE_LAYER);
    await expect(page.getByTestId("caps")).toContainText("off");
    await expect(page.getByTestId("select-joint")).toHaveCount(0);
    await expect(page.getByTestId("input-tolerance")).toHaveCount(0);
    await expect(page.getByTestId("label-enabled")).toHaveCount(0);

    await page.getByTestId("topCap").check(); // touch it on -> explicit "on"
    await expect(page.getByTestId("select-joint")).toBeVisible();
    await expect(page.getByTestId("input-tolerance")).toBeVisible();
    await expect(page.getByTestId("label-enabled")).toBeVisible();

    await page.getByTestId("topCap-reset-auto").click(); // back to auto -> off again (layers=1)
    await expect(page.getByTestId("select-joint")).toHaveCount(0);
    await expect(page.getByTestId("input-tolerance")).toHaveCount(0);
    await expect(page.getByTestId("label-enabled")).toHaveCount(0);
  });

  test("layers=2 with an explicit cap=off override: joint, tolerance and label stay hidden even though there's more than one layer", async ({ page }) => {
    await gotoDesign(page, withHashDoc(TWO_LAYER, { cap: "off" }));
    await expect(page.getByTestId("caps")).toContainText("off");
    await expect(page.getByTestId("select-joint")).toHaveCount(0);
    await expect(page.getByTestId("input-tolerance")).toHaveCount(0);
    await expect(page.getByTestId("label-enabled")).toHaveCount(0);
  });

  test("hiding the controls does not reset their values -- they come back exactly as left once the cap is back on", async ({ page }) => {
    await gotoDesign(page, TWO_LAYER); // auto -> on
    await page.getByTestId("select-joint").selectOption("bayonet");
    await page.getByTestId("input-tolerance").fill("0.35");
    await page.getByTestId("input-tolerance").blur();
    await expect(async () => expect(decodeHashDoc(page.url()).tol).toBe(0.35)).toPass();

    await page.getByTestId("topCap").uncheck(); // explicit off -- controls hide
    await expect(page.getByTestId("select-joint")).toHaveCount(0);

    await page.getByTestId("topCap").check(); // explicit on again -- controls come back, unchanged
    await expect(page.getByTestId("select-joint")).toHaveValue("bayonet");
    await expect(page.getByTestId("input-tolerance")).toHaveValue("0.35");
  });
});

// Issue #131: the "auto"/"reset" slot moved from a separate line below the
// switch to sit inline BEFORE it (same row, same height as the pill).
test.describe("top-cap toggle row layout (issue #131)", () => {
  test("the auto tag sits before the switch and matches its own height; touching the switch swaps it for a 'reset' link in the same slot", async ({ page }) => {
    await gotoDesign(page, ONE_LAYER);
    const tag = page.getByTestId("topCap-auto-tag");
    const capSwitch = page.getByTestId("topCap");

    const tagBox = (await tag.boundingBox())!;
    const switchBox = (await capSwitch.boundingBox())!;
    expect(tagBox.x + tagBox.width).toBeLessThanOrEqual(switchBox.x + 1); // the tag sits to the LEFT of the switch
    // "Matches the pill's height" -- the switch's own hit target is
    // deliberately oversized past the visible pill (`.switch-input`'s
    // negative `inset`, fields.tsx), so compare against the visible track,
    // not the checkbox's own inflated bounding box.
    const trackBox = (await page.locator(".switch-track").first().boundingBox())!;
    expect(Math.abs(tagBox.height - trackBox.height)).toBeLessThanOrEqual(1);

    // No separate line below the row any more.
    await expect(page.getByTestId("topCap-reset-auto")).toHaveCount(0);

    await capSwitch.check();
    const resetLink = page.getByTestId("topCap-reset-auto");
    await expect(resetLink).toBeVisible();
    await expect(tag).toHaveCount(0);
    const resetBox = (await resetLink.boundingBox())!;
    const switchBoxAfter = (await capSwitch.boundingBox())!;
    expect(resetBox.x + resetBox.width).toBeLessThanOrEqual(switchBoxAfter.x + 1);
  });
});

// This describe (and "assembled and exploded screenshots per joint" below)
// is specifically ABOUT the exploded-view animation, so both opt back into
// real motion over the suite-wide `reducedMotion: "reduce"` default
// (playwright.config.ts), matching how these screenshots' baselines were
// originally shot.
test.describe("exploded-view animation (issue #9)", () => {
  test.use({ contextOptions: { reducedMotion: "no-preference" } });

  test("the exploded-view toggle changes the render and can be turned back off", async ({ page }) => {
    await gotoDesign(page, TWO_LAYER);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    await expect(canvas).toHaveScreenshot("top-cap-assembled-press.png");
    const assembled = await canvas.screenshot();

    await page.getByTestId("toggle-exploded").check();
    await expectSettled(page);
    const exploded = await canvas.screenshot();
    // An exact byte comparison, not `toHaveScreenshot`'s tolerant perceptual
    // diff (maxDiffPixelRatio 0.005, see playwright.config.ts): the cap lifts
    // along the coil's own axis, which under this oblique camera can shift
    // only a modest slice of the canvas -- a real change,
    // but not one the tolerant comparison is guaranteed to flag as "different".
    expect(exploded.equals(assembled), "exploding must change the render").toBe(false);
    // The joint=press (default) exploded baseline, once also re-asserted by
    // the JOINTS loop below with its own real-motion page load -- moved here
    // since this test already explodes and settles the same design/joint.
    await expect(canvas).toHaveScreenshot("top-cap-exploded-press.png");

    await page.getByTestId("toggle-exploded").uncheck();
    await expectSettled(page);
    await expect(canvas, "collapsing back must restore the assembled render").toHaveScreenshot("top-cap-assembled-press.png");
  });
});

// Issue #167: the twist lock needs a round core.
test.describe("bayonet is for round cores only (issue #167)", () => {
  test("on a square core the bayonet option is greyed out, with the reason in the hint", async ({ page }) => {
    await gotoDesign(page, withHashDoc(TWO_LAYER, { shape: "sq" }));
    await expect(page.getByTestId("select-joint").locator('option[value="bayonet"]')).toBeDisabled();
    await expect(page.getByTestId("select-joint").locator('option[value="bayonet"]')).toContainText("round core only");
    await expect(page.getByTestId("select-joint").locator('option[value="press"]')).toBeEnabled();
    await expect(page.getByTestId("warnings").filter({ hasText: "Twist lock" })).toHaveCount(0);
  });

  test("switching a bayonet design to a square core keeps joint=bayonet, builds press fit and says so", async ({ page }) => {
    await gotoDesign(page, withHashDoc(TWO_LAYER, { joint: "bayonet" }));
    await expect(page.getByTestId("select-joint").locator('option[value="bayonet"]')).toBeEnabled();
    await page.getByTestId("shape-option-sq").check();
    await expect(page.getByTestId("warnings")).toContainText("Twist lock needs a round core");
    await expect(page.getByTestId("select-joint")).toHaveValue("bayonet");
    await expect(async () => expect(decodeHashDoc(page.url())).toMatchObject({ shape: "sq", joint: "bayonet" })).toPass();
    await page.getByTestId("shape-option-round").check();
    await expect(page.getByTestId("warnings").filter({ hasText: "Twist lock" })).toHaveCount(0);
  });

  test("a link with joint=bayonet on a square core still loads, unchanged, with the warning", async ({ page }) => {
    await gotoDesign(page, withHashDoc(TWO_LAYER, { shape: "sq", joint: "bayonet" }));
    await expect(page.getByTestId("select-joint")).toHaveValue("bayonet");
    await expect(page.getByTestId("warnings")).toContainText("Twist lock needs a round core");
    expect(decodeHashDoc(page.url())).toMatchObject({ shape: "sq", joint: "bayonet" });
  });
});

// "press" (the default joint) is covered above: "the exploded-view toggle
// changes the render..." already exercises the identical design/joint and
// now asserts both its assembled and exploded baselines, so it isn't
// repeated here -- press's own "assembled looks identical" baseline
// (top-cap-assembled-bayonet.png has the same bytes as ...-press.png, since
// the assembled view hides the joint) still stands on the bayonet entry.
const JOINTS: Array<{ id: "bayonet" | "snap"; label: string }> = [
  { id: "bayonet", label: "bayonet" },
  { id: "snap", label: "snap" },
];

test.describe("assembled and exploded screenshots per joint (issue #9)", () => {
  test.use({ contextOptions: { reducedMotion: "no-preference" } });

  for (const { id, label } of JOINTS) {
    test(`joint=${id}: assembled and exploded views`, async ({ page }) => {
      await gotoDesign(page, withHashDoc(TWO_LAYER, { joint: id }));
      await expect(page.getByTestId("select-joint")).toHaveValue(id);
      const canvas = page.getByTestId("coil-viewer").locator("canvas");

      await expect(canvas).toHaveScreenshot(`top-cap-assembled-${label}.png`);

      await page.getByTestId("toggle-exploded").check();
      await expectSettled(page);
      await expect(canvas).toHaveScreenshot(`top-cap-exploded-${label}.png`);
    });
  }
});

test.describe("rim keyhole close-up (issue #9)", () => {
  test("zooming in on the assembled cap shows the rim keyhole cutout", async ({ page }) => {
    await gotoDesign(page, TWO_LAYER);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    const box = (await canvas.boundingBox())!;
    // Orbit controls zoom on wheel; scrolling "up" (negative deltaY) zooms in,
    // centered on the pointer -- point it near the cap's own rim so the
    // keyhole ends up in frame, not just the coil's center.
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.35);
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(50);
    }
    await expect(canvas).toHaveScreenshot("top-cap-keyhole-closeup.png");
  });
});
