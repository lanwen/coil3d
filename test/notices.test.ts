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

  it("keep the static entries that are not npm packages", () => {
    for (const s of ["Clipper2 (BSL-1.0)", "Archivo Black (OFL-1.1)", "Boost Software License", "GNU LESSER GENERAL PUBLIC LICENSE", "b8f597c677811d1f9f4d8a97f5ae2825c0353a42"]) {
      expect(notices).toContain(s);
    }
  });
});
