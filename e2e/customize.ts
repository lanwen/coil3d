import { expect, type Page } from "@playwright/test";
import { expectSettled } from "./settled";

type Face = "cap" | "base";

// Test-only helper (issue #385): the label and strap-slot controls live in the
// Customize panel, not the main form. Opens it, waits for the FINAL mesh of
// the draft (the panel's own flag, since the download buttons leave with the
// form), switches face if asked, and waits for the locked camera to settle.
export async function openCustomize(page: Page, face?: Face): Promise<void> {
  await page.getByTestId("customize-open").click();
  await expectCustomizeFinal(page);
  if (face) await switchFace(page, face);
  await expectSettled(page);
}

export async function switchFace(page: Page, face: Face): Promise<void> {
  await page.getByTestId(`customize-face-${face}`).click();
  await expect(page.getByTestId("customize-panel")).toHaveAttribute("data-face", face);
  await expectSettled(page);
}

export async function expectCustomizeFinal(page: Page): Promise<void> {
  await expect(page.getByTestId("customize-panel")).toHaveAttribute("data-final-ready", "true");
}

export async function saveCustomize(page: Page): Promise<void> {
  await page.getByTestId("customize-save").click();
  await expect(page.getByTestId("customize-panel")).toHaveCount(0);
}

export async function cancelCustomize(page: Page): Promise<void> {
  await page.getByTestId("customize-cancel").click();
  await expect(page.getByTestId("customize-panel")).toHaveCount(0);
}
