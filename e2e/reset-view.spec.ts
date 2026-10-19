import { expect, test, type Page } from "@playwright/test";
import { encodeHashDoc } from "./hashDoc";
import { expectSettled } from "./settled";

// Clicking the logo returns the viewer to the view of a fresh load: iso
// preset, standing view mode, orbit and zoom undone. It touches nothing else.
const DESIGN = encodeHashDoc({ L: 5000, d: 3.8, lock: ["outer", "h"], size: 60, h: 60, cap: "on" });

async function gotoDesign(page: Page) {
  await page.goto(`/${DESIGN}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expectSettled(page);
}

function viewerShot(page: Page) {
  return page.getByTestId("coil-viewer").locator("canvas").screenshot();
}

async function orbitAndZoom(page: Page) {
  const box = (await page.getByTestId("coil-viewer").locator("canvas").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy - 60, { steps: 8 });
  await page.mouse.up();
  await page.mouse.wheel(0, -300);
  await expectSettled(page);
}

async function expectSameShot(page: Page, expected: Buffer) {
  await expectSettled(page);
  expect((await viewerShot(page)).equals(expected)).toBe(true);
}

async function expectNotShot(page: Page, other: Buffer) {
  await expectSettled(page);
  expect((await viewerShot(page)).equals(other)).toBe(false);
}

async function expectIsoActive(page: Page) {
  await expect(page.getByTestId("preset-iso")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("preset-front")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("preset-printLayout")).toHaveAttribute("aria-pressed", "false");
}

async function expectResetToStart(page: Page, start: Buffer, reset: () => Promise<void>) {
  await orbitAndZoom(page);
  await expectNotShot(page, start);
  await reset();
  await expectSameShot(page, start);
}

test.use({ contextOptions: { reducedMotion: "reduce" } });

test("the logo is a button named Reset view and the heading text stays coil3d", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Reset view" })).toHaveCount(1);
  await expect(page.getByTestId("reset-view")).toBeVisible();
  await expect(page.locator("header h1")).toHaveText("coil3d");
});

test("clicking the logo undoes orbit and zoom", async ({ page }) => {
  await gotoDesign(page);
  const start = await viewerShot(page);
  const logo = page.getByTestId("reset-view");
  await expectResetToStart(page, start, () => logo.click());
});

test("clicking the logo leaves a non-iso preset and the print layout", async ({ page }) => {
  await gotoDesign(page);
  const start = await viewerShot(page);
  await page.getByTestId("preset-front").click();
  await expectNotShot(page, start);
  await page.getByTestId("preset-printLayout").click();
  await expectSettled(page);
  await expect(page.getByTestId("print-layout-parts")).toBeAttached();

  await page.getByTestId("reset-view").click();
  await expectIsoActive(page);
  await expect(page.getByTestId("print-layout-parts")).toHaveCount(0);
  await expectSameShot(page, start);
});

test("clicking the logo leaves the design, the URL and the view toggles alone", async ({ page }) => {
  await gotoDesign(page);
  await page.getByTestId("toggle-exploded").check();
  await page.getByTestId("toggle-projection").check();
  const input = page.getByTestId("input-wireLength");
  await input.fill("350");
  await input.blur();
  await expect.poll(() => page.url()).toContain("#s=");
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await expectSettled(page);
  const urlBefore = page.url();
  const start = await viewerShot(page);
  await orbitAndZoom(page);

  await page.getByTestId("reset-view").click();
  await expectSettled(page);

  await expectSameShot(page, start);
  expect(page.url()).toBe(urlBefore);
  await expect(page.getByTestId("toggle-exploded")).toBeChecked();
  await expect(page.getByTestId("toggle-projection")).toBeChecked();
  await expect(input).toHaveValue("350");
});

test("the logo resets the view from the keyboard", async ({ page }) => {
  await gotoDesign(page);
  const start = await viewerShot(page);
  const logo = page.getByTestId("reset-view");
  await expectResetToStart(page, start, async () => {
    await logo.focus();
    await page.keyboard.press("Enter");
  });
});

test("the logo is the first tab stop with a focus ring and a pointer cursor", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const logo = page.getByTestId("reset-view");
  await expect(logo).toBeFocused();
  expect(await logo.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
  expect(await logo.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
});
