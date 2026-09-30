import { expect, test } from "@playwright/test";

// Issue #134: "with the square or triangle shape corner radius after some
// point doesn't change anything and makes it look like a circle -- is there
// a way to calculate in advance the radius so that we can stop right before
// going to look like the circle?"
//
// The corner-radius slider used to run all the way up to a fixed 250mm (or,
// once a corner radius that big was actually reached, the solver's own
// internal clamp -- literally `outerSize/2`, an EXACT circle). Either way, a
// long stretch of the slider's own range changed nothing anyone would
// notice well before that point. `Solution.cornerRadiusRange[1]`
// (solve.ts's `usefulMaxCornerRadius`) is now the largest corner radius
// that keeps the straight flats meaningfully long (the SAME "flat >= max(2
// wire diameters, 15% of perimeter)" criterion issue #54 already uses on
// the minimum core-size side) -- the slider's own max, mirroring
// `core-size-floor.spec.ts`'s coverage of the MIN side (issue #105 AC #4).

// shape=sq, outer size locked at 100mm, layers locked at 1 (default USB
// cable, 2000mm x 3.8mm): comfortably above `minOuterSizeForShapeFlats` for
// this wire (no "core size raised" side effect), so `cornerRadiusRange`
// reflects a plain, un-raised 100mm core.
const SQUARE_100 = "/#v=1&shape=sq&lock=outer,ly&size=100";

test("the corner-radius slider's max is well short of a literal circle (outerSize/2), for a rounded square", async ({ page }) => {
  await page.goto(SQUARE_100);
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();

  const cornerInput = page.getByTestId("input-shapeCornerRadius");
  const max = Number(await cornerInput.getAttribute("max"));
  // Half of 100mm -- the old, literal-circle ceiling.
  expect(max).toBeGreaterThan(0);
  expect(max).toBeLessThan(50);
});

test("dragging/typing the corner radius above the useful max clamps it right back down, immediately (issue #134)", async ({ page }) => {
  await page.goto(SQUARE_100);
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();

  const cornerInput = page.getByTestId("input-shapeCornerRadius");
  const max = Number(await cornerInput.getAttribute("max"));

  await cornerInput.fill("49"); // comfortably inside the OLD outerSize/2 ceiling, but past the new useful max
  await cornerInput.blur();
  await expect(async () => {
    expect(Number(await cornerInput.inputValue())).toBeLessThanOrEqual(max);
  }).toPass();
  expect(Number(await cornerInput.inputValue())).toBe(max);
});

test("a shared link requesting a corner radius above the useful max loads clamped, with a warning explaining why (issue #134)", async ({ page }) => {
  // 49mm: within the OLD `outerSize/2` ceiling (50mm) -- so this link used
  // to be honored as-is, right up against a near-exact circle -- but past
  // the new useful max.
  await page.goto("/#v=1&shape=sq&sq.rc=49&lock=outer,ly&size=100");
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();

  const cornerInput = page.getByTestId("input-shapeCornerRadius");
  const max = Number(await cornerInput.getAttribute("max"));
  expect(max).toBeLessThan(49);
  await expect(async () => {
    expect(Number(await cornerInput.inputValue())).toBeCloseTo(max, 1);
  }).toPass();

  await expect(page.getByTestId("warnings")).toContainText(/clamped down/i);
  await expect(page.getByTestId("warnings")).toContainText(/still reads as a rounded square/i);
});

test("switching from sq to round drops the corner-radius max constraint entirely (no control shown)", async ({ page }) => {
  await page.goto(SQUARE_100);
  await expect(page.getByTestId("input-shapeCornerRadius")).toBeVisible();
  await page.getByTestId("shape-option-round").check();
  await expect(page.getByTestId("input-shapeCornerRadius")).toHaveCount(0);
});
