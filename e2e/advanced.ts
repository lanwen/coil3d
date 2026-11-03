import { type Page } from "@playwright/test";

// Test-only helper (issue #169): "Advanced settings" starts collapsed, so
// specs that touch its fields (winding quality) open it first.
// Safe to call when it is already open.
export async function openAdvanced(page: Page): Promise<void> {
  const details = page.locator("details.advanced");
  if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open))) {
    await details.locator("summary").click();
  }
}

// "Print bed" is a collapsed disclosure that shows its values in the summary
// and opens by itself when a part is over the bed. Safe to call when it is
// already open.
export async function openPrintBed(page: Page): Promise<void> {
  const details = page.getByTestId("print-bed");
  if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open))) {
    await details.locator("summary").click();
  }
}

// Issue #192: the full result numbers sit behind the collapsed "All
// numbers" disclosure; specs that need to see (or hover) them open it first.
// Safe to call when it is already open.
export async function openAllNumbers(page: Page): Promise<void> {
  const details = page.getByTestId("all-numbers");
  if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open))) {
    await details.locator("summary").click();
  }
}
