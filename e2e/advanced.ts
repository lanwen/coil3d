import { type Page } from "@playwright/test";

// Test-only helper (issue #169): "Advanced settings" starts collapsed, so
// specs that touch its fields (winding quality, objective) open it first.
// Safe to call when it is already open.
export async function openAdvanced(page: Page): Promise<void> {
  const details = page.locator("details.advanced");
  if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open))) {
    await details.locator("summary").click();
  }
}
