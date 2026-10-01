import { expect, test } from "@playwright/test";
import { encodeHashDoc } from "./hashDoc";

// Issue #105 AC #3: every user-visible number in the controls/result panel
// is rounded sensibly (mm to 1 decimal or whole, cm to 1 decimal, % to
// whole) -- never a raw, many-digit float leaking straight out of the
// solver's floating-point math (e.g. a bend-limit floor like
// 14.442105263157894). This scans the WHOLE sidebar's rendered text (every
// field, hint, note and warning in `ControlsForm`/`ResultPanel`) across a
// spread of shapes, lock combinations and sizes, so a new field added later
// that forgets to round trips this net too.

const DESIGNS = [
  { name: "default (round, small)", hash: "" },
  // Round, a free height, with a cable diameter that doesn't divide evenly
  // (3.7mm) -- exercises the solver's own bend-limit/capacity math with
  // plenty of opportunity for a long decimal to leak through unrounded.
  { name: "round, free height, odd diameter", hash: encodeHashDoc({ L: 1234, d: 3.7, size: 45, ly: 3 }) },
  // Square, locked size below the shape's bend-limit floor: exercises the
  // core-size-raised note, the corner-radius clamp warning, and the corner
  // radius's own min-note (issue #105 AC #2, #4).
  { name: "square, locked size below the shape floor", hash: encodeHashDoc({ shape: "sq", rc: 5, size: 20, h: 40 }) },
  // Triangle, same floor-raising scenario as above but for the third shape.
  { name: "triangle, locked size below the shape floor", hash: encodeHashDoc({ shape: "tri", rc: 5, size: 20, h: 40 }) },
  // Custom wire type with a fractional bend multiplier, plus 2 free
  // dimensions -- exercises the objective picker and the alternate
  // candidate's own full SolutionSummary (a second copy of every numeric row).
  { name: "custom cable type, 2 free dimensions (alternate candidate)", hash: encodeHashDoc({ L: 1000, d: 4, wt: "custom", mbr: 7.5, lock: ["outer"], size: 40 }) },
  // Issue #192: the option cards, two free dimensions (one card per
  // objective) and three (one per layer count), each showing a size.
  { name: "option cards, 2 free dimensions", hash: encodeHashDoc({ L: 2000, d: 3.8, lock: ["outer"], size: 30 }) },
  { name: "option cards, 3 free dimensions", hash: "#s=eyJ2IjoyLCJsb2NrIjpbXX0" },
  // A small coil (below the 20mm small-coil rounding threshold) and a big
  // one, so both ends of `roundMm`'s own 0.5mm/1mm split get exercised.
  { name: "small coil", hash: encodeHashDoc({ L: 250, d: 1.3, size: 8, ly: 2 }) },
  // "Big" enough to exercise a print-bed-fit warning (height > the default
  // 256mm bed) without the multi-layer mesh becoming so heavy that building
  // it blows past the download-stl wait below.
  { name: "big coil", hash: encodeHashDoc({ L: 6000, d: 8, lock: ["outer", "h"], size: 180, h: 300 }) },
];

/** A number with 3+ digits after the decimal point -- 2 or fewer is fine (issue #105 AC #3). */
const RAW_FLOAT = /-?\d+\.\d{3,}/g;

for (const { name, hash } of DESIGNS) {
  test(`no raw floats in the controls/result panel: ${name}`, async ({ page }) => {
    await page.goto(`/${hash}`);
    await expect(page.getByTestId("verdict")).toBeVisible();
    // Wait for the FINAL-resolution mesh (issue #61/#62: a fixed sleep
    // alone can race the draft->final swap) before scanning -- warnings and
    // result numbers are identical between draft/final, but this keeps the
    // scan deterministic and matches every other test's own convention.
    await expect(page.getByTestId("download-stl")).toBeEnabled({ timeout: 20_000 });

    // Issue #192: the full numbers sit behind "All numbers"; open it so
    // they're scanned too (innerText skips a closed disclosure's content).
    await page.getByTestId("all-numbers").locator("summary").click();
    await expect(page.getByTestId("mesh-detail")).toBeVisible();
    const text = await page.locator(".sidebar").innerText();
    const matches = text.match(RAW_FLOAT) ?? [];
    expect(matches, `found un-rounded number(s) in the sidebar:\n${matches.join(", ")}\n\nfull text:\n${text}`).toEqual([]);
  });
}
