import { expect, test } from "@playwright/test";

// The favicon is the coil logo (an upright coil, cable ends at 1/3 and 2/3
// height) as a bare mark: black in light mode, white in dark mode. The header
// shows the same mark before the title.
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

const LOGO_PATHS = [
  "M3.5 3.5H12.5M3 12.5H13",
  "M5.5 3.5V12.5M10.5 3.5V12.5",
  "M5.5 6.5H10.5M5.5 9.5H10.5",
  "M10.5 6.5H14.5M5.5 9.5H1.5",
];

test("the favicon is the coil logo, dark-mode aware", async ({ page }) => {
  const svg = await (await page.request.get("/favicon.svg")).text();
  const paths = [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  expect(paths).toEqual(LOGO_PATHS);
  expect(svg).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{[^}]*stroke:\s*#fff/);
  expect(svg).toMatch(/stroke:\s*#000/);
});

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 400, height: 800 },
];

for (const { name, width, height } of VIEWPORTS) {
  test(`the header mark sits on the baseline and is as tall as the x-height (${name})`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    const h1 = page.locator("header h1");
    await expect(h1).toHaveText("coil3d");
    await expect(h1.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    expect(await page.evaluate(() => document.fonts.check("800 16px Kanit"))).toBe(true);

    const m = await page.evaluate(() => {
      const el = document.querySelector("header h1")!;
      const cs = getComputedStyle(el);
      const probe = document.createElement("span");
      probe.style.cssText = "display:inline-block;width:0;height:0";
      el.appendChild(probe);
      const baseline = probe.getBoundingClientRect().bottom;
      probe.remove();
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const xHeight = ctx.measureText("x").actualBoundingBoxAscent;
      const svg = el.querySelector("svg")!.getBoundingClientRect();
      return { baseline, xHeight, bottom: svg.bottom, height: svg.height };
    });
    expect(Math.abs(m.bottom - m.baseline), "mark bottom vs baseline, px").toBeLessThanOrEqual(1);
    expect(Math.abs(m.height - m.xHeight), "mark height vs x-height, px").toBeLessThanOrEqual(1);
  });
}
