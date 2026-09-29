# scroll3d — Research & Design Notes

Status: pre-implementation research (2026-09-23). Spikes S1–S5 done (see §10a); throwaway code lives in `spikes/`.

A static, fully client-side web app (GitHub Pages) that designs a 3D-printable **coil / cable winder**
for a given wire (length + diameter + connectors), renders it IKEA-instruction style, shows how the
wound wire will look, and exports print-ready STL / 3MF / STEP. The URL encodes the full configuration.

---

## 1. Decisions made (from interview)

| Topic | Decision |
|---|---|
| Primary use cases | USB / headphone cables (2–5 mm, 0.5–3 m) **and** EU extension cords with heavy Schuko plug (≈8–10 mm cable, **max 15 m**). Ranges must cover both. |
| Solver model | Wire length + diameter are always inputs. Every other dimension can be **locked or free**; solver fills free ones, reports over/under-constrained. |
| Winding | Helical. Groove guides **layer 1 only**; higher layers nest in valleys (orthocyclic). |
| Core | A **tube**: hollow and open, and the center stores the inner connector. The user can lock either the **inner diameter** (bore) or the **outer diameter** (winding surface); wall thickness links the two. |
| Wire ends | **v1: no connector pocket; both connectors dangle outside.** Inner end: **keyhole in the bottom flange rim** at the groove start, with a recessed radial channel on the flange's inner face so layers don't wind over a bump. Outer end: **keyhole in the top cap rim**. v2: a clip on the cable to stop it unwinding. |
| Connector sizes | **Not modelled in v1** (connectors dangle). The presets (USB-A/C, Lightning, 3.5 mm, Schuko straight/angled) come back when a pocket or clip needs them. |
| Caps / parts | **The bottom flange is always present and printed as one piece with the core** (flat on the bed, core upright); it carries the mount. **Top cap separate**, auto-enabled when layers > 1, and the user can override. Flange size = final outer envelope + margin. **Clip mounts (SKÅDIS/openGrid) are a separate mount plate** glued or snapped onto the flange's outer face, so the core prints without supports. The screw keyhole is recessed straight into the flange; the through-hole mount cuts straight through it instead. Parts: core, plus top cap and mount plate as needed (max 3). |
| Cap joint | Permanent after assembly. Options: press-fit, bayonet/twist-lock, snap clips (glue-friendly). |
| Bend limit | Wire-type preset → min-bend-radius multiplier: USB/audio 4×, **flexible cord 4×**, stiff/solid 10×, custom. Corner-radius slider is clamped to it. |
| Mounting | The axis points out of the wall; mount features sit on the bottom flange's outer face; the top cap and label face the room. Semi-permanent: **screw keyhole (wall)** -- issue #71 adds a `keyholeRotation` 0/45/90° option (which of the shape's own natural axes the slot lands on; the mount axis and the hang stay level at every setting) and a verified undercut behind the slot's own narrow surface opening, so the screw head is actually captured, not just wedged -- **through-holes** (issue #70: plain, counterbored screw-shank holes straight through the flange, permanent/non-sliding, near the corners for sq/tri or evenly spaced for round), **IKEA SKÅDIS**, **openGrid**. Multiboard excluded. |
| Extras | Embossed label text on the **top cap face, only when it fits** (auto-hidden with a warning otherwise); hanging hole/hook; printable IKEA-style **assembly guide**. |
| Printer | Bed-size parameter → warning only. |
| Size semantics | Round = diameter; square = across flats; triangle = inscribed-circle diameter. |
| Exports | STL, 3MF (multi-part), **one STEP file** (assembly with one solid per part). STEP kernel **lazy-loaded** only on STEP export. |
| Stack | React + react-three-fiber (+ drei), Vite, TypeScript. |
| Units / i18n | Metric only, English UI. |
| Wire | Round cross-section only (no flat cables). |
| Persistence | **No local "my wires" storage.** All state lives in the **URL hash**. |

---

## 2. Domain model (proposal)

```
Wire        { length, diameter, type(preset→bendMultiplier), innerConnector, outerConnector }
Shape       { kind: round|triangle|square|…(plugin), size, cornerRadius }   // cross-section of core
Core        { height, wallThickness, groove{profile, depth, clearance} }   // bottom flange integral
Caps        { enabled(auto|on|off), flangeMargin, thickness, joint, keyholes(bottom rim, top rim) }
Mount       { none|keyhole|skadis|opengrid, placement, plateJoint(glue|snap) }   // clips → separate plate
Label       { text, face, depth }
Print       { bedX, bedY, bedZ, tolerance }
```

Derived (solver output): turns per layer, layer count, per-layer length, total wound length,
lead/tail lengths, final outer envelope, flange size, min core size (from bend limit), label fit, warnings.

### Shape plugin interface (for future shapes)

The capacity math relies on **convex** profiles, so shapes should be restricted to convex
rounded outlines (the plugin interface checks this).

```ts
interface ShapePlugin {
  id: string                          // 'round' | 'tri' | 'sq' | …  (also URL key)
  params: ParamSchema                 // extra params beyond size/cornerRadius
  outline(offset: number): Path2D     // closed convex outline, offset outward (+) / inward (−)
  straightLength(): number            // Σ straight segments (0 for round)
  inscribedRadius(offset): number     // for connector-pocket fit checks
  cornerRadiusRange(ctx): [min, max]  // max from size, min from bend limit
  sizeSemantics: 'diameter'|'acrossFlats'|'acrossCorners'
}
```

Candidates later: hexagon, stadium/obround (flat cable winders), ellipse (needs a numeric perimeter,
because Steiner's formula doesn't give an ellipse perimeter in closed form).

---

## 3. Capacity math (solver core)

**Offset perimeter of a convex rounded shape** (Steiner / Minkowski sum): when you offset outward by
`o`, the straight sides stay the same length and each corner arc grows. The arcs always add up to one
full circle:

```
P(o) = S + 2π·(r_c + o)          S = Σ straight sides, r_c = corner radius  (round: S = 0)
```

**Layer centerline offsets** (wire diameter `d`, groove depth `g`):

```
o_1 = d/2 − g
o_k = o_1 + (k−1)·h        h = d·√3/2 (orthocyclic, ideal)  …  d (stacked, worst case)
```

Expose a "winding quality" parameter that blends `h` between the two. Hand-winding a USB cable is
rarely perfectly orthocyclic. Manufacturers report real capacity 25–30 % below the ideal value.

**Turns per layer**: `n_1 = floor(H_usable / p)` with pitch `p = d + clearance` (clearance 0.2–0.4 mm).
Orthocyclic layers alternate `n` and `n−1` turns.

**Length**: `L_wound = Σ_k n_k · √(P(o_k)² + p²)` (the helix correction is small, but it is free to include).
Total: `L_wire = L_inner_lead (connector→exit slot) + L_wound + L_outer_tail`.

**Solver**: every output grows monotonically with each free variable (size, height, layers), so a
single free variable can be solved by closed form or bisection. With two free variables, the solver
needs an objective, e.g. "minimize outer envelope" or "target aspect ratio". Show the result live.

**Constraints the solver must enforce / warn about**
- `r_c ≥ MBR = multiplier × d`, applied to the *innermost* layer (outer layers only get rounder).
- ~~Connector pocket fit~~: not in v1 (connectors dangle), so the bend limit alone sets the minimum core size.
- The path from the bottom rim keyhole through the radial channel to the groove start must respect the bend radius.
- The label only renders if its bounding box fits the top cap annulus.
- Flange ≥ outermost layer + margin (≥ 1 d).
- Bed-size check per part.

**Non-round caveat**: on the flat sides, a stiff cable bows outward instead of lying flat. For stiff
presets, add a bow allowance to the envelope, or warn.

---

## 4. Geometry & kernels

### Findings
- **replicad** (OpenCascade.js wrapper, MIT, active, moved to OCCT 8 in 2026): sweeps, fillets, booleans,
  native STEP/STL, text via opentype. Runs in a Web Worker. WASM ≈ 9 MB brotli (full build); custom
  builds are smaller. **occt-wasm** (andymai/occt-wasm) claims ≈ 4 MB. Worth a spike.
- **manifold-3d**: fast, robust mesh booleans. Has no B-rep, so it cannot write STEP. Suited to live preview + STL/3MF.
- **openscad-wasm**: no STEP, no 3MF in WASM, and helix grooves are awkward. Rejected.
- **build123d via Pyodide (OCP.wasm)**: works, but its startup cost is heavy. Backup option only.
- **truck** (Rust B-rep): too immature for STEP. Rejected.
- **Helical sweep + boolean is a known OCCT failure mode**: it self-intersects when pitch < profile
  width, and cuts can fail silently (OCCT #1543, #1558; FreeCAD #18658). Sharp corners make it worse.

### Direction
1. **Don't boolean the groove.** The core's outer surface is a parametric surface
   `R(s, z) = outline(−groove(z − p·s/P))`. It is the wall displaced by the groove profile, as a
   function of arc length `s` and height `z`. Generate the mesh directly. This is fast and exact,
   and it produces no self-intersection. Use manifold only for the simple features: pocket, exit
   slot, keyhole, mount, label, joints.
2. **Two backends, one feature description.** A pure-TS `CoilSpec → FeatureTree` feeds:
   - *Mesh backend* (default): direct surfaces + manifold-3d → preview, STL, 3MF.
   - *B-rep backend* (lazy, worker): replicad/OCCT → STEP. For the grooved wall, try in order:
     (a) a B-spline surface fitted to the same parametric grid (`GeomAPI_PointsToBSplineSurface`),
     (b) a pipe-shell sweep split per straight segment/arc, (c) as a last resort, a faceted-BREP STEP from the mesh.
   - Guard against backend drift with a test that compares volume and bounding box across backends.
3. **Workers**: all geometry runs off the main thread. Debounce slider input and cancel stale jobs.
4. **GitHub Pages has no COOP/COEP headers**, so there is no SharedArrayBuffer and no threaded WASM
   builds. Use single-threaded builds only. (A `coi-serviceworker` hack exists, but avoid it.)

### Groove design (FDM)
- The profile follows the wire. A plain semicircle creates a ceiling overhang when the core prints
  upright. Prefer a shallow groove (≈ 0.3–0.5 d) or a **teardrop profile** with a 45° upper flank.
- Pitch = d + 0.2–0.4 mm.
- The groove covers layer 1 only.

### Joints / tolerances
Press-fit ≈ −0.1 mm, sliding 0.15–0.2 mm, loose 0.35–0.5 mm. Expose one global `tolerance`
and offer a small **fit-test coupon** export (groove sample + joint sample) so users can calibrate
before a long print.

---

## 5. Rendering (IKEA look)

> **Updated by §10b:** use skapa's single-pass normal+depth edges + framing-scaled dilate instead of drei `<Edges>`/`<Outlines>`.

- **R3F + drei**: flat white `MeshBasicMaterial`/2-step toon fill, black **`<Edges>`** (crease threshold)
  plus a silhouette pass. For silhouettes use drei `<Outlines>` or a normal+depth edge post-pass
  (Omar Shehata's technique, or pmndrs/postprocessing). Curved surfaces need the silhouette pass,
  because EdgesGeometry alone draws no outline on smooth faces.
- **Orthographic camera** with isometric-ish presets (matches instruction manuals); orbit still enabled.
- **Wire schematic**: one merged `TubeGeometry` per layer along the computed helix, in mid-grey
  with an outline. Use a GPU-instanced helix shader if turn counts get into the thousands. Draw the
  connectors as simplified primitives (box/cylinder), parked in the pocket / hanging from the keyhole.
- **Exploded view / transitions**: react-spring (R3F-native) or GSAP. Explode caps along Z.
  Use camera tweens for the step changes.
- **Assembly guide**: IKEA-style numbered steps (print parts → park connector → wind → press caps →
  mount). **gkjohnson/three-edge-projection** produces true hidden-line SVG, which is ideal for the
  printable guide. The guide goes on a print-CSS page, so the user can print or save it as PDF.
- UI: custom minimal controls. Leva looks too much like a dev tool. Font: **Noto Sans** (IKEA now uses
  a custom Noto cut). Use outline pictogram icons (Lucide).

---

## 6. Export

| Format | Approach |
|---|---|
| STL | Binary STL per part (zip when there are multiple parts), or one file per part. |
| 3MF | Write it by hand: a zip (fflate) with `[Content_Types].xml`, `_rels/.rels`, `3D/3dmodel.model`, one `<object>` per part, and parts pre-arranged on the build plate. Alternatives: `@jscad/3mf-serializer`, or lib3mf WASM if production/extensions are needed. |
| STEP | Lazy-loaded OCCT worker → AP214/AP242, one solid per part (assembly). |

---

## 7. URL state

- A versioned, human-readable **URL hash** that omits defaults. The hash never reaches the server, which suits GitHub Pages. Example:
  `#v=1&shape=sq&L=2000&d=3.8&wt=usb&h=40&rc=18&caps=auto&mount=skadis&label=USB-C%202m`
- Lock state is encoded, e.g. `lock=h,rc`, so the solver reproduces the same result.
- Validate with a schema (zod/valibot). Unknown or old versions get migrated.
  Update with `history.replaceState`, debounced.
- Include the shape-plugin id plus its own params namespace (`sq.rc=`), so new shapes don't collide.

---

## 8. Things you may have missed (surfaced during research)

1. **Twist**: unwinding a cable by pulling it over the end of a fixed spool adds one twist per turn.
   A spool that rotates while unwinding adds no twist. With permanent caps and a wall mount, decide
   whether the coil **rotates on its mount** (axle / spindle mount) or is only "storage".
2. *(Obsolete for v1: no connector pocket.)*
3. **The start of the winding** (bottom rim keyhole → radial channel → groove start) is a bend-radius hotspot, and without the channel it makes a bump under the layers. Model it as a tangent ramp.
4. *(Resolved: round wire only.)*
5. **Wire measurement uncertainty**: users measure with calipers. The ±0.2 mm error compounds over
   many turns, so show a capacity range, not a single number.
6. **Heavy cords**: a 15 m, 3×1.5 mm² cord weighs about 1.5–2 kg. This affects the mount strength
   (SKÅDIS hooks are rated low), the wall thickness, and the cap joint choice.
7. *(Multiboard excluded.)*
8. **Grid pitches** to verify: SKÅDIS: two 40 mm grids offset by (20, 20) mm (checked in §10d); openGrid 28 mm.
9. **Print orientation hints** for each part in the guide and in the 3MF placement.
10. **Fit-test coupon** before a long print (see §4).
11. **Accessibility / mobile**: the controls must work on a phone (~400 px). The 3D view gets a
    reduced-motion option.

---

## 9. Open questions

1. ~~Size semantics~~ **Resolved:** square = across flats; triangle = inscribed-circle diameter. Round = diameter.
2. ~~Inner vs outer diameter~~ **Resolved:** the core is a tube. Lock the bore (inner) or the winding surface (outer). Wall thickness links the two.
3. ~~Parts~~ **Resolved:** the bottom flange is integral with the core (always present); the top cap is separate; clip mounts are a separate plate (clips can't point into the print bed). At most 3 parts.
4. ~~Pocket opening~~ **Superseded:** there is no pocket in v1; connectors dangle. (Option A stays the preferred design if a pocket returns.)
5. ~~Keyhole~~ **Resolved:** on the rim (radial), one on the bottom flange and one on the top cap.
6. ~~Label~~ **Resolved:** top cap face, only if there is space.
7. ~~Rotating mount~~ **Resolved: fixed mount.** The coil is storage: take it off the wall to unwind. Mention the twist in the assembly guide ("unwind by rotating the coil").
8. ~~Flat cables~~ **Resolved:** no; round only.
9. ~~Connector sizes~~ **Deferred:** connectors dangle in v1. Measure them when the cable clip or pocket is designed (angled Schuko included).
10. ~~STEP~~ **Resolved:** one STEP file.
11. ~~Remember wires~~ **Resolved:** no local storage; state lives in the URL hash only.
12. ~~Flexible-cord bend preset~~ **Resolved: 4×.** Presets: USB/audio 4×, flexible cord 4×, stiff/solid 10×, custom.
13. **New (v2):** a cable clip that stops the coil unwinding. What form: a clip on the wire, or a clip that holds the wire against the top cap?
14. ~~Wall orientation~~ **Resolved:** the axis points out of the wall, the bottom flange's outer face is against the wall, and the mount features (keyhole screws, SKÅDIS clips, openGrid) are on that face. The top cap faces the room, which is where the label goes.

---

## 10. Risks & spikes (do before full build)

| Spike | Question it answers |
|---|---|
| S1: Parametric grooved-wall mesh on a rounded square, with manifold features cut in | Is the direct-surface approach watertight and fast (< 50 ms)? |
| S2: The same wall in replicad/occt-wasm → STEP, opened in FreeCAD/Fusion | Is B-spline surface vs sweep viable? What is the load time and bundle size? |
| S3: R3F edges + silhouette on a filleted spool with a wound-wire tube | Does the IKEA look hold up on curved and thin features? |
| S4: Minimal hand-written 3MF with 3 parts | Does it open correctly in Bambu Studio / PrusaSlicer / Orca? |
| S5: Solver with lock/free UI | Is the UX of "lock what you know" clear? |

Testing: unit tests for the solver math. Manifoldness checks on every generated part. Playwright
screenshot tests of the renderer (the Playwright kit is available in this sandbox).

---

## 10a. Spike results (2026-09-23)

| Spike | Verdict | Key numbers / findings |
|---|---|---|
| **S1** grooved wall mesh (`spikes/s1-grooved-wall`) | ✅ Direct parametric mesh works | Rows follow the helix, so the groove profile is exact and the seam closes without special code. manifold-3d accepted all 14 meshes (genus 1, volume within 1–2 %). Preview (~16k tris) takes **25–33 ms** including features; final (~170k tris) ~240 ms (Node). The exit slot and floor hole cut cleanly. Every manifold object must be `.delete()`d, or WASM runs out of memory. Teardrop groove: use g ≈ 0.3 d. The exit slot must follow a curved path (a straight capsule gouges the wall). Final STL is 8–9 MB, so resolution needs tuning. |
| **S2** STEP (`spikes/s2-step-export`) | ✅ **replicad + approach A** | Fit the periodic cubic B-spline **in JS** (`lib/bspfit.mjs`) and pass the poles to `Geom_BSplineSurface`; OCCT's own interpolation broke at high resolution and crashed the WASM. Build takes 0.2–0.4 s in Chromium, and STEP writing ~50 ms. Surface deviation ≤ 0.09 mm, volume error 0.003 %, and read-back is valid. Bundle ≈ **5 MB brotli** (occt-wasm is about the same, 4.9 MB, and has a worse API). Init < 90 ms without COOP/COEP. The sweep+cut approach fails silently on a long helix; the faceted fallback gave 20 MB in 22 s. Avoid fillets on the grooved wall's edges. Validate volume on every export. Text embossing takes ~1 s. **Not yet opened in FreeCAD/Fusion.** |
| **S3** render (`spikes/s3-render`) | ⚠️ Works, needs tuning | The combination of drei `<Outlines>` and a normal+depth post pass looks best. The post pass cost stays flat as turn count grows; Edges/Outlines slows down with more turns. For now the outlines are too thick and the wire turns into a black mass. Use thinner lines that stay the same width on screen, and a lighter wire. Pocket A/B and size-semantics mockups are in `shots/08–10`. |
| **S4** 3MF (`spikes/s4-3mf`) | ✅ Hand-written writer | ~105 lines + `fflate`. It writes one `<object>` per part and one `<build><item transform>` per part, uses `basematerials` for colour, and needs no vendor metadata. trimesh read-back: 3 named watertight parts at the correct positions. lib3mf is unavailable in the sandbox. **Slicer check still pending** (Bambu/Prusa/Orca). |
| **S5** solver (`spikes/s5-solver`) | ✅ Math + lock UX | 26 vitest tests, including the zod URL codec. **The bend limit often dominates the core size** (a 15 m Schuko cord at 6× needs ≥ 92 mm). Bugs to fix: the envelope uses a bounding circle, which overstates square flanges; `inner = outer − 2·wall` is wrong for triangles. Unresolved: the objective for two free variables (proposal: show 2–3 candidates side by side). The lead and tail lengths are constants, not modelled. SVG shape bugs were caught only by screenshots, so screenshot tests are needed. |

**Architecture confirmed:**
- **Kernel:** TS `CoilSpec` → mesh backend (direct surface + manifold-3d) for preview, STL and 3MF, plus a lazy replicad worker for STEP. Both backends consume **the same parametric wall grid**: the mesh uses it directly, and STEP fits a B-spline to it. This keeps the two backends from drifting apart.
- **Tests:** geometry and solver unit tests, plus Playwright screenshot tests.

## 10b. Reference projects reviewed (2026-09-23)

### skapa — [nmattia/skapa](https://github.com/nmattia/skapa) (SKÅDIS box generator) — **this is the target look**
**License:** none (all rights reserved). Reimplement the technique; don't copy files.

**Stack:** vanilla TS + Vite + three.js + manifold-3d on the main thread. The JS bundle is about 560 KB. It writes 3MF with `@jscadui/3mf-export` + fflate. There is no URL state, no STL/STEP, and no orbit (the camera snaps to front and back).

**How the look is made.** The composer chain is `RenderOutlinePass → ThickenPass → OutputPass → FXAA`:
1. **One full-scene pass** renders with `scene.overrideMaterial = MeshNormalMaterial` into a target with a depth texture.
2. A fullscreen Sobel shader runs on **depth + normals** and outputs white fill and black edges. The background has alpha 0, so the page shows through. There is no lighting and no fill material.
3. **Dilate pass ("thicken").** A pixel turns black if any black pixel lies within `thickness`. The thickness is recomputed whenever the model is re-framed:
   `thickness = 150 · devicePixelRatio / diagonal(projected bounding box)`.
   This makes line weight scale with how big the model appears on screen. **This is the fix for S3's thick outlines.**
4. FXAA runs last, after color-space conversion.

**Other ideas worth taking:**
- An orthographic camera refit to the projected mesh bounds on every geometry or size change.
- Dimension changes tween with a ~30-line `Animate` helper (`easeInOutCubic`), which regenerates the mesh each frame, throttled.
- Click hit-testing reads the outline pass alpha at the cursor, so a click on the background passes through.
- Controls are custom: a native range slider plus a synced number input with a "mm" suffix, and a +/- stepper. Only black and white; the hover state inverts them.
- Fonts: **Kanit** for headings, `system-ui` for the body.

**SKÅDIS clip.** The clip is a 2D polygon, in mm: `[0.95,0] [2.45,0] [2.45,3.7] [3.05,4.3] [3.05,5.9] [2.45,6.5] [0.95,6.5]`. It is extruded 12 mm and mirrored, on a **40 × 40 mm** grid. Rows after the first get a 45° chamfer so they print without supports. This is a good starting point for our SKÅDIS mount; measure it on a real board.

**Risk for our wire.** A normal-edge pass draws a line at every valley between adjacent turns. Hundreds of turns turn into dense parallel lines, which is IKEA-ish but can get busy. Options:
- Raise the normal-edge threshold for the wire.
- Render the wire as a smooth "wound body" envelope with only a few helical hint lines.
- Drop to envelope-only when the view is zoomed out.

Test this in the first render iteration.

### gridfinity-layout-tool — [andymai/gridfinity-layout-tool](https://github.com/andymai/gridfinity-layout-tool)
**License: AGPL-3.0.** Ideas only; copying code would force the whole project under AGPL.

It's a full SaaS (Vercel, Liveblocks collab, CQRS, three kernels: brepjs/OCCT ~22 MB, brepkit ~5 MB, manifold). It uses realistic PBR shading, which is the opposite of our look. This is far beyond our scope.

**Ideas to reimplement:**
- **Edge lines precomputed in the geometry worker** and transferred with the mesh. Useful if we ever add B-rep feature edges on top of the screen-space pass.
- **A draft → exact swap.** The manifold draft shows instantly, and the exact mesh replaces it with a 250 ms edge fade. There is also a synchronous WASM-free direct-mesh path, which matches our S1 approach.
- **A dual perspective/orthographic camera rig** that keeps on-screen scale across the swap. It has preset views with slerp transitions and auto-framing to about 65 % of the viewport.
- **Snapshot undo:** past/future arrays of the whole state, capped at 100.
- **STL export** uses OCCT first and falls back to a mesh when OCCT fails.
- **3MF slicer gotcha (affects S4):** according to the review, Bambu, Orca and Prusa ignore the spec's `basematerials`/`pid` colors and read only a per-triangle `paint_color` attribute. Bambu also needs an `Application=BambuStudio-…` metadata string. So S4's colors probably won't show up; the part separation should still work. Verify this in the slicer check.

### Impact on our plan
- **Rendering:** follow the skapa approach. Use one screen-space normal+depth edge pass, a dilate pass with framing-based thickness, alpha background, FXAA and an orthographic camera. This replaces drei `<Edges>`/`<Outlines>` from S3. React + R3F stays, but the post chain is a custom `EffectComposer` pass.
- **Viewer UX:** add a draft → exact edge fade, persp/ortho preset views, and tweened parameter changes.
- **3MF:** add `paint_color` output if multi-color parts matter. Otherwise single-color named objects are enough.

## 10c. Clip mount plate research (issue #14, 2026-09-24)

> **Partly superseded by §10d (issue #106):** the stagger below was applied
> to the wrong columns, the clip's barb didn't reach behind a 5 mm board,
> and the pegs/snap tabs couldn't print without supports. §10d has the
> checked version.

**SKÅDIS.** IKEA doesn't publish a spec; the numbers below are
community-measured but corroborated across multiple independent sources
(PR review round 2 asked for this to be verified properly, not just
carried over from §10b's spike-era note):
- **Slot: a single VERTICAL obround (stadium) slot per hole position, about
  5mm wide x 15mm tall, ~2.5mm rounded ends** — [Pegboardly, "SKÅDIS Sizes &
  Dimensions"](https://pegboardly.com/skadis/skadis-sizes-and-dimensions)
  and [Thingiverse thing:4939659, "IKEA Skadis-like Hole
  Dimension"](https://www.thingiverse.com/thing:4939659).
- **Grid: 40mm pitch, and STAGGERED** — every other column is offset 20mm
  vertically from its neighbours (two interleaved 40mm grids, half a step
  apart), per the same two sources plus multiple SKÅDIS-accessory generator
  listings on MakerWorld/Printables. Implemented as `SKADIS_ROW_STAGGER`
  (constants.ts) and `layoutMountPlate`'s `columnStagger` parameter
  (mountPlate.ts).
- **Clip mechanism, confirmed directly from skapa's own source**
  (`github.com/nmattia/skapa`, `src/model/manifold.ts` — read for its
  measurements and placement math only, NOT copied; skapa has no licence,
  and its own review note already says "reimplement the technique, don't
  copy files"): the 7-point polygon §10b already recorded is correct DATA,
  but this PR's first pass had its AXES wrong — the polygon's own two
  coordinates are (sideways offset from the pair's own centreline, reach
  into the slot), and the 12mm extrusion runs along the board's VERTICAL
  axis (WALL_UP), not sideways. Two legs (~1.5mm each, ~1.9mm gap between
  them) form ONE mirrored, spring-loaded PAIR per grid position — they flex
  inward to pass through the ~5mm slot opening, then spring back out
  (combined rest span ~6.1mm, wider than the slot) once through, so the
  barb catches behind the board. This is a **spring/expanding clip, not a
  gravity-engaged hook** like the screw-keyhole mount — there's no
  "barb must face down" requirement the way a keyhole slot has one.
  Chamfering: skapa chamfers every row except its first/lowest — mirrored
  here as `SKADIS_CLIP_PROFILE_CHAMFERED` applying to every row except the
  lowest (`ClipInstance.plain`), the opposite of this PR's own first pass.
- A previous version of this PR had `side` and `WALL_UP` swapped in the
  clip's own local frame — caught from the mount-side screenshot (each
  clip rendered as a wide horizontal bar instead of a tall vertical one).
  Fixed in `manifold.ts`'s `skadisHookSolid` / `step/build.ts`'s
  `skadisHookSolidStep` (an extra 90° rotation) and `mountPlate.ts`'s
  `skadisClipHalfExtents` (the half-extents were swapped too).
- Real-board fit (does a printed pair actually seat and hold on a genuine
  SKÅDIS board) is **still unverified** — flagged in issue #1's own
  "Further Notes" ("Values still to verify with real hardware: the SKÅDIS
  clip fit and openGrid pitch...") and repeated in this PR's own body; the
  clip half-extents, grid/stagger math and chamfer selection are covered by
  vitest, but the physical engagement (does the spring-fit actually grip,
  does the board thickness assumption hold) is not.

**openGrid.** Researched fresh for this ticket (WebSearch + `gh api` against
the project's own GitHub docs repo, since `opengrid.world` itself returned
HTTP 403 to a direct fetch from this sandbox):
- Grid pitch: **28×28mm**, stated directly in openGrid's own docs —
  `github.com/openGrid-3D/openGrid-docs`, `src/content/docs/guides/board.mdx`:
  "The board system uses a 28×28mm grid pattern," and again under "Gridfinity
  Compatibility": "3 openGrid units = 84mm (3 × 28mm)." Corroborated
  independently by Printables/MakerWorld listings ("28mm grid size,
  Gridfinity-compatible"). This is the one openGrid number this ticket
  implements with confidence (`OPENGRID_PITCH`, constants.ts).
- Board thickness: Full board 6.8mm, Lite board 4mm (same docs repo,
  `guides/snaps.mdx` / `guides/board.mdx`) — not currently used by this
  ticket's geometry (the mount plate doesn't need to match board thickness),
  recorded here for whoever implements the real connector next.
- Licence: openGrid's own connector system and generator ("openConnect") is
  described as CC-BY (system) / CC-BY-SA (generator models) — see
  `github.com/mitufy/opengrid-projects` (OpenSCAD + BOSL2 snap/connector
  generator) and its Printables/MakerWorld listings.
- **The snap/connector's own engagement geometry (the shape that actually
  clicks into a 28mm board hole) is NOT published as text or plain
  dimensions anywhere in openGrid's docs** — only as STL/STEP downloads or
  parametric OpenSCAD source (`mitufy/opengrid-projects`), which this ticket
  did not reverse-engineer or import (out of scope for the time available,
  and copying a BOSL2-generated shape verbatim would need its own licence
  review). Per this ticket's own brief ("if the openGrid geometry can't be
  verified, implement SKÅDIS fully and leave openGrid behind a clearly
  marked TODO"): openGrid support ships with the **correct, verified grid
  pitch** but a **placeholder connector** (`OPENGRID_PLACEHOLDER_PEG_SIZE`/
  `OPENGRID_PLACEHOLDER_PEG_REACH`, constants.ts) — a plain square push-fit
  peg, not the real openGrid snap. Swapping in the real geometry (from
  `opengrid-projects`' own OpenSCAD source, reimplemented, or from
  measuring a printed board) is a follow-up, not done here.

**Mount plate mechanics (this ticket's own design, not sourced from either
project).** The plate is a flat panel, inset from the flange's own outline
by a fixed margin (`MOUNT_PLATE_EDGE_MARGIN`) so it always fits inside the
flange regardless of shape — see mountPlate.ts. Clips/glue-pegs/snap-tabs
are placed in a grid on the flange's own WALL_UP-aligned axis (mount.ts's
`bestAxisDeg`, the same axis the screw-keyhole mount already used), so a
non-round core still hangs level. A boolean-CSG hazard specific to small
features glued/cut flush against a flat face (not the curved-surface
`WELD_OVERLAP` hazard already documented above, but the flat-face
analogue) surfaced during implementation: an un-embedded ~2.4mm-radius
peg/hole, cut or fused exactly flush with its target face, silently failed
(passed `status()`/`genus()` but left a disconnected "ghost" copy on
`decompose()`) below roughly 3.3–3.5mm in this setup. Fixed by genuinely
embedding every such feature past its own attaching face by a fixed margin
(`MOUNT_PLATE_EMBED`, constants.ts) — see that constant's own doc comment.

## 10d. SKÅDIS fit check (issue #106, 2026-09-29)

User feedback: "the SKÅDIS mount doesn't really change the model in a way
that's applicable to SKÅDIS". The plate was hidden under the flange in every
default view, and the geometry had real faults.

**Board facts** (IKEA publishes no spec; community measurements that agree
across independent sources):

| Fact | Value | Sources |
|---|---|---|
| Slot | one vertical stadium per position, nominal 5 x 15 mm, measured as tight as 4.8 x 14.8 mm | [Pegboardly, SKÅDIS Sizes & Dimensions](https://pegboardly.com/skadis/skadis-sizes-and-dimensions); [jbazant/esp8266-binary-clock `case/skadis.scad`](https://github.com/jbazant/esp8266-binary-clock/blob/master/case/skadis.scad) (`SKADIS_HOLE_WIDTH=4.8`, `SKADIS_HOLE_LENGTH=14.8`) |
| Lattice | two 40 x 40 mm grids offset by (20, 20) mm: columns every 20 mm, slots every 40 mm in a column, neighbouring columns shifted 20 mm vertically. Two slots 40 mm apart in a row are on the SAME grid. | same `.scad` (`SPACING_X=20`, `SPACING_Y=40`, its 3-hook part uses (0, ±20) and (20, 0)); Pegboardly ("two 40 mm grids slid half a step apart") |
| Board thickness | about 5 mm: 5.1 mm in both [florianfesti/boxes `SkadisSettings`](https://github.com/florianfesti/boxes/blob/master/boxes/walledges.py) and the `.scad` above; hook makers ship variants for ~4.8 mm and 5.0-5.2 mm boards, and some boards are 4 mm | [Printables: Skadis Thickness Testers](https://www.printables.com/model/271676-skadis-thickness-testers), MakerWorld/Printables hook listings |

**What was wrong, and the fix:**
- **Lattice.** Issue #14 put clip columns at ±40, ±80 mm and shifted every
  other one by 20 mm vertically. Columns 40 mm apart are on the same grid,
  so the ±80 columns landed where no slot exists. Now every clip sits on one
  plain 40 x 40 grid (like skapa's `gw = gh = 40`), with the columns at
  ±20, ±60 mm so the layout stays mirrored and a 100 mm core still fits 2+
  columns.
- **Clip.** skapa's barb (facts only, no licence) widens from 3.7 mm and is
  flat from 4.3 to 5.9 mm out, so on a 5 mm board it only presses on the
  slot edge; issue #14 also shifted the whole clip 0.5 mm toward the plate
  (`MOUNT_PLATE_EMBED`), and its 4.9 mm-wide, 12 mm-tall legs are wider
  than a 4.8 mm slot and longer than a 14.8 mm stadium's straight part.
  The new pair: legs 4.4 mm across at rest (1.4 mm thick, 1.6 mm gap to
  flex), barb retaining face from 5.4 mm out (behind boards up to 5.2 mm),
  5.8 mm across (0.5 mm past a 4.8 mm slot per side), 45-degree ramps both
  ways, 11 mm long along WALL_UP. Only the root is embedded into the plate.
- **Printing.** The plate prints back-face up (clips pointing up), so the
  pegs/snap tabs on its FRONT face hung below the panel. Both mating faces
  now carry only blind holes, aligned with two 4.5 mm pieces of 1.75 mm
  filament, then glued. `pj=snap` links still parse and get the same plate
  with a warning. Pin holes also move off the inner-end keyhole (one
  grazing it added a tunnel through the core).
- **Visibility.** Selecting SKÅDIS switches the viewer to a new "Mount side"
  view (offered only while a SKÅDIS plate exists): the plate face-on from
  behind the wall with the slot grid (`Design.pegboard`) drawn in grey. The
  Wall mount view draws the board's slots behind the coil. The guide gets a
  "Fit the mount plate" step and a SKÅDIS mount step with the same slot grid.

**How the clip engages** (checked in `test/skadisFit.test.ts` on the real
plate mesh against a board built only from the facts above, for round,
square and triangle cores and 4.8 x 14.8 / 5 x 15 slots in 4, 5 and 5.2 mm
boards): push the plate flat against the board; each leg pair squeezes
through its slot and the barbs spring out behind the board. Let go and the
plate drops (about 0.5-0.7 mm) until each leg's bottom corner rests on the
slot's rounded bottom end, which carries the weight. Seated, nothing touches
the board; 0.2 mm lower, the clips dig into the slot bottoms; pulled off the
board, the barbs catch its back face within 0.7 mm of play on the thickest
board. Still not test-fitted on a physical board.

## 11. References

- Kernels: [replicad](https://github.com/sgenoud/replicad) · [opencascade.js](https://github.com/donalffons/opencascade.js) ([file size](https://ocjs.org/docs/getting-started/file-size), [custom builds](https://ocjs.org/docs/app-dev-workflow/custom-builds)) · [occt-wasm](https://github.com/andymai/occt-wasm) · [manifold](https://github.com/elalish/manifold) · [OCP.wasm](https://github.com/Yeicor/OCP.wasm) · [openscad-playground](https://github.com/openscad/openscad-playground)
- OCCT helix issues: [OCCT #1543](https://github.com/Open-Cascade-SAS/OCCT/issues/1543), [#1558](https://github.com/Open-Cascade-SAS/OCCT/issues/1558), [FreeCAD #18658](https://github.com/FreeCAD/FreeCAD/issues/18658)
- 3MF: [@jscad/3mf-serializer](https://www.npmjs.com/package/@jscad/3mf-serializer) · [lib3mf_emscripten](https://github.com/3MFConsortium/lib3mf_emscripten)
- Rendering: [three-edge-projection](https://github.com/gkjohnson/three-edge-projection) · [conditional lines demo](https://gkjohnson.github.io/threejs-sandbox/conditional-lines/) · [webgl-outlines](https://github.com/OmarShehata/webgl-outlines) ([article](https://omar-shehata.medium.com/how-to-render-outlines-in-webgl-8253c14724f9)) · [pmndrs/postprocessing](https://github.com/pmndrs/postprocessing) · [exploded view in R3F](https://blog.anaili.fr/articles/exploded) · [IKEA → Noto](https://www.itsnicethat.com/news/ikea-changes-typeface-to-noto-monotype-google-graphic-design-210819)
- Prior art: [Cable Tidy Spool (OpenSCAD)](https://github.com/Uko/Cable-Tidy-Spool-OpenSCAD) · [Wire spool BOSL2](https://www.printables.com/model/392001) · [Parametric cord winder](https://www.printables.com/model/126210-parametric-cord-winder) · [MakerWorld cable winder](https://makerworld.com/en/models/16590) · [BOSL2 threading](https://github.com/BelfrySCAD/BOSL2/wiki/threading.scad). None of these sizes the spool from the wire length, which is our differentiator.
- Winding math: [Orthocyclic winding](https://www.e-magnetica.pl/doku.php/orthocyclic_winding) · [Coil winding technology](https://en.wikipedia.org/wiki/Coil_winding_technology) · [Rounded rectangle perimeter](https://mathworld.wolfram.com/RoundedRectangle.html) · [Quabbin reel capacity](https://www.quabbin.com/tech-briefs/method-calculate-capacity-reel-or-spool) · [NEMA WC26](https://www.nema.org/docs/default-source/standards-document-library/nema-wc26-2008-final.pdf)
- Bend radius: [Anixter](https://www.anixter.com/en_us/resources/literature/wire-wisdom/minimum-bend-radius.html) · [Comms-Express](https://www.comms-express.com/infozone/article/bend-radius/)
- FDM tolerances: [Zbotic](https://zbotic.in/3d-printing-tolerances-designing-gaps-for-press-fits-threads-and-snap-fits/) · [Formlabs snap-fits](https://formlabs.com/global/blog/designing-3d-printed-snap-fit-enclosures/)
