import { expect, test } from "@playwright/test";
import { decodeHashDoc, encodeHashDoc } from "./hashDoc";

// Issue #51 acceptance criteria: cable length is entered and shown in
// centimetres, with a 1cm step and a 20-1500cm range; other dimensions stay
// in mm; results that show lengths (wound length, capacity) are in cm; and
// old links (which store mm) keep their exact length. `CoilSpec.wire.length`
// itself never changes unit -- this is a pure UI conversion (ControlsForm.tsx
// / ResultPanel.tsx), so the hash format is untouched (test/hash.test.ts
// still covers it in mm). The hash's own `L` field is asserted via
// `decodeHashDoc` (issue #56: the hash is now `#s=<base64url(JSON)>`).

test("the default cable length shows as 200cm (2000mm) with a 1cm step and a 20-1500cm range", async ({ page }) => {
  await page.goto("/");
  const input = page.getByTestId("input-wireLength");
  await expect(input).toHaveValue("200");
  await expect(input).toHaveAttribute("min", "20");
  await expect(input).toHaveAttribute("max", "1500");
  await expect(input).toHaveAttribute("step", "1");
  // The unit suffix next to the field is "cm", not "mm".
  await expect(page.locator(".field-unit").first()).toHaveText("cm");
});

test("editing the cable length in cm updates the hash's mm value (L)", async ({ page }) => {
  await page.goto("/");
  const input = page.getByTestId("input-wireLength");
  await input.fill("350");
  await input.blur();

  await expect(async () => {
    expect(decodeHashDoc(page.url()).L).toBe(3500);
  }).toPass();
});

test("an old link storing an exact mm length keeps it exactly, even when it isn't a whole number of centimetres", async ({ page }) => {
  await page.goto(`/${encodeHashDoc({ L: 1234, d: 4, size: 40 })}`);
  await expect(page.getByTestId("hash-notice")).toHaveCount(0);
  // 1234mm = 123.4cm exactly -- shown, not rounded away.
  await expect(page.getByTestId("input-wireLength")).toHaveValue("123.4");

  // Round-tripping through the UI without touching the length keeps the
  // hash's own mm value exact.
  await page.getByTestId("input-wireDiameter").fill("4.5");
  await page.getByTestId("input-wireDiameter").blur();
  await expect(async () => {
    expect(decodeHashDoc(page.url()).L).toBe(1234);
  }).toPass();
});

test("the result panel reports wound length and capacity in centimetres", async ({ page }) => {
  await page.goto(`/${encodeHashDoc({ L: 1000, d: 4, size: 40 })}`);
  await expect(page.getByTestId("verdict")).toBeVisible();

  await expect(page.getByTestId("wound-length")).toContainText("cm");
  await expect(page.getByTestId("wound-length")).not.toContainText("mm");
  await expect(page.getByTestId("capacity-vs-target")).toContainText("cm");
  await expect(page.getByTestId("capacity-range")).toContainText("cm");

  // 1000mm target -> 100cm, so the capacity-vs-target row's own number
  // must be in the right ballpark for cm, not still reporting raw mm.
  const text = await page.getByTestId("capacity-vs-target").textContent();
  const match = text?.match(/^([\d.]+) cm/);
  expect(match, `expected a "<number> cm" prefix, got: ${text}`).not.toBeNull();
  expect(Number(match![1])).toBeGreaterThan(50);
  expect(Number(match![1])).toBeLessThan(500);
});
