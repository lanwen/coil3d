// Renders public/favicon.svg into the raster fallbacks with Playwright's
// Chromium: public/favicon.ico (32x32 PNG inside an ICO) and
// public/apple-touch-icon.png (180x180, full bleed: iOS rounds the corners).
// Run: node scripts/make-favicons.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const svg = readFileSync("public/favicon.svg", "utf8");
// The apple icon has no rounded corners and no outline: just the ink square.
const full = svg
  .replace(/<rect[^>]*\/>/, '<rect width="32" height="32" fill="#000"/>')
  .replace("translate(1 .7) scale(1.25)", "translate(2 1.7) scale(1.25)");

const browser = await chromium.launch();
async function png(source, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0;background:transparent">${source.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body>`);
  const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  return buf;
}

const small = await png(svg, 32);
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // one image
header.set([32, 32, 0, 0], 6); // 32x32, no palette
header.writeUInt16LE(1, 10); // planes
header.writeUInt16LE(32, 12); // bits per pixel
header.writeUInt32LE(small.length, 14);
header.writeUInt32LE(22, 18);
writeFileSync("public/favicon.ico", Buffer.concat([header, small]));
writeFileSync("public/apple-touch-icon.png", await png(full, 180));
await browser.close();
