import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { decodeHashDoc } from "./hashDoc";

// 3MF export, plate layout and bed warnings (issue #10).

test("Download 3MF produces a real zip package and the part count is shown", async ({ page }) => {
  await page.goto("/#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2");
  await expect(page.getByTestId("download-3mf")).toBeVisible();

  // Two-part design (core + auto top cap): the mesh-detail row shows the count.
  await expect(page.getByTestId("mesh-detail")).toContainText("2 parts");

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download-3mf").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("coil.3mf");

  const path = await download.path();
  expect(path).toBeTruthy();
  const buf = readFileSync(path!);
  expect(buf.byteLength).toBeGreaterThan(0);
  // A 3MF is a zip (OPC package): local file header signature "PK\x03\x04".
  expect(buf[0]).toBe(0x50);
  expect(buf[1]).toBe(0x4b);
  expect(buf[2]).toBe(0x03);
  expect(buf[3]).toBe(0x04);
});

test("the bed-size fields exist and shrinking the bed produces a fit warning", async ({ page }) => {
  await page.goto("/#v=1&L=2000&d=3.8&size=30");
  await expect(page.getByTestId("input-bedX")).toBeVisible();
  await expect(page.getByTestId("input-bedY")).toBeVisible();
  await expect(page.getByTestId("input-bedZ")).toBeVisible();
  await expect(page.getByTestId("warnings")).toHaveCount(0);

  await page.getByTestId("input-bedX").fill("20");
  await page.getByTestId("input-bedX").blur();

  await expect(page.getByTestId("warnings")).toContainText(/footprint/i);
  await expect(page.getByTestId("warnings")).toContainText(/doesn't fit/i);

  // The hash reflects the new bed size, so a reload reproduces it.
  await page.waitForTimeout(300);
  expect(decodeHashDoc(page.url()).bx).toBe(20);
});
