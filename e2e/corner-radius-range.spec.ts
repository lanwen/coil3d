import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { hoverHint } from "./hint";

// Issue #140 ("gray out the slider ... show the max value under the slider
// end"), follow-up to #134 (corner-radius-max.spec.ts's own useful-max
// ceiling). Two things this covers:
//
// 1. When the current core size leaves NO useful room to move the corner
//    radius at all (the bend-limit floor and the useful max already
//    coincide, or round to the same 0.5mm slider step -- solve.ts's
//    `Solution.cornerRadiusRange`), the slider greys out and disables
//    instead of staying draggable over a range that can't actually change
//    anything.
// 2. The slider's own max is now also shown as a small number under its
//    right end (e.g. "max 23 mm"), and the native range thumb must never
//    visually sit on top of that number, including right at the max.

// Same boundary `core-size-floor.spec.ts`'s TOO_SMALL_TRIANGLE fixture
// hits, but for the square (issue #140's own "a small square core"): this
// cable's bend limit (default USB preset, 2000mm x 3.8mm) needs a bigger
// minimum core than 20mm for a rounded square, and the solver raises the
// locked size right up to the SAME boundary `usefulMaxCornerRadius` traces
// (solve.ts's own doc comment on `minOuterSizeForShapeFlats`/
// `usefulMaxCornerRadius` sharing one feasibility boundary) -- so the
// raised size leaves `cornerRadiusRange` a single point, not a range.
const TOO_SMALL_SQUARE = "/#v=1&shape=sq&sq.rc=5&lock=outer,ly&size=20&h=40";

// A comfortably larger square core (same fixture corner-radius-max.spec.ts
// already uses): well clear of the boundary above, so the slider has a real
// range to show a max label for and to drag across.
const SQUARE_100 = "/#v=1&shape=sq&lock=outer,ly&size=100";

function cornerRadiusSlider(page: Page): Locator {
  return page.locator('input[type="range"][aria-label="Corner radius"]');
}

/** Approximates the native range thumb's own bounding box from the track's
 * box plus its current value -- Playwright has no locator for a `<input
 * type="range">`'s pseudo-element thumb, so this reads back the exact same
 * geometry App.css gives it (18px, vertically centered) and the same
 * value/min/max -> position mapping every browser uses for a range input:
 * the thumb's center travels linearly from `thumbSize/2` in from the left
 * edge (at `min`) to `thumbSize/2` in from the right edge (at `max`), never
 * past either edge. */
async function knobBox(slider: Locator) {
  const box = (await slider.boundingBox())!;
  const [min, max, value] = await Promise.all([
    slider.getAttribute("min").then(Number),
    slider.getAttribute("max").then(Number),
    slider.inputValue().then(Number),
  ]);
  const thumbSize = 18; // App.css: .field-slider::-webkit-slider-thumb / -moz-range-thumb
  const t = max > min ? (value - min) / (max - min) : 0;
  const centerX = box.x + thumbSize / 2 + t * Math.max(0, box.width - thumbSize);
  const centerY = box.y + box.height / 2;
  return { x: centerX - thumbSize / 2, y: centerY - thumbSize / 2, width: thumbSize, height: thumbSize };
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

test("a small square core leaves no useful corner-radius range, so the slider greys out and disables", async ({ page }) => {
  await page.goto(TOO_SMALL_SQUARE);
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();

  const numberInput = page.getByTestId("input-shapeCornerRadius");
  await expect(numberInput).toBeDisabled();

  // The slider stays VISIBLE (not hidden, unlike a free/locked dimension's
  // own slider) -- just non-interactive -- so the user can still see where
  // the value sits.
  const slider = cornerRadiusSlider(page);
  await expect(slider).toBeVisible();
  await expect(slider).toBeDisabled();

  // The value itself is still shown, not blanked.
  await expect(numberInput).not.toHaveValue("");

  // The (i) hint explains why.
  const field = page.locator(".field").filter({ hasText: "Corner radius" }).first();
  await hoverHint(page, field.getByTestId("hint-btn"));
  await expect(field.getByTestId("hint-bubble")).toContainText(/too small for a larger radius/i);
});

test("a comfortably sized square core keeps the corner-radius slider enabled", async ({ page }) => {
  await page.goto(SQUARE_100);
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();

  const numberInput = page.getByTestId("input-shapeCornerRadius");
  await expect(numberInput).toBeEnabled();
  await expect(cornerRadiusSlider(page)).toBeEnabled();
});

test("the max label under the slider shows the solver's own useful max", async ({ page }) => {
  await page.goto(SQUARE_100);
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();

  const cornerInput = page.getByTestId("input-shapeCornerRadius");
  const max = await cornerInput.getAttribute("max");

  const maxLabel = page.getByTestId("shapeCornerRadius-max-label");
  await expect(maxLabel).toBeVisible();
  await expect(maxLabel).toHaveText(`max ${max} mm`);
});

test("at max, the slider knob's bounding box doesn't overlap the max label's", async ({ page }) => {
  await page.goto(SQUARE_100);
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();

  const cornerInput = page.getByTestId("input-shapeCornerRadius");
  const max = await cornerInput.getAttribute("max");
  await cornerInput.fill(max!);
  await cornerInput.blur();
  await expect(async () => {
    expect(await cornerInput.inputValue()).toBe(max);
  }).toPass();

  const slider = cornerRadiusSlider(page);
  await expect(async () => {
    expect(await slider.inputValue()).toBe(max);
  }).toPass();

  const knob = await knobBox(slider);
  const labelBox = (await page.getByTestId("shapeCornerRadius-max-label").boundingBox())!;
  expect(overlaps(knob, labelBox)).toBe(false);
});

test("at max and at phone width, the slider knob's bounding box still doesn't overlap the max label's", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SQUARE_100);
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();

  const cornerInput = page.getByTestId("input-shapeCornerRadius");
  const max = await cornerInput.getAttribute("max");
  await cornerInput.fill(max!);
  await cornerInput.blur();
  await expect(async () => {
    expect(await cornerInput.inputValue()).toBe(max);
  }).toPass();

  const slider = cornerRadiusSlider(page);
  await expect(async () => {
    expect(await slider.inputValue()).toBe(max);
  }).toPass();

  const knob = await knobBox(slider);
  const labelBox = (await page.getByTestId("shapeCornerRadius-max-label").boundingBox())!;
  expect(overlaps(knob, labelBox)).toBe(false);
});

test("the max label is opt-in: other sliders (e.g. core size) don't grow one", async ({ page }) => {
  await page.goto(SQUARE_100);
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();
  await expect(page.getByTestId("outer-max-label")).toHaveCount(0);
});
