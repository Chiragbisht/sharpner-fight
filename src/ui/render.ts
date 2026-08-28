import { BODY_W, BODY_H, PUCK_R, POWER_UNITS, TABLE_W, TABLE_H } from '../game/constants.ts';
import { createProjection } from './projection.ts';
import { paintBackdrop, drawChalkScore } from './scene.ts';
import { getSkin, skinImage, skinSilhouette, DEFAULT_SKIN } from './skins.ts';
import { makeRng } from '../game/rng.ts';
import type { GameState, Point, Puck } from '../game/types.ts';
import type { BoardInfo } from './scene.ts';
import type { Skin } from './skins.ts';

// Presentation only. The renderer reads state and never writes to it — the sim
// has to stay reproducible, so drawing cannot influence it.
//
// PERFORMANCE: the classroom and the desk are both entirely static for a given
// window size and table size, yet they are by far the most expensive things on
// screen — gradients, a blurred contact shadow, wood grain, 58 scratches. They
// are painted once into an offscreen canvas and blitted, so a frame costs one
// full-screen copy plus the sharpeners. Redrawing them live was the difference
// between 2 fps and a smooth one.

const FALL_TICKS = 90; // how long a knocked-off sharpener animates for
const THICK = 17; // sharpener thickness, screen px at scale 1
const MAX_LAYERS = 10; // silhouette copies stacked to form the sides
const LAYER_GAP = 1.8; // screen px between copies; below this the sides look solid
const SPRITE = PUCK_R * 2.3;
const CARVED = ['Raj', 'A+J', 'IX-B', 'bunk']; // desk graffiti

interface Scratch {
  x: number;
  y: number;
  dx: number;
  dy: number;
  bow: number;
  alpha: number;
  width: number;
  light: boolean;
}

interface Dent {
  x: number;
  y: number;
  rx: number;
  ry: number;
  alpha: number;
}

// Years of being sat at. Generated once from a fixed seed, in 0..1 table space
// so the same desk history scales to any player count.
const DESK_MARKS = (() => {
  const rnd = makeRng(0x5c2a7c4);
  const scratches: Scratch[] = [];
  for (let i = 0; i < 58; i++) {
    const ang = rnd() * Math.PI * 2;
    const len = 0.02 + rnd() * 0.2;
    scratches.push({
      x: 0.02 + rnd() * 0.96,
      y: 0.03 + rnd() * 0.94,
      dx: Math.cos(ang) * len,
      dy: Math.sin(ang) * len,
      bow: (rnd() - 0.5) * 0.04,
      alpha: 0.05 + rnd() * 0.14,
      width: 0.7 + rnd() * 1.8,
      light: rnd() > 0.66, // a third catch the light instead of cutting in
    });
  }
  const dents: Dent[] = [];
  for (let i = 0; i < 18; i++) {
    dents.push({
      x: 0.03 + rnd() * 0.94,
      y: 0.04 + rnd() * 0.92,
      rx: 2 + rnd() * 7,
      ry: 1.5 + rnd() * 4,
      alpha: 0.05 + rnd() * 0.09,
    });
  }
  return { scratches, dents };
})();

// One soft blob, reused for every sharpener. A per-frame ctx.filter blur was
// costing more than everything else on screen combined.
let shadowSprite: HTMLCanvasElement | null = null;
function shadow(): HTMLCanvasElement {
  if (shadowSprite) return shadowSprite;
  const size = 96;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.46)');
  g.addColorStop(0.5, 'rgba(0,0,0,0.3)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  shadowSprite = c;
  return c;
}

/** Everything the aim overlay needs, all in table coordinates. */
export interface Aim {
  from: Point;
  pointer: Point;
  /** Arrow tip in table space, so perspective foreshortens it correctly. */
  tip: Point;
  power: number;
  path: Point[] | null;
  color: Skin;
}

export interface DrawOptions {
  aim?: Aim | null;
  activePlayer?: number;
  showActive?: boolean;
  board?: BoardInfo | null;
  skins?: string[];
}

export interface View {
  w: number;
  h: number;
  dpr: number;
}

export interface Renderer {
  resize(): void;
  draw(state: GameState, opts?: DrawOptions): void;
  toTable(clientX: number, clientY: number): Point;
  readonly view: View;
}

interface SharpenerOptions {
  alpha?: number;
  shrink?: number;
  active?: boolean;
  skin?: string;
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext('2d')!;
  const proj = createProjection();

  let view: View = { w: 0, h: 0, dpr: 1 };
  let table = { w: TABLE_W, h: TABLE_H };
  let scene: HTMLCanvasElement | null = null; // cached classroom + desk
  let sceneKey = '';

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    view = { w: rect.width, h: rect.height, dpr };
    proj.fit(view.w, view.h, table.w, table.h);
    scene = null;
  }

  function useTable(w: number, h: number): void {
    if (table.w === w && table.h === h) return;
    table = { w, h };
    proj.fit(view.w, view.h, w, h);
    scene = null;
  }

  function toTable(clientX: number, clientY: number): Point {
    const rect = canvas.getBoundingClientRect();
    return proj.unproject(clientX - rect.left, clientY - rect.top);
  }

  function base(): void {
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  }

  function corners() {
    return {
      tl: proj.project(0, 0),
      tr: proj.project(table.w, 0),
      bl: proj.project(0, table.h),
      br: proj.project(table.w, table.h),
    };
  }

  type Corners = ReturnType<typeof corners>;

  function deskPath(g: CanvasRenderingContext2D, c: Corners): void {
    g.beginPath();
    g.moveTo(c.tl.x, c.tl.y);
    g.lineTo(c.tr.x, c.tr.y);
    g.lineTo(c.br.x, c.br.y);
    g.lineTo(c.bl.x, c.bl.y);
    g.closePath();
  }

  /** Paint the desk into `g`. Called once per size, not once per frame. */
  function paintDesk(g: CanvasRenderingContext2D): void {
    const c = corners();
    const lip = Math.max(10, view.h * 0.024);
    const floorY = view.h * 1.08;

    // Legs. Drawn before the top so the top sits on them.
    g.strokeStyle = '#1f1811';
    g.lineWidth = Math.max(6, view.h * 0.014);
    g.lineCap = 'round';
    for (const [near, far] of [
      [c.bl, c.tl],
      [c.br, c.tr],
    ]) {
      g.globalAlpha = 0.7; // back legs are further away
      g.beginPath();
      g.moveTo(far.x, far.y);
      g.lineTo(far.x, view.h * 0.9);
      g.stroke();
      g.globalAlpha = 1;
      g.beginPath();
      g.moveTo(near.x, near.y);
      g.lineTo(near.x + (near === c.bl ? -14 : 14), floorY);
      g.stroke();
    }

    // Contact shadow on the floor.
    g.save();
    g.globalAlpha = 0.32;
    g.filter = 'blur(10px)';
    g.fillStyle = '#000';
    g.translate(0, view.h * 0.03);
    deskPath(g, c);
    g.fill();
    g.restore();

    // Front edge, giving the top some thickness.
    g.fillStyle = '#77522c';
    g.beginPath();
    g.moveTo(c.bl.x, c.bl.y);
    g.lineTo(c.br.x, c.br.y);
    g.lineTo(c.br.x, c.br.y + lip);
    g.lineTo(c.bl.x, c.bl.y + lip);
    g.closePath();
    g.fill();

    // Top surface.
    const grad = g.createLinearGradient(c.tl.x, c.tl.y, c.br.x, c.br.y);
    grad.addColorStop(0, '#c99359');
    grad.addColorStop(0.5, '#b47f47');
    grad.addColorStop(1, '#96682f');
    g.fillStyle = grad;
    deskPath(g, c);
    g.fill();

    g.save();
    deskPath(g, c);
    g.clip();

    // Grain, following the long axis of the desk.
    g.globalAlpha = 0.06;
    g.strokeStyle = '#5d3d1c';
    g.lineWidth = 1.4;
    for (let i = 0; i <= 13; i++) {
      const ty = (i / 13) * table.h;
      const a = proj.project(0, ty);
      const b = proj.project(table.w * 0.5, ty + 8);
      const d = proj.project(table.w, ty - 4);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.quadraticCurveTo(b.x, b.y, d.x, d.y);
      g.stroke();
    }

    // Scratches and dents, projected so they lie on the surface.
    g.lineCap = 'round';
    for (const s of DESK_MARKS.scratches) {
      const x = s.x * table.w;
      const y = s.y * table.h;
      const dx = s.dx * table.w;
      const dy = s.dy * table.h;
      const a = proj.project(x, y);
      const b = proj.project(x + dx, y + dy);
      const m = proj.project(
        x + dx / 2 - dy * 0.1 + s.bow * table.w,
        y + dy / 2 + dx * 0.1
      );
      g.globalAlpha = s.alpha;
      g.strokeStyle = s.light ? '#f0d3ae' : '#4a2f14';
      g.lineWidth = s.width;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.quadraticCurveTo(m.x, m.y, b.x, b.y);
      g.stroke();
    }

    g.fillStyle = '#3d2611';
    for (const d of DESK_MARKS.dents) {
      const q = proj.project(d.x * table.w, d.y * table.h);
      g.globalAlpha = d.alpha;
      g.beginPath();
      g.ellipse(q.x, q.y, d.rx * q.s, d.ry * q.s * 0.7, 0, 0, Math.PI * 2);
      g.fill();
    }

    // Initials scratched into the varnish.
    g.globalAlpha = 0.14;
    g.fillStyle = '#3a2410';
    CARVED.forEach((word, i) => {
      const p = proj.project(table.w * (0.12 + i * 0.26), table.h * (i % 2 ? 0.86 : 0.14));
      g.save();
      g.translate(p.x, p.y);
      g.rotate(i % 2 ? 0.12 : -0.09);
      g.font = `${Math.round(22 * p.s)}px 'Patrick Hand', cursive`;
      g.fillText(word, 0, 0);
      g.restore();
    });
    g.restore();

    // The lip you are trying not to cross.
    g.globalAlpha = 1;
    g.strokeStyle = 'rgba(255, 232, 200, 0.55)';
    g.lineWidth = 2.5;
    deskPath(g, c);
    g.stroke();
  }

  /** Classroom + desk + vignette, painted once and reused every frame. */
  function sceneCanvas(): HTMLCanvasElement {
    const key = `${view.w}x${view.h}@${view.dpr}/${table.w}x${table.h}`;
    if (scene && sceneKey === key) return scene;

    const c = document.createElement('canvas');
    c.width = Math.round(view.w * view.dpr);
    c.height = Math.round(view.h * view.dpr);
    const g = c.getContext('2d')!;
    g.scale(view.dpr, view.dpr);

    paintBackdrop(g, view.w, view.h);
    paintDesk(g);

    // Vignette is baked in rather than laid over each frame: it is a
    // full-screen gradient, and the sharpeners live near the middle where it
    // barely reaches anyway.
    const vg = g.createRadialGradient(
      view.w / 2, view.h * 0.5, view.h * 0.45,
      view.w / 2, view.h * 0.5, view.h * 1.15
    );
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.3)');
    g.fillStyle = vg;
    g.fillRect(0, 0, view.w, view.h);

    scene = c;
    sceneKey = key;
    return c;
  }

  // Drawn in table-local coordinates; the caller sets the perspective transform.
  function sharpenerBody(colors: Skin, alpha: number): void {
    const w = BODY_W;
    const h = BODY_H;
    ctx.globalAlpha = alpha;

    const bg = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
    bg.addColorStop(0, colors.light);
    bg.addColorStop(0.45, colors.body);
    bg.addColorStop(1, colors.dark);
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, 9);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawSharpener(p: Puck, colors: Skin, opts: SharpenerOptions = {}): void {
    const { alpha = 1, shrink = 1, active = false } = opts;
    const lift = THICK * proj.scale * shrink;

    // Contact shadow, flat on the desk.
    proj.transformAt(ctx, view.dpr, p.x, p.y, 0);
    ctx.globalAlpha = alpha;
    const r = PUCK_R * 1.5 * shrink;
    ctx.drawImage(shadow(), -r + 4, -r + 4, r * 2, r * 2);
    ctx.globalAlpha = 1;

    if (active) {
      proj.transformAt(ctx, view.dpr, p.x, p.y, 1);
      ctx.strokeStyle = colors.light;
      ctx.globalAlpha = alpha * 0.6;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([9, 7]);
      ctx.beginPath();
      ctx.arc(0, 0, PUCK_R + 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    const skinId = opts.skin ?? DEFAULT_SKIN;
    const sprite = skinImage(skinId);
    const silhouette = sprite && skinSilhouette(skinId);

    // The sides: copies of the silhouette stacked from the desk up to the top
    // face, so a rounded sharpener gets rounded sides.
    if (silhouette) {
      // Only as many copies as it takes to look solid. A five-player desk is
      // drawn smaller, so its sides need fewer layers than a two-player one —
      // which is exactly when the extra draw calls would hurt most.
      const layers = Math.max(3, Math.min(MAX_LAYERS, Math.ceil(lift / LAYER_GAP)));
      ctx.globalAlpha = alpha;
      for (let i = 0; i < layers; i++) {
        proj.transformAt(ctx, view.dpr, p.x, p.y, (lift * i) / layers);
        ctx.rotate(p.rot);
        ctx.scale(shrink, shrink);
        ctx.drawImage(silhouette, -SPRITE / 2, -SPRITE / 2, SPRITE, SPRITE);
      }
      ctx.globalAlpha = 1;
    }

    proj.transformAt(ctx, view.dpr, p.x, p.y, lift);
    ctx.rotate(p.rot);
    ctx.scale(shrink, shrink);

    if (sprite) {
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprite, -SPRITE / 2, -SPRITE / 2, SPRITE, SPRITE);
      ctx.globalAlpha = 1;
    } else {
      sharpenerBody(colors, alpha);
    }
  }

  function drawAim(aim: Aim): void {
    base();
    const { from, pointer, power, path, color, tip } = aim;
    const t = power / POWER_UNITS;
    const a = proj.project(from.x, from.y);
    const b = proj.project(pointer.x, pointer.y);

    ctx.save();
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = 'rgba(255,255,255,0.38)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();

    // Only the first fraction of a second, so it reads as intent rather than a
    // solved puzzle.
    if (path && path.length > 1) {
      ctx.save();
      for (let i = 1; i < path.length; i++) {
        const q = proj.project(path[i].x, path[i].y);
        ctx.globalAlpha = 0.6 * (1 - i / path.length);
        ctx.fillStyle = color.light;
        ctx.beginPath();
        ctx.arc(q.x, q.y, (5 * (1 - i / path.length) + 1.8) * q.s, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    const e = proj.project(tip.x, tip.y);
    ctx.save();
    ctx.strokeStyle = color.light;
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(e.x, e.y);
    ctx.stroke();
    ctx.translate(e.x, e.y);
    ctx.rotate(Math.atan2(e.y - a.y, e.x - a.x));
    ctx.fillStyle = color.light;
    ctx.beginPath();
    ctx.moveTo(11, 0);
    ctx.lineTo(-7, 7);
    ctx.lineTo(-7, -7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Power ring, foreshortened onto the desk by the same transform.
    proj.transformAt(ctx, view.dpr, from.x, from.y, 2);
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.arc(0, 0, PUCK_R + 18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = t > 0.85 ? '#ffd166' : color.body;
    ctx.beginPath();
    ctx.arc(0, 0, PUCK_R + 18, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t);
    ctx.stroke();
  }

  function draw(state: GameState, opts: DrawOptions = {}): void {
    const {
      aim = null, activePlayer = 0, showActive = true, board = null,
      skins = [],
    } = opts;

    useTable(state.w ?? TABLE_W, state.h ?? TABLE_H);

    base();
    ctx.drawImage(sceneCanvas(), 0, 0, view.w, view.h);
    if (board) drawChalkScore(ctx, view.w, view.h, board);

    // Far sharpeners first, so a near one overlaps correctly.
    state.pucks
      .map((p, i) => ({ p, i }))
      .sort((a, b) => a.p.y - b.p.y)
      .forEach(({ p, i }) => {
        const skin = skins[i] ?? DEFAULT_SKIN;
        const colors = getSkin(skin);
        if (p.alive) {
          drawSharpener(p, colors, { skin, active: showActive && i === activePlayer });
        } else {
          const age = Math.min((state.tick - p.deadTick) / FALL_TICKS, 1);
          if (age < 1) {
            drawSharpener(p, colors, { skin, alpha: 1 - age, shrink: 1 - age * 0.5 });
          }
        }
      });

    if (aim) drawAim(aim);
    base();
  }

  return { resize, draw, toTable, get view() { return view; } };
}
