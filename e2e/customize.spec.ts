import { expect, test, type Page } from "@playwright/test";
import { cancelCustomize, openCustomize, saveCustomize, switchFace } from "./customize";
import { hoverHint } from "./hint";
import { decodeHashDoc, encodeHashDoc, withHashDoc } from "./hashDoc";
import { expectSettled } from "./settled";

// End-to-end checks for the Customize view (issue #385, part 2 of #382): the
// row and summary in the main form, the locked cap or base view, the draft that
// only reaches the hash on Save, and the way back to the previous view.

// Six layers on a 30 mm core, so the cap has room for a label.
const CAP_AND_BASE = encodeHashDoc({ L: 10000, d: 3.8, lock: ["outer", "h"], size: 30, h: 60, base: "on", cap: "on" });
const CAP_ONLY = encodeHashDoc({ L: 10000, d: 3.8, lock: ["outer", "h"], size: 30, h: 60, cap: "on" });
const BASE_ONLY = encodeHashDoc({ L: 10000, d: 3.8, lock: ["outer", "h"], size: 30, h: 60, base: "on" });
const SQUARE = encodeHashDoc({ L: 4000, d: 3.8, size: 60, shape: "sq", rc: 10, ly: 3, base: "on", cap: "on" });
const THROUGH_HOLES = encodeHashDoc({ size: 38, cap: "on", mount: "through", strap: true });
const SKADIS = encodeHashDoc({ L: 2000, d: 3.8, size: 100, h: 60, mount: "skadis", cap: "on" });

const canvasOf = (page: Page) => page.getByTestId("coil-viewer").locator("canvas");

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(canvasOf(page)).toBeVisible();
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expectSettled(page);
}

async function dragAcross(page: Page) {
  const box = (await canvasOf(page).boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 160, y - 90, { steps: 10 });
  await page.mouse.up();
  await expectSettled(page);
}

const NOTHING_ADDED = "Nothing added";

test.describe("the Cap & base row and its summary", () => {
  const summaryOf = (page: Page) => page.getByTestId("customize-summary");
  const buttonOf = (page: Page) => page.getByTestId("customize-open");

  test("with nothing set the summary says so and the button offers Customize", async ({ page }) => {
    await gotoDesign(page, CAP_AND_BASE);
    await expect(buttonOf(page)).toBeEnabled();
    await expect(buttonOf(page)).toHaveText("Customize");
    await expect(summaryOf(page)).toHaveText(NOTHING_ADDED);
  });

  test("a label alone is summarised, and the button reads Edit", async ({ page }) => {
    await gotoDesign(page, withHashDoc(CAP_AND_BASE, { label: "USB-C 2m" }));
    await expect(summaryOf(page)).toHaveText("Label \u201cUSB-C 2m\u201d");
    await expect(buttonOf(page)).toHaveText("Edit");
  });

  test("strap slots alone are summarised, and the button reads Edit", async ({ page }) => {
    await gotoDesign(page, withHashDoc(CAP_AND_BASE, { strap: true }));
    await expect(summaryOf(page)).toHaveText("strap slots");
    await expect(buttonOf(page)).toHaveText("Edit");
  });

  test("a label and strap slots are joined with a middle dot", async ({ page }) => {
    await gotoDesign(page, withHashDoc(CAP_AND_BASE, { label: "USB-C 2m", strap: true }));
    await expect(summaryOf(page)).toHaveText("Label \u201cUSB-C 2m\u201d \u00b7 strap slots");
    await expect(buttonOf(page)).toHaveText("Edit");
  });

  test("a label that is only blanks counts as no label", async ({ page }) => {
    await gotoDesign(page, withHashDoc(CAP_AND_BASE, { label: "   " }));
    await expect(summaryOf(page)).toHaveText(NOTHING_ADDED);
    await expect(buttonOf(page)).toHaveText("Customize");
  });

  for (const width of [1280, 390]) {
    test(`a long label is cut with an ellipsis on one line at ${width} px, and its full text is the tooltip`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const long = "MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM";
      await gotoDesign(page, withHashDoc(CAP_AND_BASE, { label: long, strap: true }));
      const summary = summaryOf(page);
      await expect(summary).toHaveAttribute("title", `Label \u201c${long}\u201d \u00b7 strap slots`);
      const metrics = await summary.evaluate((el) => {
        const style = getComputedStyle(el);
        const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
        return {
          truncated: el.scrollWidth > el.clientWidth,
          ellipsis: style.textOverflow === "ellipsis",
          lines: Math.round(el.getBoundingClientRect().height / lineHeight),
          rowFits: el.parentElement!.scrollWidth <= el.parentElement!.clientWidth,
        };
      });
      expect(metrics).toEqual({ truncated: true, ellipsis: true, lines: 1, rowFits: true });
    });
  }

  test("Save updates the summary and the button", async ({ page }) => {
    await gotoDesign(page, CAP_AND_BASE);
    await openCustomize(page);
    await page.getByTestId("label-enabled").check();
    await page.getByTestId("input-label").fill("USB-C");
    await page.getByTestId("strap-slots").check();
    await saveCustomize(page);
    await expect(summaryOf(page)).toHaveText("Label \u201cUSB-C\u201d \u00b7 strap slots");
    await expect(buttonOf(page)).toHaveText("Edit");

    await openCustomize(page);
    await page.getByTestId("label-enabled").uncheck();
    await page.getByTestId("strap-slots").uncheck();
    await saveCustomize(page);
    await expect(summaryOf(page)).toHaveText(NOTHING_ADDED);
    await expect(buttonOf(page)).toHaveText("Customize");
  });

  test("Cancel leaves the summary and the button as they were", async ({ page }) => {
    await gotoDesign(page, withHashDoc(CAP_AND_BASE, { label: "USB-C" }));
    await openCustomize(page);
    await page.getByTestId("input-label").fill("Changed");
    await page.getByTestId("strap-slots").check();
    await cancelCustomize(page);
    await expect(summaryOf(page)).toHaveText("Label \u201cUSB-C\u201d");
    await expect(buttonOf(page)).toHaveText("Edit");

    await page.goto("about:blank");
    await gotoDesign(page, CAP_AND_BASE);
    await openCustomize(page);
    await page.getByTestId("strap-slots").check();
    await cancelCustomize(page);
    await expect(summaryOf(page)).toHaveText(NOTHING_ADDED);
    await expect(buttonOf(page)).toHaveText("Customize");
  });

  for (const [name, size] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 390, height: 844 }]] as const) {
    test(`the button text and the summary fit their boxes with room to spare at ${name} width`, async ({ page }) => {
      await page.setViewportSize(size);
      const widths: number[] = [];
      for (const doc of [CAP_AND_BASE, withHashDoc(CAP_AND_BASE, { label: "USB-C 2m", strap: true })]) {
        await gotoDesign(page, doc);
        const fit = await page.evaluate(() => {
          const button = document.querySelector<HTMLElement>('[data-testid="customize-open"]')!;
          const summary = document.querySelector<HTMLElement>('[data-testid="customize-summary"]')!;
          const range = document.createRange();
          range.selectNodeContents(button);
          const style = getComputedStyle(button);
          const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
          return {
            buttonFits: button.scrollWidth <= button.clientWidth,
            summaryFits: summary.scrollWidth <= summary.clientWidth,
            spare: button.clientWidth - padding - range.getBoundingClientRect().width,
            width: button.getBoundingClientRect().width,
          };
        });
        expect(fit.buttonFits).toBe(true);
        expect(fit.summaryFits).toBe(true);
        expect(fit.spare, "the button text keeps at least 12 px of room").toBeGreaterThanOrEqual(12);
        widths.push(fit.width);
        await page.goto("about:blank");
      }
      expect(widths[0], "the button keeps its width between Customize and Edit").toBe(widths[1]);
    });
  }

  test("with neither a cap nor a base the button is disabled and its hint says why", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("download-stl")).toBeEnabled();
    await expect(page.getByTestId("customize-open")).toBeDisabled();
    const field = page.locator(".field").filter({ has: page.getByTestId("customize-open") });
    await hoverHint(page, field.getByTestId("hint-btn"));
    await expect(field.getByTestId("hint-bubble")).toContainText(/turn on the top cap or the base/i);
  });

  test("the button is enabled with only a base, or only a cap", async ({ page }) => {
    await gotoDesign(page, BASE_ONLY);
    await expect(page.getByTestId("customize-open")).toBeEnabled();
    await page.goto("about:blank");
    await gotoDesign(page, CAP_ONLY);
    await expect(page.getByTestId("customize-open")).toBeEnabled();
  });
});

test.describe("the locked view", () => {
  test("rotation and pan are off while the panel is open, zoom still works, and rotation is back afterwards", async ({ page }) => {
    await gotoDesign(page, CAP_AND_BASE);
    await openCustomize(page);
    const before = await canvasOf(page).screenshot();

    await dragAcross(page);
    expect((await canvasOf(page).screenshot()).equals(before), "a drag must not move the locked view").toBe(true);

    await page.mouse.wheel(0, -300);
    await expectSettled(page);
    expect((await canvasOf(page).screenshot()).equals(before), "zoom must still work").toBe(false);

    await cancelCustomize(page);
    await expect(page.getByTestId("preset-iso")).toHaveAttribute("aria-pressed", "true");
    const unlocked = await canvasOf(page).screenshot();
    await dragAcross(page);
    expect((await canvasOf(page).screenshot()).equals(unlocked), "a drag rotates the view again once Customize is closed").toBe(false);
  });

  test("the preset bar and the viewport toggles give way to the Cap / Base toggle", async ({ page }) => {
    await gotoDesign(page, CAP_AND_BASE);
    await expect(page.getByTestId("preset-iso")).toBeVisible();
    await openCustomize(page);
    await expect(page.getByTestId("preset-iso")).toHaveCount(0);
    await expect(page.getByTestId("viewport-toggles")).toHaveCount(0);
    await expect(page.getByTestId("dimensions")).toHaveCount(0);
    await expect(page.getByTestId("customize-face-cap")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("customize-face-base")).toHaveAttribute("aria-pressed", "false");
  });

  test("it starts on the cap when there is one, and the toggle switches the face and what the panel offers", async ({ page }) => {
    await gotoDesign(page, CAP_AND_BASE);
    await openCustomize(page);
    await expect(page.getByTestId("customize-panel")).toHaveAttribute("data-face", "cap");
    await expect(page.getByTestId("label-enabled")).toBeVisible();
    await expect(page.getByTestId("strap-slots")).toBeVisible();

    const capView = await canvasOf(page).screenshot();
    await switchFace(page, "base");
    await expect(page.getByTestId("customize-face-base")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("label-enabled")).toHaveCount(0);
    await expect(page.getByTestId("strap-slots")).toBeVisible();
    expect((await canvasOf(page).screenshot()).equals(capView), "the base is seen from the other side").toBe(false);

    await switchFace(page, "cap");
    await expect(page.getByTestId("label-enabled")).toBeVisible();
    expect((await canvasOf(page).screenshot()).equals(capView)).toBe(true);
  });

  test("the strap slots are one setting for both faces, and the panel says so", async ({ page }) => {
    await gotoDesign(page, CAP_AND_BASE);
    await openCustomize(page);
    await expect(page.getByTestId("strap-slots-scope")).toContainText(/cap and the base/i);
    await page.getByTestId("strap-slots").check();
    await switchFace(page, "base");
    await expect(page.getByTestId("strap-slots")).toBeChecked();
  });

  test("with only a base the toggle offers only the base, and with only a cap only the cap", async ({ page }) => {
    await gotoDesign(page, BASE_ONLY);
    await openCustomize(page);
    await expect(page.getByTestId("customize-panel")).toHaveAttribute("data-face", "base");
    await expect(page.getByTestId("customize-face-base")).toBeVisible();
    await expect(page.getByTestId("customize-face-cap")).toHaveCount(0);

    await page.goto("about:blank");
    await gotoDesign(page, CAP_ONLY);
    await openCustomize(page);
    await expect(page.getByTestId("customize-panel")).toHaveAttribute("data-face", "cap");
    await expect(page.getByTestId("customize-face-cap")).toBeVisible();
    await expect(page.getByTestId("customize-face-base")).toHaveCount(0);
  });
});

test.describe("the draft, Save and Cancel", () => {
  test("edits preview live but stay out of the hash until Save", async ({ page }) => {
    await gotoDesign(page, SQUARE);
    await openCustomize(page);
    const plain = await canvasOf(page).screenshot();
    const hashBefore = new URL(page.url()).hash;

    await page.getByTestId("strap-slots").check();
    await page.getByTestId("label-enabled").check();
    await page.getByTestId("input-label").fill("USB-C");
    await expect(page.getByTestId("customize-panel")).toHaveAttribute("data-final-ready", "true");
    await expectSettled(page);
    expect((await canvasOf(page).screenshot()).equals(plain), "the preview follows the draft").toBe(false);
    expect(new URL(page.url()).hash).toBe(hashBefore);

    await saveCustomize(page);
    await expect(async () => {
      const doc = decodeHashDoc(page.url());
      expect(doc.strap).toBe(true);
      expect(doc.label).toBe("USB-C");
    }).toPass();
    await expect(page.getByTestId("customize-open")).toBeVisible();
    await expect(page.getByTestId("preset-iso")).toHaveAttribute("aria-pressed", "true");
  });

  for (const leave of ["Cancel", "Escape"] as const) {
    test(`${leave} drops the edits and brings back the preset, the projection and the exploded view`, async ({ page }) => {
      await gotoDesign(page, SQUARE);
      await page.getByTestId("preset-front").click();
      await page.getByTestId("toggle-exploded").check();
      await page.getByTestId("toggle-projection").check();
      await expectSettled(page);
      const hashBefore = new URL(page.url()).hash;

      await openCustomize(page);
      await page.getByTestId("strap-slots").check();
      await page.getByTestId("label-enabled").check();
      await page.getByTestId("input-label").fill("USB-C");
      if (leave === "Cancel") await page.getByTestId("customize-cancel").click();
      else await page.keyboard.press("Escape");
      await expect(page.getByTestId("customize-panel")).toHaveCount(0);

      expect(new URL(page.url()).hash).toBe(hashBefore);
      await expect(page.getByTestId("customize-summary")).toHaveText(NOTHING_ADDED);
      await expect(page.getByTestId("preset-front")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("toggle-exploded")).toBeChecked();
      await expect(page.getByTestId("toggle-projection")).toBeChecked();

      await expect(page.getByTestId("download-stl")).toBeEnabled();
      await openCustomize(page);
      await expect(page.getByTestId("strap-slots")).not.toBeChecked();
      await expect(page.getByTestId("label-enabled")).not.toBeChecked();
    });
  }

  test("Save brings back the preset, the projection and the exploded view too", async ({ page }) => {
    await gotoDesign(page, SQUARE);
    await page.getByTestId("preset-front").click();
    await page.getByTestId("toggle-exploded").check();
    await page.getByTestId("toggle-projection").check();
    await expectSettled(page);

    await openCustomize(page);
    await page.getByTestId("strap-slots").check();
    await saveCustomize(page);
    await expect(page.getByTestId("preset-front")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("toggle-exploded")).toBeChecked();
    await expect(page.getByTestId("toggle-projection")).toBeChecked();
  });

  test("Escape during an IME composition does not close the panel", async ({ page }) => {
    await gotoDesign(page, CAP_AND_BASE);
    await openCustomize(page);
    await page.getByTestId("label-enabled").check();
    await page.getByTestId("input-label").focus();
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true })));
    await expect(page.getByTestId("customize-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("customize-panel")).toHaveCount(0);
  });

  test("Escape closes an open (i) hint first and leaves the panel open", async ({ page }) => {
    await gotoDesign(page, CAP_AND_BASE);
    await openCustomize(page);
    const hint = page.getByTestId("customize-panel").getByTestId("hint-btn").first();
    await hint.click();
    await expect(hint).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(hint).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("customize-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("customize-panel")).toHaveCount(0);
  });

  test("the logo leaves Customize as Cancel would", async ({ page }) => {
    await gotoDesign(page, CAP_AND_BASE);
    await openCustomize(page);
    await page.getByTestId("strap-slots").check();
    await page.getByTestId("reset-view").click();
    await expect(page.getByTestId("customize-panel")).toHaveCount(0);
    await expect(page.getByTestId("preset-iso")).toHaveAttribute("aria-pressed", "true");
    expect(decodeHashDoc(page.url()).strap).toBeUndefined();
  });

  test("a wall-mount design comes back to its mount side view", async ({ page }) => {
    await gotoDesign(page, SKADIS);
    await page.getByTestId("preset-mountSide").click();
    await expectSettled(page);
    await expect(page.getByTestId("wall-view-caption")).toBeVisible();

    await openCustomize(page, "base");
    await expect(page.getByTestId("wall-view-caption")).toHaveCount(0);
    await cancelCustomize(page);
    await expect(page.getByTestId("preset-mountSide")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("wall-view-caption")).toBeVisible();
  });
});

test.describe("leaving Customize needs no rebuild", () => {
  // Counts and, once held, swallows every message sent to the geometry
  // worker, so a design shown after Cancel or Save can only come from the
  // cache, not from a new solve that happens to finish in time.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __hold: boolean; __held: number };
      w.__hold = false;
      w.__held = 0;
      const send = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
        if (w.__hold) w.__held++;
        else (send as (...a: unknown[]) => void).apply(this, args);
      } as typeof Worker.prototype.postMessage;
    });
  });

  // The flag is still true for a moment after an edit, so wait for it to drop
  // (the debounce keeps it down for 300 ms) and come back.
  async function settleDraft(page: Page) {
    const panel = page.getByTestId("customize-panel");
    await expect(panel).toHaveAttribute("data-final-ready", "false");
    await expect(panel).toHaveAttribute("data-final-ready", "true");
  }

  const holdWorker = (page: Page) => page.evaluate(() => ((window as unknown as { __hold: boolean }).__hold = true));
  const heldRequests = (page: Page) => page.evaluate(() => (window as unknown as { __held: number }).__held);

  test("Cancel shows the committed design again at once, without asking the worker", async ({ page }) => {
    await gotoDesign(page, SQUARE);
    const committed = await page.getByTestId("mesh-detail").textContent();

    await openCustomize(page);
    await page.getByTestId("strap-slots").check();
    await settleDraft(page);
    await holdWorker(page);
    await page.getByTestId("customize-cancel").click();

    await expect(page.getByTestId("download-stl")).toBeEnabled();
    await expect(page.getByTestId("mesh-detail")).toHaveText(committed!);
    expect(await heldRequests(page)).toBe(0);
  });

  test("Save keeps the draft's final design, without asking the worker", async ({ page }) => {
    await gotoDesign(page, SQUARE);
    const committed = await page.getByTestId("mesh-detail").textContent();

    await openCustomize(page);
    await page.getByTestId("strap-slots").check();
    await settleDraft(page);
    await holdWorker(page);
    await saveCustomize(page);

    await expect(page.getByTestId("download-stl")).toBeEnabled();
    await expect(page.getByTestId("mesh-detail")).not.toHaveText(committed!);
    expect(await heldRequests(page)).toBe(0);
  });

  test("Cancel after several draft edits still finds the committed design", async ({ page }) => {
    await gotoDesign(page, SQUARE);
    const committed = await page.getByTestId("mesh-detail").textContent();

    await openCustomize(page);
    for (const label of ["A", "AB", "ABC"]) {
      await page.getByTestId("label-enabled").check();
      await page.getByTestId("input-label").fill(label);
      await settleDraft(page);
    }
    await holdWorker(page);
    await page.getByTestId("customize-cancel").click();

    await expect(page.getByTestId("download-stl")).toBeEnabled();
    await expect(page.getByTestId("mesh-detail")).toHaveText(committed!);
    expect(await heldRequests(page)).toBe(0);
  });
});

test.describe("with real motion", () => {
  test.use({ contextOptions: { reducedMotion: "no-preference" } });

  test("the camera turns to the face, settles, and stays locked", async ({ page }) => {
    await gotoDesign(page, CAP_AND_BASE);
    await page.getByTestId("customize-open").click();
    await expect(page.getByTestId("customize-panel")).toHaveAttribute("data-final-ready", "true");
    await expectSettled(page);
    const settled = await canvasOf(page).screenshot();
    await dragAcross(page);
    expect((await canvasOf(page).screenshot()).equals(settled)).toBe(true);

    await cancelCustomize(page);
    await expectSettled(page);
    await expect(page.getByTestId("preset-iso")).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("customize screenshots", () => {
  test("the cap from above, with a label and strap slots", async ({ page }) => {
    await gotoDesign(page, withHashDoc(SQUARE, { label: "USB-C 2m", strap: true }));
    await openCustomize(page);
    await expect(canvasOf(page)).toHaveScreenshot("customize-cap-label-strap.png");
  });

  test("the base from below, with strap slots and a through mount", async ({ page }) => {
    await gotoDesign(page, THROUGH_HOLES);
    await openCustomize(page, "base");
    await expect(canvasOf(page)).toHaveScreenshot("customize-base-strap-through.png");
  });

  test("the panel at phone width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoDesign(page, withHashDoc(SQUARE, { label: "USB-C 2m", strap: true }));
    await openCustomize(page);
    await page.evaluate(() => document.fonts.ready);
    await expectSettled(page);
    await expect(page).toHaveScreenshot("customize-phone.png", { fullPage: true });
  });

  test("the Cap & base row with its summary and Edit", async ({ page }) => {
    await gotoDesign(page, withHashDoc(SQUARE, { label: "USB-C 2m", strap: true }));
    const section = page.locator("section.ctl-section").filter({ has: page.getByTestId("customize-open") });
    await expect(section).toHaveScreenshot("customize-form-summary.png");
  });
});
