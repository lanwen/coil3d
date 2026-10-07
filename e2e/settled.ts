import type { Page } from "@playwright/test";

const SETTLED_TIMEOUT_MS = 15_000;

export async function expectSettled(page: Page) {
  await page.locator('[data-testid="coil-viewer"][data-settled="true"]').waitFor({ state: "attached", timeout: SETTLED_TIMEOUT_MS });
}
