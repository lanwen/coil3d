import { expect, type Locator, type Page } from "@playwright/test";

// Test-only helper (issue #187): hover an (i) hint button once the page has
// stopped moving. The headings use a web font (`display=swap`), and the
// fallback-to-Kanit swap shifts everything below by several pixels. A hover
// that lands before the swap has the button slide out from under the pointer,
// the browser sends `mouseout`, and the hint closes again; Playwright's own
// "stable" check passes in the gap before the swap. So wait for the fonts
// first, then hover.
export async function hoverHint(page: Page, hintBtn: Locator): Promise<void> {
  // Visible means rendered and laid out, which is when the browser starts
  // fetching the fonts that text uses; `fonts.ready` then waits for them.
  await expect(hintBtn).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await hintBtn.hover();
}
