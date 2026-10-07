import { expect, test } from "@playwright/test";
import { hoverHint } from "./hint";
import { encodeHashDoc } from "./hashDoc";

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
const TOO_SMALL_TRIANGLE = `/${encodeHashDoc({ shape: "tri", rc: 5, size: 20, h: 40, base: "on", cap: "on" })}`;

// Issue #140: TOO_SMALL_TRIANGLE above sits exactly on the boundary where
// the bend-limit floor and the useful max (`Solution.cornerRadiusRange`)
// coincide -- the solver raises its locked size right up to
// `minOuterSizeForShapeFlats`, the SAME size `usefulMaxCornerRadius` traces
// from the other axis (solve.ts's own doc comment on why the two never
// disagree there) -- so the corner-radius field is now disabled there (no
// useful room to move at all, corner-radius-range.spec.ts's own coverage),
// and can no longer be typed into. This fixture is the same triangle, just
// locked at a bigger 60mm (comfortably past that boundary), which still
// forces `tri.rc=5` to clamp up to the SAME bend-limit floor but leaves a
// real, enabled range above it -- so the "typing below the floor clamps
// back up" behavior below still has a field it can actually type into.
const TRIANGLE_WITH_ROOM_ABOVE_FLOOR = `/${encodeHashDoc({ shape: "tri", rc: 5, size: 60, h: 40, base: "on" })}`;

test("a locked size below the shape's minimum shows the EFFECTIVE (raised) size in the field itself, matching the note next to it", async ({ page }) => {
  await page.goto(TOO_SMALL_TRIANGLE);
  await expect(page.getByTestId("hash-notice")).toHaveCount(0);
  await expect(page.getByTestId("verdict")).toBeVisible();

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
  await expect(page.getByTestId("verdict")).toBeVisible();

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

test("the size slider's own minimum follows the shape's floor: the flats for sq/tri, the bend limit alone for round", async ({ page }) => {
  await page.goto(TOO_SMALL_TRIANGLE);
  await expect(page.getByTestId("verdict")).toBeVisible();

  let triangleMin = 0;
  await expect(async () => {
    triangleMin = Number(await page.getByTestId("input-outer").getAttribute("min"));
    expect(triangleMin).toBeGreaterThan(20);
  }).toPass();

  // Switching to round drops the extra flat-sides floor, down to the bend
  // limit's own (issue #195): 2 x (2.6 x 3.8 - 3.8/2 + 0.4 x 3.8) = 19 mm.
  // The link's locked 20 mm is above it now, so the raised note goes away.
  await page.getByTestId("shape-option-round").check();
  await expect(page.getByTestId("input-outer")).toHaveAttribute("min", "19");
  expect(19).toBeLessThan(triangleMin);
  await expect(page.getByTestId("input-outer")).toHaveValue("20");
  await expect(page.getByTestId("core-size-raised-note")).toHaveCount(0);
});

// Issue #195: a round core locked below the bend limit's floor (the default
// 30 mm core with a stiff 3.6 mm cable, whose 23.4 mm bend radius needs a
// 46.1 mm core) shows the raised size in the field, exactly like sq/tri.
test("a locked round core below the bend limit shows the EFFECTIVE (raised) size in the field, matching the note", async ({ page }) => {
  await page.goto(`/${encodeHashDoc({ d: 3.6, wt: "stiff", size: 30, ly: 2, base: "on", cap: "on" })}`);
  await expect(page.getByTestId("verdict")).toBeVisible();
  const outerInput = page.getByTestId("input-outer");
  await expect(outerInput).toHaveValue("46");
  await expect(outerInput).toHaveAttribute("min", "46");
  await expect(page.getByTestId("core-size-raised-note")).toContainText("Minimum for this round shape and cable: 46 mm");
  // Only a note: the design is valid, the core was just enlarged.
  await expect(page.getByTestId("warnings").locator("li", { hasText: /core size raised.*bend radius/i })).toHaveAttribute("data-severity", "note");
});

test("the core-size (i) hint explains the shape-dependent minimum in plain English", async ({ page }) => {
  await page.goto("/");
  const field = page.locator(".field").filter({ hasText: "Core size" }).first();
  await hoverHint(page, field.getByTestId("hint-btn"));
  await expect(field.getByTestId("hint-bubble")).toContainText("square or triangle");
});

// Issue #105 AC #4 + PR review: the corner radius's own bend-limit floor
// gets the SAME treatment as the core size's shape floor above -- the field
// must show a value >= the floor (never a stale/shared-link request below
// it), matching the min-note, and neither the slider nor the typed number
// can be edited below it.
test("a locked corner radius below the bend-limit floor shows the EFFECTIVE (clamped) value, matching the min-note next to it", async ({ page }) => {
  // Issue #140: this fixture sits exactly on the boundary where the field
  // also disables (no useful range at all) -- the effective-value and
  // min-note invariants this test checks must still hold even while
  // disabled (the value stays visible either way, only the ability to drag/
  // type it goes away), so this is deliberately left on TOO_SMALL_TRIANGLE
  // rather than moved to the enabled fixture below.
  await page.goto(TOO_SMALL_TRIANGLE); // tri.rc=5, well below this cable's bend-limit floor
  await expect(page.getByTestId("verdict")).toBeVisible();

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
  // Issue #140: TOO_SMALL_TRIANGLE itself is now a disabled field (no useful
  // range at all) and can't be typed into -- this fixture keeps the SAME
  // bend-limit clamp-up behavior under test, just with a locked size that
  // leaves the field enabled (see the fixture's own doc comment above).
  await page.goto(TRIANGLE_WITH_ROOM_ABOVE_FLOOR);
  await expect(page.getByTestId("verdict")).toBeVisible();

  const cornerInput = page.getByTestId("input-shapeCornerRadius");
  const min = Number(await cornerInput.getAttribute("min"));

  await cornerInput.fill("0.5");
  await cornerInput.blur();
  await expect(async () => {
    expect(Number(await cornerInput.inputValue())).toBeGreaterThanOrEqual(min);
  }).toPass();
  expect(Number(await cornerInput.inputValue())).toBe(min);
});
