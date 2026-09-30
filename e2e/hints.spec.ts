import { expect, test } from "@playwright/test";

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
  await page.goto("/");
  const field = page.locator(".field").filter({ hasText: "Cable length" });
  const hintBtn = field.getByTestId("hint-btn");
  const bubble = field.getByTestId("hint-bubble");

  await expect(bubble).not.toBeVisible();
  await hintBtn.hover();
  await expect(bubble).toBeVisible();
  await expect(bubble).toContainText("centimetres");

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
  // the top cap is off -- a two-layer link keeps the (auto) cap on so those
  // fields are actually in the DOM to check.
  await page.goto("/#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2");
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();
  await page.getByText("Advanced settings").click();
  for (const heading of ["Winding quality"]) {
    const field = page.locator(".field").filter({ hasText: heading });
    await expect(field.getByTestId("hint-btn")).toBeVisible();
  }

  for (const heading of ["Top cap", "Joint", "Joint tolerance", "Label", "Wall mount", "Bed X", "Bed Y", "Bed Z"]) {
    const field = page.locator(".field").filter({ hasText: heading }).first();
    await expect(field.getByTestId("hint-btn"), `expected a hint on the "${heading}" field`).toBeVisible();
  }
});

test("the conditional advanced fields (custom bend multiplier, objective) have hints when they're shown", async ({ page }) => {
  // wt=custom shows the custom-bend-multiplier field; leaving only "outer"
  // locked (height + layers both free) shows the objective picker (issue
  // #23: freeCount >= 2).
  await page.goto("/#v=1&L=1000&d=4&wt=custom&lock=outer&size=40");
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();

  const customField = page.locator(".field").filter({ hasText: "Custom bend multiplier" });
  await expect(customField.getByTestId("hint-btn")).toBeVisible();

  const objectiveField = page.locator(".field").filter({ hasText: "Objective" });
  await expect(objectiveField.getByTestId("hint-btn")).toBeVisible();
});

test("the conditional mount fields (keyhole rotation, through-hole diameter) have hints when they're shown", async ({ page }) => {
  await page.goto("/#v=1&L=1000&d=4&lock=outer&size=40");
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
  await page.goto("/#v=1&L=1000&d=4&lock=outer,ly&size=40");
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();
  const wireToggle = page.locator(".wire-toggle");
  await expect(wireToggle.getByTestId("hint-btn")).toBeVisible();
});
