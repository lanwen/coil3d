import { expect, test } from "@playwright/test";

// A small "lanwen" GitHub link sits in the viewport's bottom-right corner.
test("the author link points at github.com/lanwen and sits inside the viewport", async ({ page }) => {
  await page.goto("/#v=1&L=1000&d=4&size=40");
  await expect(page.getByTestId("download-stl")).toBeEnabled();

  const link = page.getByTestId("author-link");
  await expect(link).toHaveText("lanwen");
  await expect(link).toHaveAttribute("href", "https://github.com/lanwen");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link.locator("svg")).toBeVisible();

  const box = (await link.boundingBox())!;
  const viewer = (await page.locator(".viewer").boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(viewer.x + viewer.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewer.y + viewer.height);
});
