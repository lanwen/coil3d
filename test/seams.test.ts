import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The two test seams (AGENTS.md, "Tests"): vitest reaches the core only through
// `src/core/index.ts`, and Playwright reaches the app only through the browser.
// So no file under test/ imports a module of src/ other than the core index, and
// no file under e2e/ imports src/ at all. Tooling that is not part of the app
// (e2e/hashDoc.ts, test/support) is free to import.
//
// The same scanner checks the core's two import rules (AGENTS.md, "Architecture"):
// no file under src/core imports React or three.js, and no file under src/ outside
// src/core imports a core module other than the index.

const ROOT = path.resolve(__dirname, "..");
const CORE_INDEX = ["src/core", "src/core/index"];
const NOT_IN_CORE = ["react", "react-dom", "three", "three-stdlib", "@react-three"];

// A file listed here may also import the named internal modules (or, for a core file, the named packages), for the
// reason of its decision. Keep it small: a test lists a module only when it cannot drive what it checks through design().
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
  // AGENTS.md names the geometry worker as the one app module that skips the index. `design()` comes from its own
  // module so the worker bundle does not pull in the lazy STEP (replicad) path that the index re-exports
  // (docs/design.md, "Geometry worker and live preview").
  "src/geometry/worker.ts": {
    "src/core/design": "worker bundle",
    "src/core/types": "worker bundle",
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

function isPackage(specifier: string, names: string[]): boolean {
  return names.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

function isSrcModule(target: string): boolean {
  return target === "src" || target.startsWith("src/");
}

function isInternalCoreModule(target: string): boolean {
  return target.startsWith("src/core/") && !CORE_INDEX.includes(target);
}

function moduleOf(file: string, specifier: string): string {
  return srcModuleOf(file, specifier) ?? specifier;
}

/** The imports of `file` that break its seam or the core's import rules, as `file: specifier`. */
function violations(file: string, source: string, exceptions: Record<string, Record<string, string>> = EXCEPTIONS): string[] {
  const excepted = Object.keys(exceptions[file] ?? {});
  const breaksRule = (target: string): boolean => {
    if (excepted.includes(target)) return false;
    if (file.startsWith("e2e/")) return isSrcModule(target);
    if (file.startsWith("test/")) return isSrcModule(target) && !CORE_INDEX.includes(target);
    if (file.startsWith("src/core/")) return isPackage(target, NOT_IN_CORE);
    return isInternalCoreModule(target);
  };
  return importedSpecifiers(source).flatMap((specifier) => (breaksRule(moduleOf(file, specifier)) ? [`${file}: ${specifier}`] : []));
}

describe("the test seams (#367) and the core's import rules (#388)", () => {
  const files = [...sourceFiles("test"), ...sourceFiles("e2e")].filter((file) => file !== "test/seams.test.ts");
  const appFiles = sourceFiles("src");
  const coreFiles = appFiles.filter((file) => file.startsWith("src/core/"));
  const scanned = [...files, ...appFiles];
  const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

  it("no test imports a src/ module other than the core index, and no e2e file imports src/", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.flatMap((file) => violations(file, read(file)))).toEqual([]);
  });

  it("no core file imports React or three.js", () => {
    expect(coreFiles.length).toBeGreaterThan(30);
    expect(coreFiles.flatMap((file) => violations(file, read(file)))).toEqual([]);
  });

  it("outside src/core, only the core index is imported from the core", () => {
    const outside = appFiles.filter((file) => !coreFiles.includes(file));
    expect(outside.length).toBeGreaterThan(30);
    expect(outside.flatMap((file) => violations(file, read(file)))).toEqual([]);
  });

  it("every listed exception is still used, so the table can't go stale", () => {
    for (const [file, modules] of Object.entries(EXCEPTIONS)) {
      expect(scanned, file).toContain(file);
      const used = importedSpecifiers(read(file)).map((specifier) => moduleOf(file, specifier));
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

    it("allows a core file its own modules and other packages, and an app file the index and its own neighbours", () => {
      expect(flag("src/core/a.ts", `import { x } from "./wall";\nimport { y } from "../core/shapes";\nimport { z } from "manifold-3d";\nimport { w } from "zod";`)).toEqual([]);
      expect(flag("src/core/step/a.ts", `import { x } from "../wall";\nimport { y } from "../threeMf";\nimport { z } from "three-mf-writer";`)).toEqual([]);
      expect(flag("src/viewer/a.tsx", `import { design } from "../core";\nimport type { Design } from "../core/index";\nimport { v } from "./b";\nimport { c } from "../components/c";\nimport * as THREE from "three";`)).toEqual([]);
    });

    it("flags React and three.js in a core file however they are imported, type-only included", () => {
      const source = [
        `import * as THREE from "three";`,
        `import type { Vector3 } from "three";`,
        `import { useState } from "react";`,
        `import { createRoot } from "react-dom/client";`,
        `import { Canvas } from "@react-three/fiber";`,
        `import { OrbitControls } from "three-stdlib";`,
        `import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";`,
        `import type { FC } from "react/jsx-runtime";`,
        `export type { Mesh } from "three";`,
        `const t = await import("three");`,
        `import "react";`,
      ].join("\n");
      expect(flag("src/core/a.ts", source)).toEqual([
        "src/core/a.ts: three",
        "src/core/a.ts: three",
        "src/core/a.ts: react",
        "src/core/a.ts: react-dom/client",
        "src/core/a.ts: @react-three/fiber",
        "src/core/a.ts: three-stdlib",
        "src/core/a.ts: three/examples/jsm/exporters/GLTFExporter.js",
        "src/core/a.ts: react/jsx-runtime",
        "src/core/a.ts: three",
        "src/core/a.ts: three",
        "src/core/a.ts: react",
      ]);
      expect(flag("src/core/step/a.ts", `import * as THREE from "three";`)).toEqual(["src/core/step/a.ts: three"]);
    });

    it("does not mistake a package or a file whose name starts with react or three", () => {
      expect(flag("src/core/a.ts", `import { x } from "threejs-like";\nimport { y } from "reactive";\nimport { z } from "./three";\nimport { w } from "./react/x";`)).toEqual([]);
    });

    it("flags a core module that an app file imports past the index, type-only included", () => {
      const source = [
        `import { x } from "../core/design";`,
        `import type { CoilSpec } from "../core/types";`,
        `export { y } from "../core/wall";`,
        `import { s } from "../core/step/export";`,
        `const m = await import("../core/hash");`,
        `import "../core/weld";`,
      ].join("\n");
      expect(flag("src/viewer/a.ts", source)).toEqual([
        "src/viewer/a.ts: ../core/design",
        "src/viewer/a.ts: ../core/types",
        "src/viewer/a.ts: ../core/wall",
        "src/viewer/a.ts: ../core/step/export",
        "src/viewer/a.ts: ../core/hash",
        "src/viewer/a.ts: ../core/weld",
      ]);
      expect(flag("src/App.tsx", `import { design } from "./core/design";`)).toEqual(["src/App.tsx: ./core/design"]);
    });

    it("lets a listed app or core exception through, for its own file only", () => {
      const exceptions = { "src/geometry/a.ts": { "src/core/design": "r" }, "src/core/a.ts": { three: "r" } };
      expect(violations("src/geometry/a.ts", `import { d } from "../core/design";`, exceptions)).toEqual([]);
      expect(violations("src/geometry/b.ts", `import { d } from "../core/design";`, exceptions)).toEqual(["src/geometry/b.ts: ../core/design"]);
      expect(violations("src/core/a.ts", `import * as THREE from "three";`, exceptions)).toEqual([]);
      expect(violations("src/core/b.ts", `import * as THREE from "three";`, exceptions)).toEqual(["src/core/b.ts: three"]);
    });
  });
});
