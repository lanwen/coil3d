import { expect, test } from "@playwright/test";

// The favicon is the selected front-view preset button: the paper glyph
// knocked out of an ink pill. The SVG carries the button's own path data.
const ICONS = [
  { rel: "icon", href: "/favicon.svg", type: /^image\/svg\+xml/ },
  { rel: "icon", href: "/favicon.ico", type: /^image\/(x-icon|vnd\.microsoft\.icon)/ },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png", type: /^image\/png/ },
];

test("index.html links the favicon files and they are served", async ({ page }) => {
  await page.goto("/");
  for (const { rel, href, type } of ICONS) {
    await expect(page.locator(`link[rel="${rel}"][href="${href}"]`)).toHaveCount(1);
    const res = await page.request.get(href);
    expect(res.status(), href).toBe(200);
    expect(res.headers()["content-type"], href).toMatch(type);
    expect((await res.body()).length, href).toBeGreaterThan(100);
  }
});

test("the favicon glyph is the front-view button's glyph", async ({ page }) => {
  await page.goto("/#v=1&L=1000&d=4&size=40");
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  const button = await page
    .getByTestId("preset-front")
    .locator("path")
    .evaluateAll((paths) => paths.map((p) => p.getAttribute("d")));

  const svg = await (await page.request.get("/favicon.svg")).text();
  const favicon = [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  expect(favicon).toEqual(button);
});
