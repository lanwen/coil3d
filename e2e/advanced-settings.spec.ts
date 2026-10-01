import { expect, test } from "@playwright/test";
import { openAdvanced } from "./advanced";
import { decodeHashDoc, encodeHashDoc } from "./hashDoc";

// Issue #169: "Advanced settings" starts collapsed (it is rarely needed and
// makes the panel long), expands and collapses again, and its open state is
// plain DOM state -- never in the URL hash or browser storage.

const details = (page: import("@playwright/test").Page) => page.locator("details.advanced");

for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 800 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test(`${name}: collapsed on load; opens and closes by click`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(details(page)).not.toHaveAttribute("open", "");
    await expect(page.getByTestId("input-windingQuality")).toBeHidden();

    const summary = details(page).locator("summary");
    // A real tap target on a phone.
    expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    await summary.click();
    await expect(details(page)).toHaveAttribute("open", "");
    await expect(page.getByTestId("input-windingQuality")).toBeVisible();

    await summary.click();
    await expect(details(page)).not.toHaveAttribute("open", "");
    await expect(page.getByTestId("input-windingQuality")).toBeHidden();
  });
}

test("opens and closes from the keyboard, and the fields work once open", async ({ page }) => {
  await page.goto("/");
  const summary = details(page).locator("summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(details(page)).toHaveAttribute("open", "");

  const input = page.getByTestId("input-windingQuality");
  await input.fill("0.4");
  await input.blur();
  await expect(input).toHaveValue("0.4");
  await expect.poll(() => decodeHashDoc(page.url()).q).toBe(0.4);

  await summary.focus();
  await page.keyboard.press("Space");
  await expect(details(page)).not.toHaveAttribute("open", "");
});

test("a hash with advanced values stays collapsed, and the values still apply", async ({ page }) => {
  // Two free dimensions used to show an objective picker in this section,
  // which forced it open. Issue #192 replaced the picker with the option
  // cards: an old link's obj=ar now shows as the active "Even proportions"
  // card. Winding quality still comes from the hash.
  await page.goto(`/${encodeHashDoc({ L: 2000, d: 3.8, lock: ["outer"], size: 30, q: 0.3, obj: "ar" })}`);
  await expect(page.getByTestId("verdict")).toBeVisible();
  await expect(details(page)).not.toHaveAttribute("open", "");
  await expect(page.getByTestId("select-objective")).toHaveCount(0);
  await expect(page.locator('[data-testid^="option-"][data-active="true"]')).toContainText("Even proportions");
  await expect(page.getByRole("radio", { name: "Even proportions" })).toBeChecked();

  await openAdvanced(page);
  await expect(page.getByTestId("input-windingQuality")).toHaveValue("0.3");
  await expect(page.getByTestId("select-objective")).toHaveCount(0);
});

test("the open state is not stored in the URL hash or browser storage", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  const hashBefore = new URL(page.url()).hash;
  await openAdvanced(page);
  await expect(details(page)).toHaveAttribute("open", "");
  expect(new URL(page.url()).hash).toBe(hashBefore);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);

  await page.reload();
  await expect(details(page)).not.toHaveAttribute("open", "");
});
