// Overall-dimension axes (issue #69, replacing #50's 2D SVG overlay): three
// measurement axes -- width, depth and height (the coil axis) -- drawn as
// real 3D scene objects along the edges of the assembled model's bounding
// box, a small gap outside it, so they rotate and zoom with the model in
// every preset and during orbit. The box is spun about the coil axis to sit
// flush with the flange's flats (see measureDimensionFrame).
//
// Layout (in that box's own frame, inside a group carrying the spin plus
// the view rotation CoilViewer applies to the part geometries), issue #86:
// all three axes start from ONE origin, like a coordinate-axes gizmo. It is
// a bottom corner of the box, pushed a small gap out from it: of the two
// corners furthest out to either side on screen (the box's silhouette
// corners), the one nearest the camera. The height rises straight from it,
// beside the silhouette's corner edge, so it never crosses the model on
// screen (the bottom corner nearest the camera outright would, in Iso: its
// vertical edge runs down the middle of the model's image). Each ground axis
// runs back along the box's bottom edge from the origin when that edge is
// on the box's silhouette; the other one would pass behind the model there,
// so it points outward from the origin instead, away from the box -- in
// Iso the three axes form the classic tripod. The camera fit reserves room
// for that outward axis in each preset (dimensionFramePoints). The layout
// is re-picked every frame, so it follows a free orbit; as the orbit isn't
// reframed, an outward axis that would run off the canvas switches to the
// other side when that one fits better. An axis seen nearly end-on is
// hidden rather than drawn misleadingly short.
//
// Rendering: the strokes (lines, tick bars, arrowheads) are flat,
// camera-facing black triangles sized in screen pixels, rebuilt as the
// render that draws them starts (so they always use the camera
// LineArtRenderer has just framed). They live on DIMENSION_LINE_LAYER, which LineArtRenderer
// draws after its edge pipeline but before FXAA: the edge detector never sees
// them (no smeared double outlines), yet they are antialiased like the model's
// lines. The cm labels are sprites (always facing the camera, always upright)
// on DIMENSION_LABEL_LAYER, drawn last, straight onto the canvas, so the
// canvas-rendered text isn't blurred by FXAA.

import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { Part } from "../core";
import { DIMENSION_LABEL_LAYER, DIMENSION_LINE_LAYER } from "./lineArt/LineArtRenderer";
import { LABEL_FONT_PX, LABEL_PAD_Y_PX, labelTexture, makeLabelSprite, StrokeBuilder } from "./screenSpaceInk";

// Screen-space sizes, CSS px. The dimension line is drawn bolder than the
// model's own ~1-1.6px pen line (LineArtRenderer's MIN/MAX_LINE_WEIGHT).
const LINE_PX = 3;
const EXTENSION_PX = 1.2;
// Room an outward-pointing axis's end keeps from the canvas edge (for its label).
const EDGE_ROOM_PX = 40;
// The dot marking the axes' shared origin.
const ORIGIN_DOT_PX = 7;
const TICK_PX = 12;
const ARROW_LENGTH_PX = 13;
const ARROW_HALF_WIDTH_PX = 4.5;
// Below this on-screen length an axis is hidden; a short one draws its
// arrowheads outside, on leaders this long past them.
const MIN_AXIS_PX = 6;
const SHORT_LEAD_PX = 6;
// |sin| of the on-screen angle below which a ground axis counts as running
// along the height axis.
const PARALLEL_SIN = 0.5;
const LABEL_GAP_PX = 5;
// The axes sit this far outside the box: a fraction of the footprint's size
// (not the height -- a tall, slim coil would push them far off to the side),
// floored so a tiny coil still gets clear air.
const GAP_FRACTION = 0.08;
const MIN_GAP_MM = 4;
// Room the camera fit reserves past the axes for their labels, as a fraction
// of the model's largest extent: the labels are a fixed size in pixels, and
// the frame's own size follows that extent.
const FRAME_LABEL_ROOM = 0.04;
// Projected length below this fraction of the true length: hidden.
const FORESHORTEN_MIN = 0.25;

export interface DimensionLabels {
  width: string;
  depth: string;
  height: string;
}

export interface DimensionAxesProps {
  /** The box to measure, in measureDimensionFrame's spun frame, mm. */
  box: THREE.Box3;
  /** Lowest local Z of any part (a mount plate may sit below the flange): the ground axes run below this. */
  groundZ: number;
  /** The spun frame to world: CoilViewer's view rotation times measureDimensionFrame's spin. */
  rotation: THREE.Matrix4 | null;
  labels: DimensionLabels;
}

type AxisId = keyof DimensionLabels;

/** Convex hull of 2D points (Andrew's monotone chain). */
function hull2d(points: [number, number][]): [number, number][] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: [number, number][]) => {
    const out: [number, number][] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    return out.slice(0, -1);
  };
  return half(pts).concat(half([...pts].reverse()));
}

// Spin steps tried for the flush footprint, and how much smaller than the
// unspun box a spun one must be to count (a round flange's box is the same
// at every angle: it stays on the model's own X/Y).
const SPIN_STEPS = 360;
const SPIN_MIN_GAIN = 0.01;

/**
 * The frame the dimension axes measure in: the assembled core + cap's box (a
 * mount plate under the flange only lowers `groundZ`, where the ground axes
 * run), in the parts' local frame spun about the coil axis by `spin` so the
 * box sits flush against the flange's flat sides -- the smallest-area
 * footprint rectangle. A square flange then measures across its flats (the
 * result panel's flange width) on both axes, and a triangle its flat base
 * and base-to-apex height, instead of the corner-to-corner extents an
 * unspun box would give.
 *
 * `forcedSpinRad`, when given, skips that area search and uses this exact
 * angle instead (issue #79): a heavily-rounded triangle can have its true
 * minimal-area angle sit at a "corner-through-the-axis" orientation instead
 * of a flat-flush one (the two are only EXACTLY tied for a shape with a
 * rotational symmetry matching the box's own -- true for round/square, not
 * for a triangle's odd corner count) -- close enough in area that the
 * search's plain `<` picks whichever it meets first, not necessarily the
 * flat-flush one. CoilViewer passes the SAME angle `frontFacingRotation`
 * rotates the mesh by (negated), so the box stays flush with the identical
 * flat the standing view now faces, rather than an independently-found one.
 */
export function measureDimensionFrame(parts: Part[], forcedSpinRad?: number): { box: THREE.Box3; groundZ: number; spin: THREE.Matrix4 } {
  let groundZ = Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const footprint: [number, number][] = [];
  for (const part of parts) {
    const pos = part.mesh.positions;
    for (let i = 0; i < pos.length; i += 3) {
      groundZ = Math.min(groundZ, pos[i + 2]);
      if (part.role === "mountPlate") continue;
      minZ = Math.min(minZ, pos[i + 2]);
      maxZ = Math.max(maxZ, pos[i + 2]);
      footprint.push([pos[i], pos[i + 1]]);
    }
  }
  const outline = hull2d(footprint);
  // The footprint's bounds in a frame turned by `angle` about Z.
  const boundsAt = (angle: number) => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of outline) {
      const u = c * x + s * y;
      const v = -s * x + c * y;
      x0 = Math.min(x0, u);
      x1 = Math.max(x1, u);
      y0 = Math.min(y0, v);
      y1 = Math.max(y1, v);
    }
    return { angle, x0, x1, y0, y1, area: (x1 - x0) * (y1 - y0) };
  };
  const unspun = boundsAt(0);
  let best = unspun;
  if (forcedSpinRad !== undefined) {
    best = boundsAt(forcedSpinRad);
  } else {
    for (let i = 1; i < SPIN_STEPS; i++) {
      const b = boundsAt((i / SPIN_STEPS) * Math.PI);
      if (b.area < best.area && b.area < unspun.area * (1 - SPIN_MIN_GAIN)) best = b;
    }
  }
  return {
    box: new THREE.Box3(new THREE.Vector3(best.x0, best.y0, minZ), new THREE.Vector3(best.x1, best.y1, maxZ)),
    groundZ,
    // Frame -> local: a point at (u, v) in the spun frame is at angle + its own angle in local.
    spin: new THREE.Matrix4().makeRotationZ(best.angle),
  };
}

function gapFor(box: THREE.Box3): number {
  const extent = box.getSize(new THREE.Vector3());
  return Math.max(MIN_GAP_MM, GAP_FRACTION * Math.max(extent.x, extent.y));
}

/** The view, in the measured box's own frame: unit vectors toward the camera and along the screen's right and up. */
export interface AxesView {
  toward: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
}

interface Arm {
  id: AxisId;
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** Ticked where it meets the box (inward), or starting at the origin itself (outward). */
  outward: boolean;
}

interface AxesLayout {
  origin: THREE.Vector3;
  arms: Arm[];
}

/**
 * Where the three axes can go for a view (see the file header): the
 * origin, a bottom corner of the box pushed `gap` outside it, and each
 * axis's span. Two layouts, one per side of the model on screen, the
 * preferred one first.
 */
function layoutAxes(box: THREE.Box3, groundZ: number, { toward, right, up }: AxesView): [AxesLayout, AxesLayout] {
  const gap = gapFor(box);
  const center = box.getCenter(new THREE.Vector3());
  const x = (s: number) => (s > 0 ? box.max.x : box.min.x);
  const y = (s: number) => (s > 0 ? box.max.y : box.min.y);
  const zg = Math.min(groundZ, box.min.z) - gap;
  const corner = (sx: number, sy: number) => new THREE.Vector3(x(sx) + sx * gap, y(sy) + sy * gap, zg);

  // Sideways on screen: across the height axis's own on-screen direction
  // (plain screen x when the height is seen end-on).
  let hx = up.z;
  let hy = -right.z;
  const hl = Math.hypot(hx, hy);
  [hx, hy] = hl > 1e-6 ? [hx / hl, hy / hl] : [1, 0];
  // (right.z, up.z) is the height's screen direction; (hx, hy) above is it turned a quarter to the right.
  const sideways = (p: THREE.Vector3) => {
    const d = p.clone().sub(center);
    return d.dot(right) * hx + d.dot(up) * hy;
  };

  // The origin: of the corners furthest out to either side on screen (the
  // box's silhouette corners), the one nearest the camera; a tie goes
  // right, away from the toggles at the viewer's top left.
  const eps = 1e-3 * box.getSize(new THREE.Vector3()).length();
  const corners = [-1, 1].flatMap((sx) => [-1, 1].map((sy) => ({ sx, sy, side: sideways(corner(sx, sy)), depth: corner(sx, sy).sub(center).dot(toward) })));
  const extreme = (sign: number) => {
    const most = Math.max(...corners.map((c) => sign * c.side));
    return corners.filter((c) => sign * c.side >= most - eps).reduce((a, b) => (b.depth > a.depth ? b : a));
  };
  const rightmost = extreme(1);
  const leftmost = extreme(-1);
  const sides = leftmost.depth > rightmost.depth + eps ? [leftmost, rightmost] : [rightmost, leftmost];
  const above = toward.z >= 0;
  return [at(sides[0].sx, sides[0].sy), at(sides[1].sx, sides[1].sy)];

  function at(sx: number, sy: number): AxesLayout {
    const origin = corner(sx, sy);

    // A ground axis runs back along the box's bottom edge from the origin
    // when that edge is on the box's silhouette: seen from above the ground,
    // when the side face it bounds is turned toward the camera (from below,
    // away from it). Otherwise the model would cover it on screen, and it
    // points outward from the origin instead, away from the box.
    const width: Arm =
      toward.y * sy > 0 === above
        ? { id: "width", from: new THREE.Vector3(x(-sx), origin.y, zg), to: new THREE.Vector3(x(sx), origin.y, zg), outward: false }
        : { id: "width", from: origin.clone(), to: origin.clone().setX(origin.x + sx * (box.max.x - box.min.x)), outward: true };
    const depth: Arm =
      toward.x * sx > 0 === above
        ? { id: "depth", from: new THREE.Vector3(origin.x, y(-sy), zg), to: new THREE.Vector3(origin.x, y(sy), zg), outward: false }
        : { id: "depth", from: origin.clone(), to: origin.clone().setY(origin.y + sy * (box.max.y - box.min.y)), outward: true };
    const height: Arm = { id: "height", from: origin.clone().setZ(box.min.z), to: origin.clone().setZ(box.max.z), outward: false };
    return { origin, arms: [width, depth, height] };
  }
}

/**
 * Extra points (local frame, xyz triples) for the camera fit, so the axes
 * and their labels stay inside the frame in `view`: the box grown by room
 * for the axes plus a label beyond them, and the far end of any axis that
 * points outward from the origin in that view.
 */
export function dimensionFramePoints(box: THREE.Box3, groundZ: number, view: AxesView): Float32Array {
  const gap = gapFor(box);
  const extent = box.getSize(new THREE.Vector3());
  const room = gap + FRAME_LABEL_ROOM * Math.max(extent.x, extent.y, extent.z);
  const zs = [Math.min(groundZ, box.min.z) - room, box.max.z];
  const out: number[] = [];
  for (const x of [box.min.x - room, box.max.x + room]) for (const y of [box.min.y - room, box.max.y + room]) for (const z of zs) out.push(x, y, z);
  const [{ origin, arms }] = layoutAxes(box, groundZ, view);
  for (const arm of arms) {
    if (!arm.outward) continue;
    // Room past its far end, and on either side of it for its label.
    const along = arm.to.clone().sub(origin).setLength(room);
    const across = new THREE.Vector3(along.y, -along.x, 0);
    for (const p of [arm.to.clone().add(along), arm.to.clone().add(across), arm.to.clone().sub(across), arm.to.clone().setZ(zs[0])]) out.push(p.x, p.y, p.z);
  }
  return new Float32Array(out);
}

export function DimensionAxes({ box, groundZ, rotation, labels }: DimensionAxesProps) {
  const group = useMemo(() => {
    const g = new THREE.Group();
    g.matrixAutoUpdate = false;
    return g;
  }, []);

  const strokes = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
    const material = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.layers.set(DIMENSION_LINE_LAYER);
    mesh.frustumCulled = false;
    return mesh;
  }, []);

  const sprites = useMemo(() => {
    const make = () => {
      const sprite = makeLabelSprite(DIMENSION_LABEL_LAYER);
      sprite.visible = false;
      return sprite;
    };
    return { width: make(), depth: make(), height: make() } as Record<AxisId, THREE.Sprite>;
  }, []);

  useEffect(() => {
    group.add(strokes, sprites.width, sprites.depth, sprites.height);
    return () => {
      group.remove(strokes, sprites.width, sprites.depth, sprites.height);
      strokes.geometry.dispose();
      (strokes.material as THREE.Material).dispose();
      for (const s of Object.values(sprites)) {
        s.material.map?.dispose();
        s.material.dispose();
      }
    };
  }, [group, strokes, sprites]);

  useEffect(() => {
    group.matrix.copy(rotation ?? new THREE.Matrix4());
    group.matrixWorldNeedsUpdate = true;
  }, [group, rotation]);

  // Label textures: rebuilt when the text changes, and once more when the
  // UI webfont finishes loading (the first draw may have used a fallback).
  const sizes = useMemo(() => new Map<AxisId, { w: number; h: number }>(), []);
  useEffect(() => {
    let cancelled = false;
    const draw = () => {
      if (cancelled) return;
      for (const id of Object.keys(sprites) as AxisId[]) {
        const { texture, widthPx, heightPx } = labelTexture(labels[id]);
        sprites[id].material.map?.dispose();
        sprites[id].material.map = texture;
        sprites[id].material.needsUpdate = true;
        sizes.set(id, { w: widthPx, h: heightPx });
      }
    };
    draw();
    document.fonts?.ready.then(draw);
    return () => {
      cancelled = true;
    };
  }, [labels, sprites, sizes]);

  // Everything view-dependent is rebuilt at the start of the render that
  // draws the strokes (scene.onBeforeRender runs before three uploads the
  // geometry; a mesh's own onBeforeRender would be too late for that).
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const inverse = new THREE.Matrix4();
    const update = (renderer: THREE.WebGLRenderer, camera: THREE.Camera) => {
      inverse.copy(group.matrixWorld).invert();
      const size = renderer.getSize(new THREE.Vector2());
      const center = box.getCenter(new THREE.Vector3());
      // Toward the camera, in the local frame.
      const view = camera.getWorldDirection(new THREE.Vector3()).negate().transformDirection(inverse);
      let pixel: number; // mm per CSS px at the model
      if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
        const c = camera as THREE.OrthographicCamera;
        pixel = (c.top - c.bottom) / c.zoom / Math.max(1, size.y);
      } else {
        const c = camera as THREE.PerspectiveCamera;
        const camLocal = c.getWorldPosition(new THREE.Vector3()).applyMatrix4(inverse);
        pixel = (2 * camLocal.distanceTo(center) * Math.tan(THREE.MathUtils.degToRad(c.fov) / 2)) / c.zoom / Math.max(1, size.y);
      }

      // On-screen position (CSS px, y up) relative to the box centre.
      const right = new THREE.Vector3(1, 0, 0).transformDirection(camera.matrixWorld).transformDirection(inverse);
      const up = new THREE.Vector3(0, 1, 0).transformDirection(camera.matrixWorld).transformDirection(inverse);
      const toScreen = (p: THREE.Vector3) => {
        const d = p.clone().sub(center);
        return new THREE.Vector2(d.dot(right) / pixel, d.dot(up) / pixel);
      };
      // The preferred layout, unless an axis pointing outward would run
      // further off the canvas (a free orbit isn't reframed) than the other
      // side's would.
      const ndc = new THREE.Vector3();
      const overflowPx = (p: THREE.Vector3) => {
        ndc.copy(p).applyMatrix4(group.matrixWorld).project(camera);
        return Math.max(0, ((Math.abs(ndc.x) + 1) / 2) * size.x - size.x + EDGE_ROOM_PX, ((Math.abs(ndc.y) + 1) / 2) * size.y - size.y + EDGE_ROOM_PX);
      };
      const overflow = (l: AxesLayout) => Math.max(0, ...l.arms.filter((a) => a.outward).map((a) => overflowPx(a.to)));
      const [preferred, other] = layoutAxes(box, groundZ, { toward: view, right, up });
      const { origin, arms } = overflow(other) + 1 < overflow(preferred) ? other : preferred;

      const b = new StrokeBuilder(view, pixel);
      const labelAt = new Map<AxisId, THREE.Vector3>();
      const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];

      // Seen well enough to draw: not nearly end-on, and long enough on
      // screen for its two arrowheads.
      const shown = (from: THREE.Vector3, to: THREE.Vector3) => {
        const dir = to.clone().sub(from);
        const length = dir.length();
        const projected = new THREE.Vector3().crossVectors(dir.normalize(), view).length(); // |sin| of the angle to the view ray
        return projected >= FORESHORTEN_MIN && (length * projected) / pixel >= MIN_AXIS_PX;
      };

      const dimension = (id: AxisId, from: THREE.Vector3, to: THREE.Vector3) => {
        const dir = to.clone().sub(from).normalize();
        const onScreenPx = (from.distanceTo(to) * new THREE.Vector3().crossVectors(dir, view).length()) / pixel;
        if (onScreenPx >= 2 * ARROW_LENGTH_PX + 4) {
          // Arrowheads inside, pointing out at the tick bars.
          b.segment(from.clone().addScaledVector(dir, ARROW_LENGTH_PX * pixel * 0.8), to.clone().addScaledVector(dir, -ARROW_LENGTH_PX * pixel * 0.8), LINE_PX);
          b.arrow(from, dir.clone().negate(), ARROW_LENGTH_PX, ARROW_HALF_WIDTH_PX);
          b.arrow(to, dir, ARROW_LENGTH_PX, ARROW_HALF_WIDTH_PX);
        } else {
          // Too short for that (a slim coil's footprint): arrowheads outside,
          // pointing in, the drafting convention for a small span.
          const lead = (ARROW_LENGTH_PX + SHORT_LEAD_PX) * pixel;
          b.segment(from.clone().addScaledVector(dir, -lead), to.clone().addScaledVector(dir, lead), LINE_PX);
          b.arrow(from, dir, ARROW_LENGTH_PX, ARROW_HALF_WIDTH_PX);
          b.arrow(to, dir.clone().negate(), ARROW_LENGTH_PX, ARROW_HALF_WIDTH_PX);
        }
        const tick = b.perp(dir).multiplyScalar((TICK_PX / 2) * pixel);
        b.segment(from.clone().add(tick), from.clone().sub(tick), LINE_PX);
        b.segment(to.clone().add(tick), to.clone().sub(tick), LINE_PX);

        // Label beside the line's midpoint, on the side away from the model.
        const mid = from.clone().add(to).multiplyScalar(0.5);
        const n = b.perp(dir);
        const midScreen = toScreen(mid);
        const nScreen = toScreen(mid.clone().add(n)).sub(midScreen).normalize();
        if (nScreen.dot(midScreen) < 0) {
          n.negate();
          nScreen.negate();
        }
        const s = sizes.get(id) ?? { w: 60, h: LABEL_FONT_PX + 2 * LABEL_PAD_Y_PX };
        const reach = Math.abs(nScreen.x) * (s.w / 2) + Math.abs(nScreen.y) * (s.h / 2) + LABEL_GAP_PX + TICK_PX / 4;
        const at = mid.addScaledVector(n, reach * pixel);
        // Axes sharing an origin can be short enough (a slim coil's
        // footprint) for their labels to collide: slide this one out along
        // its axis, away from the origin, until it is clear of the others.
        const away = to.clone().add(from).multiplyScalar(0.5).sub(origin);
        if (away.lengthSq() > 1e-12) away.normalize();
        const rect = () => {
          const c = toScreen(at);
          return { x0: c.x - s.w / 2, x1: c.x + s.w / 2, y0: c.y - s.h / 2, y1: c.y + s.h / 2 };
        };
        const clashes = () => {
          const r = rect();
          return placed.some((o) => r.x0 < o.x1 + LABEL_GAP_PX && o.x0 < r.x1 + LABEL_GAP_PX && r.y0 < o.y1 + LABEL_GAP_PX && o.y0 < r.y1 + LABEL_GAP_PX);
        };
        for (let step = 0; step < 100 && clashes(); step++) at.addScaledVector(away, 2 * pixel);
        placed.push(rect());
        labelAt.set(id, at);
      };

      // A ground axis reading parallel to the height on screen (a square's
      // depth, seen face-on from above) would run along it from the shared
      // origin and pass for a second height: left out while the height is
      // drawn.
      const zScreen = toScreen(center.clone().add(new THREE.Vector3(0, 0, 1))).normalize();
      const alongHeight = (arm: Arm) => {
        const d = toScreen(center.clone().add(arm.to).sub(arm.from));
        const len = d.length();
        return len > 1e-9 && Math.abs(d.x * zScreen.y - d.y * zScreen.x) / len < PARALLEL_SIN;
      };
      const height = arms.find((a) => a.id === "height")!;
      const H = shown(height.from, height.to);
      // (The height first: its label keeps its place, the ground axes' move.)
      for (const arm of [height, ...arms.filter((a) => a !== height)]) {
        if (!shown(arm.from, arm.to) || (arm !== height && H && alongHeight(arm))) continue;
        dimension(arm.id, arm.from, arm.to);
        // A thin extension line joins it to the shared origin, from the
        // tick where it meets the box (an outward axis starts at the origin).
        const near = arm.from.distanceToSquared(origin) < arm.to.distanceToSquared(origin) ? arm.from : arm.to;
        if (near.distanceTo(origin) > 1e-6) b.segment(near, origin, EXTENSION_PX);
      }
      b.dot(origin, ORIGIN_DOT_PX / 2);

      const geometry = strokes.geometry;
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(b.out, 3));
      for (const id of Object.keys(sprites) as AxisId[]) {
        const sprite = sprites[id];
        const at = labelAt.get(id);
        sprite.visible = !!at;
        if (!at) continue;
        const s = sizes.get(id) ?? { w: 60, h: LABEL_FONT_PX + 2 * LABEL_PAD_Y_PX };
        sprite.position.copy(at);
        sprite.scale.set(s.w * pixel, s.h * pixel, 1);
        sprite.updateMatrix();
      }
    };
    const previous = scene.onBeforeRender;
    scene.onBeforeRender = function (this: THREE.Scene, ...args: Parameters<THREE.Scene["onBeforeRender"]>) {
      previous.apply(this, args);
      const [renderer, , camera] = args;
      if (camera.layers.isEnabled(DIMENSION_LINE_LAYER)) update(renderer, camera);
    };
    return () => {
      scene.onBeforeRender = previous;
    };
  }, [scene, strokes, sprites, group, box, groundZ, sizes]);

  return <primitive object={group} />;
}
