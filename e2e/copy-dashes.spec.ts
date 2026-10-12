import { expect, test, type Page } from "@playwright/test";
import { openAllNumbers } from "./advanced";
import { encodeHashDoc, withHashDoc } from "./hashDoc";
import { expectSettled } from "./settled";

// Issue #318: no `--` stands in for a dash in any text the app shows.

const DASH = "--";

const LOOSE_WINDING = encodeHashDoc({ L: 3000, d: 4, lock: ["outer"], size: 60 });
const ALL_THREE_LOCKED = encodeHashDoc({ L: 5000, d: 3.8, lock: ["outer", "h", "ly"], size: 64, h: 40, ly: 1 });
const SKADIS = encodeHashDoc({ L: 2000, d: 3.8, mount: "skadis", base: "on" });
const TWO_LAYER_CAP = encodeHashDoc({ L: 3800, d: 3.8, lock: ["outer", "h"], size: 60, h: 60, base: "on", cap: "on" });
const MALFORMED = encodeHashDoc({ v: 99 });

async function open(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await expectSettled(page);
}

async function shownText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const attributes = Array.from(document.querySelectorAll("[title], [aria-label]")).flatMap((e) => [e.getAttribute("title"), e.getAttribute("aria-label")]);
    const hints = Array.from(document.querySelectorAll('[data-testid="hint-bubble"]')).map((e) => e.textContent);
    return [document.body.innerText, ...attributes, ...hints].filter(Boolean).join("\n");
  });
}

function expectNoDash(text: string) {
  const lines = text.split("\n").filter((line) => line.includes(DASH));
  expect(lines, `lines with ${DASH}`).toEqual([]);
}

test.describe("no double-hyphen dash in shown text (issue #318)", () => {
  test("the app, with every note under All numbers and the solver line", async ({ page }) => {
    await open(page, LOOSE_WINDING);
    await openAllNumbers(page);
    await expect(page.getByTestId("warnings")).toContainText("loose winding may not fit");
    await expect(page.getByTestId("diagnosis-message")).toBeVisible();
    expectNoDash(await shownText(page));
  });

  test("the app, with the notice for a link that locks all three", async ({ page }) => {
    await page.goto(`/${ALL_THREE_LOCKED}`);
    await expect(page.getByTestId("hash-notice")).toContainText("layers was left free");
    expectNoDash(await shownText(page));
  });

  test("the app, with the notice for a link it could not read", async ({ page }) => {
    await page.goto(`/${MALFORMED}`);
    await expect(page.getByTestId("hash-notice")).toBeVisible();
    expectNoDash(await shownText(page));
  });

  test("the lock and base controls' tooltips", async ({ page }) => {
    await open(page, SKADIS);
    expectNoDash(await shownText(page));
  });

  for (const view of ["wallRoom", "mountSide", "printLayout"]) {
    test(`the ${view} view's caption`, async ({ page }) => {
      await open(page, SKADIS);
      await page.getByTestId(`preset-${view}`).click();
      await expect(page.getByTestId("wall-view-caption")).toBeVisible();
      expectNoDash(await shownText(page));
    });
  }

  for (const [name, hash] of [
    ["a two-layer coil with the base and cap", TWO_LAYER_CAP],
    ["a coil with no mount", encodeHashDoc({ L: 1000, d: 4, size: 40 })],
    ["a SKÅDIS coil", withHashDoc(SKADIS, { cap: "on" })],
    ["a SKÅDIS T-clip coil", withHashDoc(SKADIS, { mount: "skadis-tclip" })],
  ] as const) {
    test(`the guide for ${name}`, async ({ page }) => {
      await page.goto(`/${withHashDoc(hash, { ui: { view: "guide" } })}`);
      await expect(page.getByTestId("guide-view")).toBeVisible();
      expectNoDash(await shownText(page));
    });
  }
});
