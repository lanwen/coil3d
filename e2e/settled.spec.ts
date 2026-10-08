import { expect, test, type Page } from "@playwright/test";
import { encodeHashDoc } from "./hashDoc";
import { expectSettled } from "./settled";

const TWO_LAYER = encodeHashDoc({ L: 5000, d: 3.8, lock: ["outer", "h"], size: 60, h: 60, base: "on", cap: "on" });

async function recordSettledChanges(page: Page) {
  await page.addInitScript(() => {
    const changes: (string | null)[] = [];
    (window as unknown as { __settledChanges: (string | null)[] }).__settledChanges = changes;
    new MutationObserver((records) => {
      for (const record of records) changes.push((record.target as HTMLElement).getAttribute("data-settled"));
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-settled"] });
  });
}

async function takeChanges(page: Page): Promise<(string | null)[]> {
  return page.evaluate(() => (window as unknown as { __settledChanges: (string | null)[] }).__settledChanges.splice(0));
}

test("every change that redraws the viewer clears the signal, and it returns once the frames are done", async ({ page }) => {
  await recordSettledChanges(page);
  await page.goto(`/${TWO_LAYER}`);
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await expectSettled(page);
  const canvas = page.getByTestId("coil-viewer").locator("canvas");
  const box = (await canvas.boundingBox())!;

  const changes: Record<string, () => Promise<void>> = {
    "a preset": () => page.getByTestId("preset-front").click(),
    "the exploded view": () => page.getByTestId("toggle-exploded").check(),
    "the projection": () => page.getByTestId("toggle-projection").check(),
    "the dimensions": async () => {
      await page.getByTestId("toggle-exploded").uncheck();
      await expectSettled(page);
      await takeChanges(page);
      await page.getByTestId("toggle-dimensions").uncheck();
    },
    "a zoom": async () => {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -120);
    },
  };
  for (const [name, change] of Object.entries(changes)) {
    await takeChanges(page);
    await change();
    await expectSettled(page);
    const values = await takeChanges(page);
    expect(values.at(0), `${name} clears the signal`).toBe("false");
    expect(values.at(-1), `${name} sets it again`).toBe("true");
  }
});
