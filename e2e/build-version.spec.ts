import { expect, test } from "@playwright/test";
import { encodeHashDoc } from "./hashDoc";

// The deployed build is shown beside the credits and served as /version.json.
// The e2e build pins its id (playwright.config.ts), so the label is stable.
const SHA = "0123456789abcdef0123456789abcdef01234567";

test("the build label shows the short SHA and links to the commit", async ({ page }) => {
  await page.goto(`/${encodeHashDoc({ L: 1000, d: 4, size: 40 })}`);
  await expect(page.getByTestId("download-stl")).toBeEnabled();

  const label = page.getByTestId("build-label");
  await expect(label).toHaveText(/^([0-9a-f]{7}|dev)$/);
  await expect(label).toHaveText("0123456");
  await expect(label).toHaveAttribute("href", `https://github.com/lanwen/coil3d/commit/${SHA}`);
  await expect(label).toHaveAttribute("aria-label", "Build 0123456");
  await expect(label).toHaveAttribute("title", "Built 2026-01-01 00:00 UTC");

  // Beside the author link, inside the viewport.
  const box = (await label.boundingBox())!;
  const author = (await page.getByTestId("author-link").boundingBox())!;
  const viewer = (await page.locator(".viewer").boundingBox())!;
  expect(box.x).toBeGreaterThan(author.x);
  expect(box.x + box.width).toBeLessThanOrEqual(viewer.x + viewer.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewer.y + viewer.height);
});

test("/version.json is served and parses", async ({ page }) => {
  const res = await page.request.get("/version.json");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({
    commit: SHA,
    short: "0123456",
    builtAt: "2026-01-01T00:00:00.000Z",
    branch: expect.any(String),
  });
});
