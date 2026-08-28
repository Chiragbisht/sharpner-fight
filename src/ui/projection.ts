import { TABLE_W, TABLE_H } from '../game/constants.ts';
import type { Point } from '../game/types.ts';

// The desk is drawn in perspective, but the physics stays a flat 2D plane in
// table units. This module is the only thing that knows about the camera: it
// maps table coordinates to screen coordinates and back, so input and rendering
// agree without the sim ever learning what a pixel is.
//
// Table dimensions are set per match, because the desk grows with the number of
// players.

const PITCH = 0.6; // camera tilt; 0 would be straight down
const SIN = Math.sin(PITCH);
const COS = Math.cos(PITCH);
const DIST = 1400; // camera distance, table units
const FOCAL = 1400; // equal to DIST, so scale is exactly 1 at the desk centre

/** A projected point plus the local scale factor at that depth. */
export interface Projected extends Point {
  s: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface FitOptions {
  widthFrac?: number;
  maxHeightFrac?: number;
  nearEdgeFrac?: number;
}

export interface Projection {
  fit(w: number, h: number, tableW?: number, tableH?: number, opts?: FitOptions): void;
  project(x: number, y: number): Projected;
  unproject(px: number, py: number): Point;
  transformAt(
    ctx: CanvasRenderingContext2D,
    base: number,
    x: number,
    y: number,
    lift?: number
  ): Projected;
  readonly scale: number;
  readonly bounds: Bounds;
  readonly table: { w: number; h: number };
}

export function createProjection(): Projection {
  let scale = 1;
  let ox = 0;
  let oy = 0;
  let tw = TABLE_W;
  let th = TABLE_H;
  let bounds: Bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };

  // Unscaled projection, centred on the origin.
  function raw(x: number, y: number) {
    const X = x - tw / 2;
    const Y = y - th / 2;
    const z = DIST - Y * SIN;
    const s = FOCAL / z;
    return { x: X * s, y: Y * COS * s, s, z, X, Y };
  }

  function fit(w: number, h: number, tableW = tw, tableH = th, opts: FitOptions = {}): void {
    const { widthFrac = 0.82, maxHeightFrac = 0.56, nearEdgeFrac = 0.9 } = opts;
    tw = tableW;
    th = tableH;

    const corners = [raw(0, 0), raw(tw, 0), raw(0, th), raw(tw, th)];
    bounds = {
      minX: Math.min(...corners.map((c) => c.x)),
      maxX: Math.max(...corners.map((c) => c.x)),
      minY: Math.min(...corners.map((c) => c.y)),
      maxY: Math.max(...corners.map((c) => c.y)),
    };
    const rawW = bounds.maxX - bounds.minX;
    const rawH = bounds.maxY - bounds.minY;

    scale = Math.min((w * widthFrac) / rawW, (h * maxHeightFrac) / rawH);
    ox = w / 2;
    oy = h * nearEdgeFrac - bounds.maxY * scale;
  }

  function project(x: number, y: number): Projected {
    const r = raw(x, y);
    return { x: ox + r.x * scale, y: oy + r.y * scale, s: r.s * scale };
  }

  // Screen -> table. Inverting the projection algebraically (rather than
  // searching for it) keeps drag input exact at every depth.
  function unproject(px: number, py: number): Point {
    const sx = (px - ox) / scale;
    const sy = (py - oy) / scale;
    const Y = (sy * DIST) / (FOCAL * COS + sy * SIN);
    const z = DIST - Y * SIN;
    const X = (sx * z) / FOCAL;
    return { x: X + tw / 2, y: Y + th / 2 };
  }

  /**
   * Set the canvas transform so that drawing in table-local coordinates around
   * (x, y) comes out correctly foreshortened — this is the projection's local
   * derivative, which is exact for a plane.
   *
   * `lift` raises the drawn object off the desk in screen pixels, which is how
   * a flat sprite gets thickness.
   */
  function transformAt(
    ctx: CanvasRenderingContext2D,
    base: number,
    x: number,
    y: number,
    lift = 0
  ): Projected {
    const X = x - tw / 2;
    const Y = y - th / 2;
    const z = DIST - Y * SIN;
    const p = project(x, y);

    const a = (FOCAL / z) * scale; // d(screenX)/d(tableX)
    const c = ((X * FOCAL * SIN) / (z * z)) * scale; // d(screenX)/d(tableY)
    const d = ((COS * FOCAL * DIST) / (z * z)) * scale; // d(screenY)/d(tableY)

    ctx.setTransform(base, 0, 0, base, 0, 0);
    ctx.transform(a, 0, c, d, p.x, p.y - lift);
    return p;
  }

  return {
    fit,
    project,
    unproject,
    transformAt,
    get scale() { return scale; },
    get bounds() { return bounds; },
    get table() { return { w: tw, h: th }; },
  };
}
