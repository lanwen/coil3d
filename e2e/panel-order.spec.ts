import { expect, test, type Page } from "@playwright/test";
import { openAdvanced, openPrintBed } from "./advanced";
import { decodeHashDoc, encodeHashDoc } from "./hashDoc";

// Issue #405: the controls run Cable, Shape, Core, Cap & base, Mount, then the
// collapsed Print bed and Advanced settings disclosures at the end.

const CAP_ON = encodeHashDoc({ L: 2000, d: 3.8, size: 30, cap: "on" });
const OVER_BED = encodeHashDoc({ L: 2000, d: 3.8, size: 60, bx: 50 });

async function gotoSettled(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("download-stl")).toBeEnabled();
}

const printBed = (page: Page) => page.getByTestId("print-bed");
const advanced = (page: Page) => page.locator("details.advanced");

test("sections and disclosures read Cable, Shape, Core, Cap & base, Mount, Print bed, Advanced settings", async ({ page }) => {
  await gotoSettled(page, "");
  const titles = await page.locator("form.controls").evaluate((form) =>
    Array.from(form.children).map((el) => {
      const summary = el.querySelector("summary");
      return (el.querySelector("h2") ?? summary?.firstElementChild ?? summary)!.textContent!.trim();
    }),
  );
  expect(titles).toEqual(["Cable", "Shape", "Core", "Cap & base", "Mount", "Print bed", "Advanced settings"]);
  await expect(page.locator("form.controls section.ctl-section h2")).toHaveText(["Cable", "Shape", "Core", "Cap & base", "Mount"]);
  await expect(page.locator("form.controls details summary")).toHaveText([/^Print bed/, "Advanced settings"]);
});

test("Cap & base holds Top cap, Joint, Base and the Customize row in that order", async ({ page }) => {
  await gotoSettled(page, CAP_ON);
  const section = page.locator("section.ctl-section").filter({ has: page.getByRole("heading", { name: "Cap & base" }) });
  const order = await section.evaluate((el) => {
    const ids = ["topCap", "select-joint", "base", "customize-open"];
    const nodes = ids.map((id) => el.querySelector(`[data-testid="${id}"]`)!);
    return nodes.map((node, i) => (i === 0 ? true : !!(nodes[i - 1].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)));
  });
  expect(order).toEqual([true, true, true, true]);
});

test("the bed sliders stay hidden until Print bed is opened, and its summary shows the values", async ({ page }) => {
  await gotoSettled(page, "");
  await expect(printBed(page)).not.toHaveAttribute("open", "");
  await expect(page.getByTestId("print-bed-summary")).toHaveText("256 × 256 × 256 mm");
  for (const id of ["bedX", "bedY", "bedZ"]) await expect(page.getByTestId(`input-${id}`)).toBeHidden();
  await openPrintBed(page);
  for (const id of ["bedX", "bedY", "bedZ"]) await expect(page.getByTestId(`input-${id}`)).toBeVisible();
  expect(decodeHashDoc(page.url()).bx).toBeUndefined();
});

test("Print bed opens by itself when a part is over the bed", async ({ page }) => {
  await gotoSettled(page, OVER_BED);
  await expect(page.getByTestId("bed-fit")).toHaveText("too big for your bed");
  await expect(printBed(page)).toHaveAttribute("open", "");
  await expect(page.getByTestId("input-bedX")).toBeVisible();
  await expect(page.getByTestId("print-bed-summary")).toHaveText("50 × 256 × 256 mm");
});

test("growing the core past the bed opens Print bed", async ({ page }) => {
  await gotoSettled(page, "");
  await expect(page.getByTestId("bed-fit")).toHaveText("fits your bed");
  await expect(printBed(page)).not.toHaveAttribute("open", "");
  await page.getByTestId("input-outer").fill("300");
  await page.getByTestId("input-outer").blur();
  await expect(page.getByTestId("bed-fit")).toHaveText("too big for your bed");
  await expect(printBed(page)).toHaveAttribute("open", "");
});

test("Joint tolerance lives in Advanced, shows only while the cap is on, and keeps its value when hidden", async ({ page }) => {
  await gotoSettled(page, CAP_ON);
  await expect(advanced(page).getByTestId("input-tolerance")).toBeHidden();
  await openAdvanced(page);
  await expect(advanced(page).getByTestId("input-tolerance")).toBeVisible();
  await page.getByTestId("input-tolerance").fill("0.35");
  await page.getByTestId("input-tolerance").blur();
  await expect(async () => expect(decodeHashDoc(page.url()).tol).toBe(0.35)).toPass();

  await advanced(page).locator("summary").click();
  await expect(advanced(page)).not.toHaveAttribute("open", "");
  expect(decodeHashDoc(page.url()).tol).toBe(0.35);

  await page.getByTestId("topCap").uncheck();
  await expect(page.getByTestId("input-tolerance")).toHaveCount(0);
  expect(decodeHashDoc(page.url()).tol).toBe(0.35);

  await page.getByTestId("topCap").check();
  await openAdvanced(page);
  await expect(page.getByTestId("input-tolerance")).toHaveValue("0.35");
});

test("phone: the Print bed summary fits on one line and is a real tap target", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoSettled(page, "");
  const summary = printBed(page).locator("summary");
  const box = (await summary.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeLessThan(60);
  const value = (await page.getByTestId("print-bed-summary").boundingBox())!;
  expect(value.height).toBeLessThan(26);
  const clipped = await summary.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(clipped).toBe(false);
});

test("keyboard: Tab runs from Cable length to Download STL and never lands on a hidden field", async ({ page }) => {
  await gotoSettled(page, "");
  await page.getByTestId("input-wireLength").focus();
  const visited: string[] = [];
  for (let i = 0; i < 80; i++) {
    const state = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const rect = el.getBoundingClientRect();
      return { id: el.dataset.testid ?? el.tagName.toLowerCase(), visible: rect.width > 0 && rect.height > 0 };
    });
    expect(state.visible, `focus on a hidden element: ${state.id}`).toBe(true);
    visited.push(state.id);
    if (state.id === "download-stl") break;
    await page.keyboard.press("Tab");
  }
  expect(visited.at(-1)).toBe("download-stl");
  expect(visited).not.toContain("input-bedX");
  expect(visited).not.toContain("input-windingQuality");
});

test("keyboard: Enter and Space open the Print bed and Advanced disclosures", async ({ page }) => {
  await gotoSettled(page, "");
  await printBed(page).locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(printBed(page)).toHaveAttribute("open", "");
  await page.keyboard.press("Space");
  await expect(printBed(page)).not.toHaveAttribute("open", "");

  await advanced(page).locator("summary").focus();
  await page.keyboard.press("Space");
  await expect(advanced(page)).toHaveAttribute("open", "");
  await page.keyboard.press("Enter");
  await expect(advanced(page)).not.toHaveAttribute("open", "");
});
