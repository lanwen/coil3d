import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The two test seams (AGENTS.md, "Tests"): vitest reaches the core only through
// `src/core/index.ts`, and Playwright reaches the app only through the browser.
// So no file under test/ imports a module of src/ other than the core index, and
// no file under e2e/ imports src/ at all. Tooling that is not part of the app
// (e2e/hashDoc.ts, test/support) is free to import.

const ROOT = path.resolve(__dirname, "..");
const CORE_INDEX = ["src/core", "src/core/index"];

// A file listed here may also import the named internal modules, for the reason of its decision. Keep it empty
// unless a test cannot drive what it checks through design().
const EXCEPTIONS: Record<string, Record<string, string>> = {
  // D5 (#367): the mesh-kernel fuzz drives the kernel past what a spec can express: it rebuilds the collar at facet
  // counts the app never ships (`collarSegments`) and unit-tests the weld on hand-built meshes.
  "test/meshFuzz.test.ts": {
    "src/core/manifold": "D5",
    "src/core/weld": "D5",
  },
  // #103 (#367): the groove's pitch is measured on the wall's own helix (`createWallProfile`); through design() the mesh is
  // too coarse to see the drift the fix removed.
  "test/groove-pitch.test.ts": {
    "src/core/wall": "#103",
  },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(relative);
    return /\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}

/** Every module a source file imports: static and type imports, re-exports, side-effect imports and `import()` calls, over any number of lines. */
function importedSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  const patterns = [/\b(?:import|export)\s+(?:type\s+)?[^"'`;]*?\s+from\s+["']([^"']+)["']/g, /\bimport\s+["']([^"']+)["']/g, /\bimport\(\s*["']([^"']+)["']\s*\)/g];
  return patterns
    .flatMap((pattern) => Array.from(code.matchAll(pattern), (match) => ({ at: match.index, specifier: match[1] })))
    .sort((a, b) => a.at - b.at)
    .map(({ specifier }) => specifier);
}

/** The src/ module (repo-relative, no extension) a specifier of `file` points at, or undefined when it is not one. */
function srcModuleOf(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).replace(/\.tsx?$/, "");
  return resolved.startsWith("src/") || resolved === "src" ? resolved : undefined;
}

function violations(file: string, source: string, exceptions: Record<string, Record<string, string>> = EXCEPTIONS): string[] {
  const allowed = file.startsWith("e2e/") ? [] : [...CORE_INDEX, ...Object.keys(exceptions[file] ?? {})];
  return importedSpecifiers(source).flatMap((specifier) => {
    const target = srcModuleOf(file, specifier);
    return target !== undefined && !allowed.includes(target) ? [`${file}: ${specifier}`] : [];
  });
}

describe("the test seams (#367)", () => {
  const files = [...sourceFiles("test"), ...sourceFiles("e2e")].filter((file) => file !== "test/seams.test.ts");

  it("no test imports a src/ module other than the core index, and no e2e file imports src/", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.flatMap((file) => violations(file, readFileSync(path.join(ROOT, file), "utf8")))).toEqual([]);
  });

  it("every listed exception is still used, so the table can't go stale", () => {
    for (const [file, modules] of Object.entries(EXCEPTIONS)) {
      expect(files, file).toContain(file);
      const used = importedSpecifiers(readFileSync(path.join(ROOT, file), "utf8")).map((specifier) => srcModuleOf(file, specifier));
      for (const module of Object.keys(modules)) expect(used, `${file}: ${module}`).toContain(module);
    }
  });

  describe("the check itself", () => {
    const flag = (file: string, source: string) => violations(file, source, {});

    it("allows the core index, other test files and tooling", () => {
      expect(flag("test/a.test.ts", `import { design } from "../src/core";\nimport type { Design } from "../src/core/index";\nimport { h } from "../e2e/hashDoc";\nimport { x } from "./support/rays";`)).toEqual([]);
    });

    it("flags an internal module however it is imported", () => {
      const source = [
        `import { pointAt } from "../src/core/shapes";`,
        `import type { WallSpec } from "../src/core/wall";`,
        `import {\n  a,\n  b,\n} from "../src/core/constants";`,
        `export { c } from "../src/viewer/frontFacing";`,
        `const m = await import("../src/geometry/worker");`,
        `import "../src/components/App";`,
      ].join("\n");
      expect(flag("test/a.test.ts", source)).toEqual([
        "test/a.test.ts: ../src/core/shapes",
        "test/a.test.ts: ../src/core/wall",
        "test/a.test.ts: ../src/core/constants",
        "test/a.test.ts: ../src/viewer/frontFacing",
        "test/a.test.ts: ../src/geometry/worker",
        "test/a.test.ts: ../src/components/App",
      ]);
    });

    it("flags a nested test file, and any src/ import in e2e (even the core index)", () => {
      expect(flag("test/support/a.ts", `import { pointAt } from "../../src/core/shapes";`)).toEqual(["test/support/a.ts: ../../src/core/shapes"]);
      expect(flag("e2e/a.spec.ts", `import { design } from "../src/core";`)).toEqual(["e2e/a.spec.ts: ../src/core"]);
    });

    it("ignores imports in comments and lets a listed exception through, for its own file only", () => {
      expect(flag("test/a.test.ts", `// import { pointAt } from "../src/core/shapes";\n/* import { x } from "../src/core/wall"; */`)).toEqual([]);
      const exceptions = { "test/a.test.ts": { "src/core/weld": "D5" } };
      expect(violations("test/a.test.ts", `import { w } from "../src/core/weld";`, exceptions)).toEqual([]);
      expect(violations("test/b.test.ts", `import { w } from "../src/core/weld";`, exceptions)).toEqual(["test/b.test.ts: ../src/core/weld"]);
    });
  });
});
