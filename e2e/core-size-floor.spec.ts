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

test("a locked size below the shape's minimum keeps showing the user's own request in the input, but the built size (and why) shows next to it", async ({ page }) => {
  await page.goto(TOO_SMALL_TRIANGLE);
  await expect(page.getByTestId("hash-notice")).toHaveCount(0);
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();

  // The editable input never gets silently rewritten out from under the user.
  await expect(page.getByTestId("input-outer")).toHaveValue("20");

  // The effective (raised) minimum is shown plainly, in mm, as the ONE
  // number that matters (issue #105 AC #2: the old "Built at X mm, not Y
  // mm" wording repeated a rounded number, sometimes identically twice,
  // which read as a bug rather than an explanation) -- and it's bigger than
  // what was requested (20mm).
  const note = page.getByTestId("core-size-raised-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText("Minimum for this");
  await expect(note).toContainText("raised to it");

  const noteText = await note.textContent();
  const builtMatch = noteText?.match(/Minimum for this .*?: ([\d.]+) mm/);
  expect(builtMatch, `expected a "Minimum for this ...: <n> mm" prefix, got: ${noteText}`).not.toBeNull();
  expect(Number(builtMatch![1])).toBeGreaterThan(20);

  // The Result panel's own "Outer size" row agrees with the note (both read
  // off `solution.outerSize`, the one true resolved value).
  const outerSizeRow = await page.getByTestId("outer-size").textContent();
  expect(outerSizeRow).toContain(builtMatch![1]);

  // The solver's own warning is still surfaced too (core/solve.ts).
  await expect(page.getByTestId("warnings")).toContainText(/core size raised/i);
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
