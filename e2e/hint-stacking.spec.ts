import { expect, test, type Locator, type Page } from "@playwright/test";

// An open (i) hint bubble must be painted on top of everything around it --
// in particular the next viewport-toggle row, whose own box (a separate
// `z-index: 1` stacking context over the canvas) used to paint over the
// Dimensions hint's bubble on desktop. Checked with `elementFromPoint` at
// the bubble's centre: the topmost element there must be the bubble itself
// (or its text). The bubble is `pointer-events: none` (so it never swallows
// clicks), which hit-testing skips, so the check turns pointer events on
// for the bubble only for the duration of the probe -- paint order is what
// decides the answer, not the pointer-events flag.

const SKADIS = "#v=1&L=2000&d=3.8&lock=outer,ly&size=100&h=60&mount=skadis";

async function bubbleIsTopmost(bubble: Locator) {
  return bubble.evaluate((el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const was = el.style.pointerEvents;
    el.style.pointerEvents = "auto";
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    el.style.pointerEvents = was;
    return { topmost: !!hit && el.contains(hit), hit: hit ? `${hit.tagName}.${hit.className}` : "nothing" };
  });
}

async function checkEveryHint(page: Page, scope: Locator, where: string) {
  const hints = scope.locator(".hint");
  const count = await hints.count();
  expect(count, `${where} has (i) hints`).toBeGreaterThan(0);
  let checked = 0;
  for (let i = 0; i < count; i++) {
    const hint = hints.nth(i);
    const btn = hint.getByTestId("hint-btn");
    if (!(await btn.isVisible())) continue;
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    const bubble = hint.getByTestId("hint-bubble");
    await expect(bubble).toHaveAttribute("data-open", "true");
    await bubble.scrollIntoViewIfNeeded();
    const { topmost, hit } = await bubbleIsTopmost(bubble);
    expect(topmost, `${where} hint #${i} (${await bubble.textContent()}) is covered by ${hit}`).toBe(true);
    // ...and fully on screen horizontally (the top-right projection hint used to run off the right edge).
    const box = (await bubble.boundingBox())!;
    const width = page.viewportSize()!.width;
    expect(box.x, `${where} hint #${i} left edge on screen`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${where} hint #${i} right edge on screen`).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await expect(bubble).not.toHaveAttribute("data-open", "true");
    checked++;
  }
  expect(checked).toBeGreaterThan(0);
}

for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 800 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test(`${name}: every open (i) hint in the viewport overlay paints on top`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/${SKADIS}`);
    await expect(page.getByTestId("download-stl")).toBeEnabled();
    await checkEveryHint(page, page.locator(".viewer"), "viewport");
  });

  test(`${name}: every open (i) hint in the controls panel paints on top`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/${SKADIS}`);
    await expect(page.getByTestId("download-stl")).toBeEnabled();
    // Open the advanced disclosure too, so its hints are checked as well.
    for (const summary of await page.locator(".sidebar summary").all()) await summary.click();
    await checkEveryHint(page, page.locator(".sidebar"), "controls panel");
  });
}
