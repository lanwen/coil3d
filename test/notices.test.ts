import { readFileSync } from "node:fs";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const notices = readFileSync("public/THIRD_PARTY_NOTICES.txt", "utf8");

// Every npm package that ends up in the production bundle (main script and
// workers) must have a section in the shipped third-party notices. The package
// list comes from the source maps of an in-memory production build.
describe("third-party notices", () => {
  it("cover every npm package in the production bundle", async () => {
    const out = (await build({
      logLevel: "silent",
      build: { sourcemap: true, write: false, outDir: "dist-notices-check" },
    })) as { output: { fileName: string; type: string; source?: string | Uint8Array; map?: { sources: string[] } | null }[] };

    const maps: { sources: string[] }[] = [];
    for (const f of out.output) {
      if (f.type === "chunk" && f.map) maps.push(f.map);
      else if (f.type === "asset" && f.fileName.endsWith(".map")) maps.push(JSON.parse(String(f.source)));
    }
    expect(maps.length).toBeGreaterThan(0);

    const packages = new Set<string>();
    for (const m of maps) {
      for (const src of m.sources) {
        const i = src.lastIndexOf("node_modules/");
        if (i < 0) continue;
        const parts = src.slice(i + "node_modules/".length).split("/");
        packages.add(parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
      }
    }
    expect(packages.size).toBeGreaterThan(10);

    const missing = [...packages].filter((name) => !new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}@`, "m").test(notices));
    expect(missing, "bundled packages with no section in public/THIRD_PARTY_NOTICES.txt").toEqual([]);
  }, 120_000);

  // Font files that the build copies into dist/assets (the UI's Kanit) are not
  // in the source maps, so check them by file name: `kanit-latin-700-normal-<hash>.woff2`
  // needs a section that names "Kanit".
  it("cover every font file in the production build", async () => {
    const out = (await build({
      logLevel: "silent",
      build: { write: false, outDir: "dist-notices-check" },
    })) as { output: { fileName: string; type: string }[] };
    const fonts = out.output.filter((f) => f.type === "asset" && /\.(woff2?|ttf|otf)$/.test(f.fileName));
    expect(fonts.length).toBeGreaterThan(0);
    const families = new Set(fonts.map((f) => f.fileName.replace(/^assets\//, "").split("-")[0]));
    const missing = [...families].filter((family) => !new RegExp(`^${family} \\(`, "mi").test(notices));
    expect(missing, "font files with no section in public/THIRD_PARTY_NOTICES.txt").toEqual([]);
  }, 120_000);

  // Issue #213: the T-clip mount is adapted from a CC BY 4.0 design, so its attribution ships too.
  it("credit the CC BY designs the mounts are adapted from: author, title, link, licence, and what changed", () => {
    const designs = notices.slice(notices.indexOf("7. DESIGNS"));
    expect(designs).toContain("Skadis T-Clip System (CC BY 4.0)");
    expect(designs).toContain("by Line Arc Line");
    expect(designs).toContain("https://www.printables.com/model/256896");
    expect(designs).toContain("https://creativecommons.org/licenses/by/4.0/");
    expect(designs).toMatch(/Modified\./);
  });

  it("keep the static entries that are not npm packages", () => {
    for (const s of ["Clipper2 (BSL-1.0)", "Archivo Black (OFL-1.1)", "Kanit (OFL-1.1)", "Boost Software License", "GNU LESSER GENERAL PUBLIC LICENSE", "b8f597c677811d1f9f4d8a97f5ae2825c0353a42"]) {
      expect(notices).toContain(s);
    }
  });
});
