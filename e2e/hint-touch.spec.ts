import { expect, test, type Locator, type Page } from "@playwright/test";

// Issue #362: on a touch device a tap also fires the emulated mouseenter and
// a focus, and neither is ever undone (no mouseleave arrives), so a hint that
// a tap opened could not be closed with a second tap. On touch the bubble
// closes on a second tap, a tap anywhere outside, or opening another hint.

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

function hintOf(page: Page, heading: string) {
  const field = page.locator(".field").filter({ hasText: heading }).first();
  return { btn: field.getByTestId("hint-btn"), bubble: field.getByTestId("hint-bubble") };
}

async function expectOpen(btn: Locator, bubble: Locator, open: boolean) {
  if (open) await expect(bubble).toHaveAttribute("data-open", "true");
  else await expect(bubble).not.toHaveAttribute("data-open", "true");
  await expect(btn).toHaveAttribute("aria-expanded", String(open));
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("verdict")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
});

test("tapping an (i) opens its hint and tapping it again closes it", async ({ page }) => {
  const { btn, bubble } = hintOf(page, "Cable diameter");
  await expectOpen(btn, bubble, false);
  await btn.tap();
  await expectOpen(btn, bubble, true);
  await btn.tap();
  await expectOpen(btn, bubble, false);
  const untouched = hintOf(page, "Cable length").btn;
  const fill = (el: Locator) => el.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(await fill(btn)).toBe(await fill(untouched));
  await btn.tap();
  await expectOpen(btn, bubble, true);
});

test("tapping outside an open hint closes it", async ({ page }) => {
  const { btn, bubble } = hintOf(page, "Cable diameter");
  await btn.tap();
  await expectOpen(btn, bubble, true);
  await page.getByRole("heading", { level: 1 }).first().tap();
  await expectOpen(btn, bubble, false);
});

test("tapping a second (i) opens it and closes the first", async ({ page }) => {
  const first = hintOf(page, "Cable diameter");
  const second = hintOf(page, "Cable length");
  await first.btn.tap();
  await expectOpen(first.btn, first.bubble, true);
  await second.btn.tap();
  await expectOpen(second.btn, second.bubble, true);
  await expectOpen(first.btn, first.bubble, false);
  await second.btn.tap();
  await expectOpen(second.btn, second.bubble, false);
});

test("tapping an (i) does not toggle or focus the control beside it", async ({ page }) => {
  const toggle = page.getByTestId("toggle-wire");
  const wireHint = page.locator(".wire-toggle").getByTestId("hint-btn");
  const before = await toggle.isChecked();
  await wireHint.tap();
  await expect(page.locator(".wire-toggle").getByTestId("hint-bubble")).toHaveAttribute("data-open", "true");
  expect(await toggle.isChecked()).toBe(before);

  const field = page.locator(".field").filter({ hasText: "Cable diameter" }).first();
  await field.getByTestId("hint-btn").tap();
  await expect(field.getByRole("textbox").or(field.getByRole("spinbutton")).first()).not.toBeFocused();
});

test("a keyboard-focused (i) still opens and Escape closes it on a touch device", async ({ page }) => {
  const { btn, bubble } = hintOf(page, "Cable diameter");
  await page.keyboard.press("Tab");
  await btn.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(btn).toBeFocused();
  await expectOpen(btn, bubble, true);
  await page.keyboard.press("Escape");
  await expectOpen(btn, bubble, false);
  await expect(btn).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(btn).not.toBeFocused();
  await page.keyboard.press("Tab");
  await expectOpen(btn, bubble, true);
  await page.keyboard.press("Tab");
  await expectOpen(btn, bubble, false);
});
