import { expect, test } from "@playwright/test";
import { openAdvanced } from "./advanced";
import { hoverHint } from "./hint";
import { encodeHashDoc } from "./hashDoc";

// Issue #53 acceptance criteria: every control (including advanced settings,
// cap/joint, label, mount, print bed and the viewer toggles) has an (i)
// button with a short plain-English hint; it opens on hover/focus (desktop)
// and tap (touch, via the same click handler); Esc closes it; it's
// accessible (button + aria-describedby); and it never overlaps the field's
// own value. Hint text itself lives in one module, src/components/hints.ts.

test("every top-level control has an (i) hint button", async ({ page }) => {
  await page.goto("/");
  // Cable, shape, core, mount, top cap/joint, print bed -- one hint each
  // (advanced settings/objective are collapsed and covered separately
  // below). Counted as a lower bound so this doesn't have to be updated
  // for every unrelated future field.
  //
  // Issue #131: joint/tolerance/label are cap-only controls, hidden on this
  // default page (layers=1, so the auto cap starts off) -- lowered from 15
  // to keep the same couple-of-hints margin over the smaller default count.
  const count = await page.getByTestId("hint-btn").count();
  expect(count).toBeGreaterThanOrEqual(12);
});

test("hovering the (i) button opens the hint, and it does not overlap the field's value", async ({ page }) => {
  // Issue #187: a web font swapping in after first paint used to move the
  // button by several pixels (issue #191 removed most of that with a
  // metric-matched fallback). Hold the font back so the swap always lands
  // late (the worst case for a hover); hoverHint waits for it.
  await page.route(/\.woff2/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue();
  });
  await page.goto("/");
  const field = page.locator(".field").filter({ hasText: "Cable length" });
  const hintBtn = field.getByTestId("hint-btn");
  const bubble = field.getByTestId("hint-bubble");

  await expect(bubble).not.toBeVisible();
  await hoverHint(page, hintBtn);
  await expect(bubble).toBeVisible();
  await expect(bubble).toContainText("centimetres");

  // Once the page has settled (font swapped in, a couple of frames painted
  // so the browser has re-run its hover hit-test), the hint is still open.
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (let i = 0; i < 3; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  await expect(bubble).toBeVisible();

  const bubbleBox = await bubble.boundingBox();
  const valueBox = await field.locator(".field-value").boundingBox();
  expect(bubbleBox && valueBox).toBeTruthy();
  // The bubble sits below the value's row, not on top of it.
  expect(bubbleBox!.y).toBeGreaterThanOrEqual(valueBox!.y + valueBox!.height - 1);
});

test("tapping the (i) button opens the hint (touch/mobile), and Escape closes it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const field = page.locator(".field").filter({ hasText: "Cable diameter" });
  const hintBtn = field.getByTestId("hint-btn");
  const bubble = field.getByTestId("hint-bubble");

  await expect(bubble).not.toBeVisible();
  await hintBtn.click();
  await expect(bubble).toBeVisible();
  await expect(hintBtn).toHaveAttribute("aria-expanded", "true");

  await page.keyboard.press("Escape");
  await expect(bubble).not.toBeVisible();
  await expect(hintBtn).toBeFocused();
});

test("the hint button is described by its bubble via aria-describedby", async ({ page }) => {
  await page.goto("/");
  const field = page.locator(".field").filter({ hasText: "Core size" }).first();
  const hintBtn = field.getByTestId("hint-btn");
  const bubble = field.getByTestId("hint-bubble");

  const describedBy = await hintBtn.getAttribute("aria-describedby");
  const bubbleId = await bubble.getAttribute("id");
  expect(describedBy).toBe(bubbleId);
});

test("advanced settings and the top-cap/joint/label/mount/print-bed controls all have hints too", async ({ page }) => {
  // Issue #131: joint/tolerance/label are cap-only controls, hidden while
  // the top cap is off -- the link turns it on so those fields are actually
  // in the DOM to check.
  await page.goto(`/${encodeHashDoc({ L: 5000, d: 3.8, lock: ["outer", "h"], size: 60, h: 60, cap: "on" })}`);
  await expect(page.getByTestId("verdict")).toBeVisible();
  await openAdvanced(page);
  for (const heading of ["Winding quality"]) {
    const field = page.locator(".field").filter({ hasText: heading });
    await expect(field.getByTestId("hint-btn")).toBeVisible();
  }

  for (const heading of ["Top cap", "Joint", "Joint tolerance", "Label", "Wall mount", "Bed X", "Bed Y", "Bed Z"]) {
    const field = page.locator(".field").filter({ hasText: heading }).first();
    await expect(field.getByTestId("hint-btn"), `expected a hint on the "${heading}" field`).toBeVisible();
  }
});

test("the conditional fields (custom bend multiplier, the option cards) have hints when they're shown", async ({ page }) => {
  // wt=custom shows the custom-bend-multiplier field; leaving only "outer"
  // locked (height + layers both free) shows the option cards (issue #192,
  // which replaced the objective picker).
  await page.goto(`/${encodeHashDoc({ L: 2000, d: 3.8, wt: "custom", lock: ["outer"], size: 60 })}`);
  await expect(page.getByTestId("verdict")).toBeVisible();

  const customField = page.locator(".field").filter({ hasText: "Custom bend multiplier" });
  await expect(customField.getByTestId("hint-btn")).toBeVisible();

  const optionsSection = page.locator("section.ctl-section").filter({ has: page.getByTestId("options") });
  await expect(optionsSection.getByTestId("hint-btn")).toBeVisible();
});

test("the conditional mount fields (keyhole rotation, through-hole diameter) have hints when they're shown", async ({ page }) => {
  await page.goto(`/${encodeHashDoc({ L: 1000, d: 4, lock: ["outer"], size: 40 })}`);
  // Issue #131: the kind picker only exists once the wall-mount toggle is on.
  await page.getByTestId("mount-enabled").check();
  await page.getByTestId("select-mount").selectOption("keyhole");
  const rotationField = page.locator(".field").filter({ hasText: "Keyhole rotation" });
  await expect(rotationField.getByTestId("hint-btn")).toBeVisible();

  await page.getByTestId("select-mount").selectOption("through");
  const diameterField = page.locator(".field").filter({ hasText: "Through-hole diameter" });
  await expect(diameterField.getByTestId("hint-btn")).toBeVisible();
});

test("the viewer's wound-cable toggle has a hint too", async ({ page }) => {
  await page.goto(`/${encodeHashDoc({ L: 1000, d: 4, size: 40 })}`);
  await expect(page.getByTestId("verdict")).toBeVisible();
  const wireToggle = page.locator(".wire-toggle");
  await expect(wireToggle.getByTestId("hint-btn")).toBeVisible();
});
