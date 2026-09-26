import type { Vec3 } from "./gcode";
import { tipProfile, type Tool } from "./tools";

export interface StockSpec {
  /** X size (mm). Stock spans x ∈ [0, width]. */
  width: number;
  /** Y size (mm). Stock spans y ∈ [0, depth]. */
  depth: number;
  /** Z size (mm). Top face is Z0, bottom is -height. */
  height: number;
}

export interface CutResult {
  /** Removed volume (mm³). */
  removed: number;
  /** Deepest side-cutting engagement below the old surface (mm). */
  engagement: number;
  /** Material above the flutes, i.e. the holder would hit it (mm). */
  holderOverlap: number;
}

export interface DirtyRect {
  i0: number;
  j0: number;
  i1: number;
  j1: number;
}

/**
 * 2.5D stock: one height per grid cell. Good enough for facing, pockets,
 * contours, drilling and 3-axis surfacing; cannot represent undercuts.
 */
export class Heightmap {
  readonly nx: number;
  readonly ny: number;
  readonly cell: number;
  readonly heights: Float32Array;
  dirty: DirtyRect | null = null;
  /** Bumped on every change so views can tell when to redraw. */
  version = 0;

  constructor(
    readonly spec: StockSpec,
    maxCells = 320,
  ) {
    this.cell = Math.max(spec.width, spec.depth) / maxCells;
    this.cell = Math.max(0.2, Math.ceil(this.cell * 20) / 20);
    this.nx = Math.max(2, Math.round(spec.width / this.cell));
    this.ny = Math.max(2, Math.round(spec.depth / this.cell));
    this.heights = new Float32Array(this.nx * this.ny);
  }

  reset() {
    this.heights.fill(0);
    this.markAllDirty();
  }

  markAllDirty() {
    this.markDirty(0, 0, this.nx - 1, this.ny - 1);
  }

  /** Cell center, in work coordinates. */
  cx(i: number) {
    return ((i + 0.5) * this.spec.width) / this.nx;
  }
  cy(j: number) {
    return ((j + 0.5) * this.spec.depth) / this.ny;
  }

  at(i: number, j: number) {
    return this.heights[j * this.nx + i];
  }

  /** Top of material at an XY point, or -Infinity outside the stock. */
  heightAt(x: number, y: number) {
    const i = Math.floor((x / this.spec.width) * this.nx);
    const j = Math.floor((y / this.spec.depth) * this.ny);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return -Infinity;
    return this.at(i, j);
  }

  private markDirty(i0: number, j0: number, i1: number, j1: number) {
    const d = this.dirty;
    this.dirty = d
      ? {
          i0: Math.min(d.i0, i0),
          j0: Math.min(d.j0, j0),
          i1: Math.max(d.i1, i1),
          j1: Math.max(d.j1, j1),
        }
      : { i0, j0, i1, j1 };
    this.version++;
  }

  /**
   * Sweep the tool tip from a to b and lower every cell it passes over.
   * For each cell we find the lowest point of the tool over it, which is
   * convex in t, so a short golden-section search is exact enough.
   */
  cut(a: Vec3, b: Vec3, tool: Tool, apply = true): CutResult {
    const result: CutResult = { removed: 0, engagement: 0, holderOverlap: 0 };
    const r = tool.diameter / 2;
    const { nx, ny, heights } = this;
    const sx = this.spec.width / nx;
    const sy = this.spec.depth / ny;
    const zMax = Math.max(a.z, b.z);
    const zLow = Math.min(a.z, b.z);
    const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - r) / sx));
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x) + r) / sx));
    const j0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - r) / sy));
    const j1 = Math.min(ny - 1, Math.ceil((Math.max(a.y, b.y) + r) / sy));
    if (i0 > i1 || j0 > j1) return result;

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len2 = dx * dx + dy * dy;
    const r2 = r * r;
    const cellArea = sx * sy;
    let touched = false;
    let di0 = nx,
      dj0 = ny,
      di1 = -1,
      dj1 = -1;

    for (let j = j0; j <= j1; j++) {
      const py = (j + 0.5) * sy;
      for (let i = i0; i <= i1; i++) {
        const idx = j * nx + i;
        const h = heights[idx];
        if (h <= zLow) continue; // tool never gets below this surface
        const px = (i + 0.5) * sx;
        // Range of t where the cell is under the tool footprint.
        const ox = a.x - px;
        const oy = a.y - py;
        let t0: number, t1: number;
        if (len2 < 1e-12) {
          if (ox * ox + oy * oy > r2) continue;
          t0 = 0;
          t1 = 1;
        } else {
          const B = 2 * (ox * dx + oy * dy);
          const C = ox * ox + oy * oy - r2;
          const disc = B * B - 4 * len2 * C;
          if (disc < 0) continue;
          const s = Math.sqrt(disc);
          t0 = Math.max(0, (-B - s) / (2 * len2));
          t1 = Math.min(1, (-B + s) / (2 * len2));
          if (t0 > t1) continue;
        }
        const zAt = (t: number) => {
          const qx = ox + dx * t;
          const qy = oy + dy * t;
          return a.z + dz * t + tipProfile(tool, Math.sqrt(qx * qx + qy * qy));
        };
        let low: number;
        if (tool.tip === "flat") {
          low = Math.min(a.z + dz * t0, a.z + dz * t1);
        } else {
          let lo = t0,
            hi = t1;
          for (let k = 0; k < 18 && hi - lo > 1e-4; k++) {
            const m1 = lo + (hi - lo) * 0.382;
            const m2 = lo + (hi - lo) * 0.618;
            if (zAt(m1) < zAt(m2)) hi = m2;
            else lo = m1;
          }
          low = Math.min(zAt((lo + hi) / 2), zAt(t0), zAt(t1));
        }
        low = Math.max(low, -this.spec.height);
        if (low >= h) continue;
        // Side engagement: how far below the old surface the tool sits while
        // moving sideways. Pure plunges report 0 so drilling is allowed.
        if (len2 > 1e-12)
          result.engagement = Math.max(
            result.engagement,
            h - Math.max(low, zLow),
          );
        result.holderOverlap = Math.max(
          result.holderOverlap,
          h - (zMax + tool.fluteLength),
        );
        result.removed += (h - low) * cellArea;
        if (apply) {
          heights[idx] = low;
          touched = true;
          if (i < di0) di0 = i;
          if (i > di1) di1 = i;
          if (j < dj0) dj0 = j;
          if (j > dj1) dj1 = j;
        }
      }
    }
    if (touched) this.markDirty(di0, dj0, di1, dj1);
    return result;
  }
}
