import { expect, test } from "@playwright/test";

// Issues #54/#58 (core) + this PR's own follow-up: for a square/triangle
// core, this cable's bend limit can force a bigger minimum core size than a
// round core needs (a bigger corner radius, at a fixed size, erodes the
// straight sides). The solver silently raises a locked size below that
// floor (`Solution.minOuterSizeForShape`) and warns; the UI must show the
// EFFECTIVE (raised) size somewhere visible, clamp the size slider's own
// minimum, and explain both the (i) hint and this note in plain English.

// shape=tri, rc=5, locked outer size=20mm: the default USB cable (length
// 2000mm, diameter 3.8mm) needs a bigger minimum than 20mm for a triangle
// (see test/design.test.ts's "raises a too-small locked size" case, same
// fixture).
const TOO_SMALL_TRIANGLE = "/#v=1&shape=tri&tri.rc=5&lock=outer,ly&size=20&h=40";

test("a locked size below the shape's minimum shows the EFFECTIVE (raised) size in the field itself, matching the note next to it", async ({ page }) => {
  await page.goto(TOO_SMALL_TRIANGLE);
  await expect(page.getByTestId("hash-notice")).toHaveCount(0);
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();

  // PR review: the field must show the EFFECTIVE value, not the user's own
  // too-small request -- a field reading "20mm" next to a note saying the
  // minimum is "43mm" is a contradiction, not an explanation.
  const outerInput = page.getByTestId("input-outer");
  const fieldValue = await outerInput.inputValue();
  expect(Number(fieldValue)).toBeGreaterThan(20);

  const note = page.getByTestId("core-size-raised-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText("Minimum for this");
  await expect(note).toContainText("raised to it");

  const noteText = await note.textContent();
  const builtMatch = noteText?.match(/Minimum for this .*?: ([\d.]+) mm/);
  expect(builtMatch, `expected a "Minimum for this ...: <n> mm" prefix, got: ${noteText}`).not.toBeNull();
  expect(Number(builtMatch![1])).toBeGreaterThan(20);

  // The field and the note agree on the SAME number (both read off the
  // same `outerSizeMin`) -- no more "20mm" vs "43mm" contradiction.
  expect(fieldValue).toBe(builtMatch![1]);

  // The slider's own minimum matches too, so its knob can't be dragged left
  // of the effective value either.
  await expect(outerInput).toHaveAttribute("min", fieldValue);

  // The Result panel's own "Outer size" row is within a whole mm of the
  // field/note (both ultimately trace back to `solution.outerSize`; the
  // field rounds to the same whole/half-mm precision it always displays a
  // free/solved core size at, issue #72 AC, so it can differ from the
  // panel's own finer 1-decimal figure by a hair).
  const outerSizeRow = await page.getByTestId("outer-size").textContent();
  const panelNum = Number(outerSizeRow?.match(/([\d.]+)/)?.[1]);
  expect(Math.abs(panelNum - Number(builtMatch![1]))).toBeLessThan(1);

  // The solver's own warning is still surfaced too (core/solve.ts).
  await expect(page.getByTestId("warnings")).toContainText(/core size raised/i);
});

test("typing or dragging the locked core size below the minimum clamps it right back up, immediately", async ({ page }) => {
  await page.goto(TOO_SMALL_TRIANGLE);
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();

  const outerInput = page.getByTestId("input-outer");
  const min = Number(await outerInput.getAttribute("min"));

  // Typing a value well below the minimum is clamped back up to it, not
  // silently accepted (issue #105 PR review: "clamp it to the minimum right
  // away").
  await outerInput.fill("1");
  await outerInput.blur();
  await expect(async () => {
    expect(Number(await outerInput.inputValue())).toBeGreaterThanOrEqual(min);
  }).toPass();
  expect(Number(await outerInput.inputValue())).toBe(min);
});

test("the size slider's own minimum follows the shape's floor for sq/tri, but not for round", async ({ page }) => {
  await page.goto(TOO_SMALL_TRIANGLE);
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();

  await expect(async () => {
    const min = await page.getByTestId("input-outer").getAttribute("min");
    expect(Number(min)).toBeGreaterThan(20);
  }).toPass();

  // Switching to round drops the extra shape floor -- back to the plain 5mm minimum.
  await page.getByTestId("shape-option-round").check();
  await expect(page.getByTestId("input-outer")).toHaveAttribute("min", "5");
  await expect(page.getByTestId("core-size-raised-note")).toHaveCount(0);
});

test("the core-size (i) hint explains the shape-dependent minimum in plain English", async ({ page }) => {
  await page.goto("/");
  const field = page.locator(".field").filter({ hasText: "Core size" }).first();
  await field.getByTestId("hint-btn").hover();
  await expect(field.getByTestId("hint-bubble")).toContainText("square or triangle");
});

// Issue #105 AC #4 + PR review: the corner radius's own bend-limit floor
// gets the SAME treatment as the core size's shape floor above -- the field
// must show a value >= the floor (never a stale/shared-link request below
// it), matching the min-note, and neither the slider nor the typed number
// can be edited below it.
test("a locked corner radius below the bend-limit floor shows the EFFECTIVE (clamped) value, matching the min-note next to it", async ({ page }) => {
  await page.goto(TOO_SMALL_TRIANGLE); // tri.rc=5, well below this cable's bend-limit floor
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();

  const cornerInput = page.getByTestId("input-shapeCornerRadius");
  const fieldValue = await cornerInput.inputValue();
  expect(Number(fieldValue)).toBeGreaterThan(5);

  const minNote = page.getByTestId("shapeCornerRadius-min-note");
  await expect(minNote).toBeVisible();
  const noteText = await minNote.textContent();
  const minMatch = noteText?.match(/([\d.]+) mm/);
  expect(minMatch, `expected a "...N mm" minimum in the note, got: ${noteText}`).not.toBeNull();

  // The field and the min-note agree on the SAME number -- no more a field
  // reading "5mm" next to a note saying the minimum is "14.5mm".
  expect(fieldValue).toBe(minMatch![1]);
  await expect(cornerInput).toHaveAttribute("min", fieldValue);
});

test("typing or dragging the corner radius below the bend-limit floor clamps it right back up, immediately", async ({ page }) => {
  await page.goto(TOO_SMALL_TRIANGLE);
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();

  const cornerInput = page.getByTestId("input-shapeCornerRadius");
  const min = Number(await cornerInput.getAttribute("min"));

  await cornerInput.fill("0.5");
  await cornerInput.blur();
  await expect(async () => {
    expect(Number(await cornerInput.inputValue())).toBeGreaterThanOrEqual(min);
  }).toPass();
  expect(Number(await cornerInput.inputValue())).toBe(min);
});
