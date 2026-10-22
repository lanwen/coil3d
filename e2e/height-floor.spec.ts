import { expect, test, type Page } from "@playwright/test";
import { decodeHashDoc, encodeHashDoc } from "./hashDoc";
import { expectSettled } from "./settled";

// Issue #353: a locked height below one turn of the cable is raised to the
// cable's minimum (`Solution.minHeight`). With the base and the top cap both
// on there is no other floor, so the part used to build with no turns at all.
// The Height field mirrors core size: its slider minimum is the floor, typing
// below it clamps, and the note shows when the stored value is below it.

const capped = (h: number) => `/${encodeHashDoc({ L: 300, base: "on", cap: "on", lock: ["h", "ly"], h, ly: 1 })}`;

async function settle(page: Page) {
  await expect(page.getByTestId("verdict")).toBeVisible();
  await expect(page.getByTestId("download-stl")).toBeEnabled({ timeout: 30_000 });
  await expectSettled(page);
}

test("a share link with a too-small locked height opens raised, with the note and a warning", async ({ page }) => {
  await page.goto(capped(3));
  await settle(page);

  const input = page.getByTestId("input-height");
  await expect(input).toHaveValue("4.2");
  await expect(input).toHaveAttribute("min", "4.2");
  await expect(page.getByTestId("height-raised-note")).toContainText("Minimum for this cable: 4.2 mm. Your value was raised to it.");
  await expect(page.getByTestId("warnings").locator("li", { hasText: /height raised/i })).toHaveAttribute("data-severity", "note");

  const built = Number((await page.getByTestId("height").textContent())?.match(/([\d.]+)/)?.[1]);
  expect(Math.abs(built - 4.2)).toBeLessThan(1);
});

test("typing a height below the minimum clamps it to the minimum", async ({ page }) => {
  await page.goto(capped(12));
  await settle(page);

  const input = page.getByTestId("input-height");
  await input.fill("1");
  await input.blur();
  await expect(input).toHaveValue("4.2");
  await expect(input).toHaveAttribute("min", "4.2");
  await expect.poll(() => decodeHashDoc(page.url()).h).toBe(4.2);
  await expect(page.getByTestId("height-raised-note")).toHaveCount(0);
});

test("a locked height falls below a floor that rises with a thicker cable, then clears when it drops back", async ({ page }) => {
  await page.goto(capped(6));
  await settle(page);
  await expect(page.getByTestId("input-height")).toHaveValue("6");
  await expect(page.getByTestId("height-raised-note")).toHaveCount(0);

  const diameter = page.getByTestId("input-wireDiameter");
  await diameter.fill("8");
  await diameter.blur();
  await expect(page.getByTestId("input-height")).toHaveValue("8.4");
  await expect(page.getByTestId("input-height")).toHaveAttribute("min", "8.4");
  await expect(page.getByTestId("height-raised-note")).toBeVisible();

  await diameter.fill("3.8");
  await diameter.blur();
  await expect(page.getByTestId("input-height")).toHaveValue("6");
  await expect(page.getByTestId("height-raised-note")).toHaveCount(0);
});

test("the default design shows no height note and a minimum above 20 mm", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await expect(page.getByTestId("height-raised-note")).toHaveCount(0);
  expect(Number(await page.getByTestId("input-height").getAttribute("min"))).toBeGreaterThanOrEqual(20);
});
