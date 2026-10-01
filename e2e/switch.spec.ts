import { expect, test, type Page } from "@playwright/test";

// End-to-end checks for issue #104 (switch polish): the shared pill
// {@link Switch} (src/components/fields.tsx) redesigned so its knob is
// exactly centred in the track at every size, its "0"/"I" state indicator
// (or the lock toggle's open/closed padlock icon) lives in the track's own
// free space rather than riding the knob, and the perspective toggle became
// a two-sided switch with no internal indicator at all. Screenshot-based
// review of the redesign lives in the PR description; this file is the
// AC's own automated check: "the knob is centred (Playwright bbox check:
// knob centre y = track centre y ± 0.5 px)".

const TWO_LAYER = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2";

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await page.waitForTimeout(500);
}

/** The absolute difference between a switch's knob centre and its own
 * track's centre, in CSS px -- both located off the checkbox input's own
 * `data-testid` via its DOM siblings (`.switch-track` containing
 * `.switch-knob`), never a testid of their own since they're purely
 * decorative (`aria-hidden`). */
async function knobCenterOffsetY(page: Page, testId: string): Promise<number> {
  const track = page.locator(`[data-testid="${testId}"] ~ .switch-track`);
  const knob = track.locator(".switch-knob");
  const trackBox = (await track.boundingBox())!;
  const knobBox = (await knob.boundingBox())!;
  const trackCenterY = trackBox.y + trackBox.height / 2;
  const knobCenterY = knobBox.y + knobBox.height / 2;
  return Math.abs(knobCenterY - trackCenterY);
}

for (const viewport of [
  { label: "desktop", width: 1280, height: 900 },
  { label: "phone", width: 390, height: 844 },
] as const) {
  test.describe(`knob centring (issue #104) -- ${viewport.label}`, () => {
    test.use({ viewport });

    test("every switch's knob is vertically centred in its track, both checked and unchecked", async ({ page }) => {
      await gotoDesign(page, TWO_LAYER);

      // A representative switch of each kind (an eye toggle, a lock toggle,
      // the two-sided projection toggle), each in both states -- the knob's
      // own CSS (`top: 50%` + `translateY(-50%)`) doesn't depend on checked
      // state or which content variant the track carries, but this proves
      // it holds for all of them, not just one lucky case.
      for (const testId of ["toggle-wire", "lock-height", "toggle-projection"]) {
        const before = await knobCenterOffsetY(page, testId);
        expect(before, `${testId} centred before toggling`).toBeLessThanOrEqual(0.5);

        await page.getByTestId(testId).click();
        const after = await knobCenterOffsetY(page, testId);
        expect(after, `${testId} centred after toggling`).toBeLessThanOrEqual(0.5);
      }
    });
  });
}

test.describe("lock icon and borderless overlay toggles (issue #104)", () => {
  test("the lock toggle is a plain toggle: no padlock or digit inside its track", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
    await expect(page.getByTestId("download-stl")).toBeEnabled();

    for (const testId of ["lock-outer", "lock-height", "lock-layers"]) {
      await expect(page.locator(`[data-testid="${testId}"] ~ .switch-track .lock-icon`)).toHaveCount(0);
      await expect(page.locator(`[data-testid="${testId}"] ~ .switch-track .switch-state`)).toHaveCount(0);
    }
  });

  test("the viewport overlay toggles have no border box", async ({ page }) => {
    await gotoDesign(page, TWO_LAYER);
    for (const selector of [".wire-toggle", ".dimensions-toggle", ".explode-toggle", ".projection-toggle-box"]) {
      const borderWidth = await page.locator(selector).evaluate((el) => getComputedStyle(el).borderTopWidth);
      expect(borderWidth, `${selector} has no border`).toBe("0px");
    }
  });

  test("the perspective toggle shows both side labels and no internal 0/I", async ({ page }) => {
    await gotoDesign(page, TWO_LAYER);
    await expect(page.locator(".two-sided-toggle-text").first()).toHaveText("Isometric");
    await expect(page.locator(".two-sided-toggle-text").last()).toHaveText("Perspective");
    await expect(page.locator('[data-testid="toggle-projection"] ~ .switch-track .switch-state')).toHaveCount(0);
  });
});
