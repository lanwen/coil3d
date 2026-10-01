import { expect, test } from "@playwright/test";

// A "Licenses" link next to the author link opens the third-party notices
// that ship with the site (public/THIRD_PARTY_NOTICES.txt).
test("the licenses link opens the served third-party notices", async ({ page, context }) => {
  await page.goto("/#v=1&L=1000&d=4&size=40");
  await expect(page.getByTestId("download-stl")).toBeEnabled();

  const link = page.getByTestId("licenses-link");
  await expect(link).toHaveText("Licenses");
  await expect(link).toHaveAttribute("href", /THIRD_PARTY_NOTICES\.txt$/);
  await expect(link).toHaveAttribute("target", "_blank");

  // Sits beside the author link, inside the viewport.
  const box = (await link.boundingBox())!;
  const viewer = (await page.locator(".viewer").boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(viewer.x + viewer.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewer.y + viewer.height);

  const href = (await link.getAttribute("href"))!;
  const res = await page.request.get(href);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/^text\/plain/);
  const text = await res.text();
  expect(text).toContain("THIRD-PARTY NOTICES");
  expect(text).toContain("GNU LESSER GENERAL PUBLIC LICENSE");
  expect(text).toContain("Clipper2");

  // Clicking it opens the notices in a new tab.
  const [popup] = await Promise.all([context.waitForEvent("page"), link.click()]);
  await popup.waitForLoadState();
  expect(popup.url()).toMatch(/THIRD_PARTY_NOTICES\.txt$/);
  await expect(popup.locator("body")).toContainText("THIRD-PARTY NOTICES");
});
