// Regenerates ../../core/label-font-data.ts from ArchivoBlack-Regular.ttf (SIL Open Font
// License 1.1, see ./OFL.txt). Base64, not a raw asset import, so the exact same bytes load
// identically in the browser main thread, the geometry worker (src/geometry/worker.ts) and
// vitest/Node -- no fetch(), no bundler-specific asset URL handling to keep in sync across
// those three run targets (issue #12, ../../core/label.ts).
//
// Run from anywhere: `node src/assets/fonts/generate-base64.mjs`.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const bytes = fs.readFileSync(path.join(dir, "ArchivoBlack-Regular.ttf"));
const base64 = bytes.toString("base64");
const out = `export const ARCHIVO_BLACK_TTF_BASE64 =
  "${base64}";
`;
const outPath = path.join(dir, "..", "..", "core", "label-font-data.ts");
fs.writeFileSync(outPath, out);
console.log(`wrote ${outPath}, ${base64.length} base64 chars`);
