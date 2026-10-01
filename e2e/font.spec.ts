import { expect, test, type Page } from "@playwright/test";
import { openAdvanced } from "./advanced";

// Issue #191: the UI font (Kanit) is served from the app's own build, with a
// metric-matched fallback, so there is no request to Google and the swap to
// Kanit does not move the layout.

test("loading and using the app makes no request to Google", async ({ page }) => {
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));

  await page.goto("/");
  await expect(page.getByTestId("hint-btn").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  // Some basic use: open a hint and the advanced settings.
  await page.getByTestId("hint-btn").first().click();
  await openAdvanced(page);
  await expect(page.getByTestId("download-stl")).toBeEnabled();

  const origin = new URL(page.url()).origin;
  const external = urls.filter((u) => u.startsWith("http") && !u.startsWith(origin));
  expect(external, "requests that left the app's own origin").toEqual([]);
  expect(urls.filter((u) => /google|gstatic/i.test(u))).toEqual([]);
  // Kanit itself came from the app, not from a CDN.
  expect(urls.some((u) => u.startsWith(`${origin}/assets/kanit-latin-700-normal-`) && u.endsWith(".woff2"))).toBe(true);
  expect(await page.evaluate(() => document.fonts.check("700 16px Kanit"))).toBe(true);
});

// Positions of every heading and (i) button, in document order.
async function boxes(page: Page): Promise<number[][]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("h1, h2, h3, [data-testid=hint-btn]")).map((e) => {
      const r = e.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    }),
  );
}

test("the swap from the fallback to Kanit moves no heading or (i) button by more than 1 px", async ({ page }) => {
  // Hold the font back until the test lets it go, so the page is laid out and
  // painted in the fallback first. `commit`, not `load`: the preloaded fonts
  // delay the load event.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\.woff2/, async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/", { waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "Export" })).toBeVisible();
  await expect(page.getByTestId("hint-btn").first()).toBeVisible();
  expect(await page.evaluate(() => document.fonts.check("700 16px Kanit")), "Kanit must still be loading").toBe(false);
  const before = await boxes(page);

  release();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check("700 16px Kanit")), "Kanit must have swapped in").toBe(true);
  const after = await boxes(page);

  expect(before.length).toBeGreaterThan(10);
  expect(after.length).toBe(before.length);
  const maxDy = Math.max(...before.map((b, i) => Math.abs(after[i][1] - b[1])));
  expect(maxDy, "largest vertical move of a heading or (i) button, in px").toBeLessThanOrEqual(1);
});
