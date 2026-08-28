// The classroom around the desk. Everything here is static, so it is rendered
// once into an offscreen canvas and blitted each frame — only the chalk score
// and the desk itself are redrawn live.

const HAND = "'Patrick Hand', 'Bradley Hand', 'Segoe Print', cursive";

const WALL_TOP = '#5c7060';
const WALL_BOT = '#41564a';
const FLOOR_NEAR = '#cdc2b1';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One player's line on the blackboard. */
export interface ScoreRow {
  name: string;
  score: number;
  color: string;
  active: boolean;
}

export interface BoardInfo {
  subtitle: string;
  /** null before a match exists — the board shows only the title and subtitle. */
  rows: ScoreRow[] | null;
  target: number;
}

function boardRect(w: number, h: number): Rect {
  return { x: w * 0.29, y: h * 0.02, w: w * 0.42, h: h * 0.235 };
}

function horizonAt(h: number): number {
  return h * 0.3;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawWall(ctx: CanvasRenderingContext2D, w: number, h: number, horizon: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, horizon);
  g.addColorStop(0, WALL_TOP);
  g.addColorStop(1, WALL_BOT);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, horizon);

  // Skirting board where the wall meets the floor.
  ctx.fillStyle = '#2a3830';
  ctx.fillRect(0, horizon - h * 0.018, w, h * 0.018);
}

function drawFloor(ctx: CanvasRenderingContext2D, w: number, h: number, horizon: number): void {
  const g = ctx.createLinearGradient(0, horizon, 0, h);
  g.addColorStop(0, '#ada191');
  g.addColorStop(0.35, '#c4b8a6');
  g.addColorStop(1, FLOOR_NEAR);
  ctx.fillStyle = g;
  ctx.fillRect(0, horizon, w, h - horizon);

  // Tile grid, drawn toward a vanishing point so the floor recedes.
  const vpX = w / 2;
  const vpY = horizon - h * 0.16;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, horizon, w, h - horizon);
  ctx.clip();
  ctx.strokeStyle = 'rgba(90, 80, 66, 0.35)';
  ctx.lineWidth = 1.4;

  // Lines running away from the viewer.
  for (let i = -14; i <= 14; i++) {
    const xNear = vpX + i * (w * 0.115);
    ctx.beginPath();
    ctx.moveTo(vpX, vpY);
    ctx.lineTo(xNear, h);
    ctx.stroke();
  }

  // Lines running across, spaced by 1/depth so they bunch up toward the back.
  for (let d = 1; d < 26; d += 0.55) {
    const y = vpY + (h - vpY) / d;
    if (y <= horizon) break;
    ctx.globalAlpha = Math.min(1, (y - horizon) / (h * 0.16));
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBoard(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const r = boardRect(w, h);
  const frame = Math.max(8, h * 0.014);

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = h * 0.03;
  ctx.shadowOffsetY = h * 0.012;
  ctx.fillStyle = '#7a5731';
  roundRect(ctx, r.x - frame, r.y - frame, r.w + frame * 2, r.h + frame * 2, 6);
  ctx.fill();
  ctx.restore();

  const g = ctx.createLinearGradient(r.x, r.y, r.x + r.w * 0.4, r.y + r.h);
  g.addColorStop(0, '#33463a');
  g.addColorStop(1, '#25352c');
  ctx.fillStyle = g;
  roundRect(ctx, r.x, r.y, r.w, r.h, 3);
  ctx.fill();

  // Chalk dust smeared across the board.
  ctx.save();
  ctx.globalAlpha = 0.032;
  ctx.strokeStyle = '#eef5ea';
  ctx.lineWidth = h * 0.012;
  ctx.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const y = r.y + r.h * (0.26 + i * 0.19);
    ctx.beginPath();
    ctx.moveTo(r.x + r.w * (0.05 + i * 0.06), y);
    ctx.bezierCurveTo(r.x + r.w * 0.35, y - h * 0.01, r.x + r.w * 0.6, y + h * 0.012, r.x + r.w * 0.95, y);
    ctx.stroke();
  }
  ctx.restore();

  // Chalk ledge.
  ctx.fillStyle = '#8a643a';
  ctx.fillRect(r.x - frame, r.y + r.h + frame, r.w + frame * 2, frame * 0.7);
}

// A desk seen side-on-ish: trapezoid top plus two legs.
function drawSideDesk(
  ctx: CanvasRenderingContext2D,
  cx: number,
  topY: number,
  topW: number,
  botW: number,
  deskH: number,
  legH: number,
  tilt: number
): void {
  ctx.save();
  ctx.translate(cx, topY);
  ctx.rotate(tilt);

  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(0, deskH + legH, botW * 0.6, legH * 0.12, 0, 0, Math.PI * 2);
  ctx.fill();

  // Legs.
  ctx.strokeStyle = '#241b13';
  ctx.lineWidth = Math.max(3, topW * 0.035);
  ctx.lineCap = 'round';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(s * botW * 0.42, deskH);
    ctx.lineTo(s * botW * 0.5, deskH + legH);
    ctx.stroke();
  }

  // Top surface.
  const g = ctx.createLinearGradient(0, 0, 0, deskH);
  g.addColorStop(0, '#c08b52');
  g.addColorStop(1, '#8d6134');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(-topW / 2, 0);
  ctx.lineTo(topW / 2, 0);
  ctx.lineTo(botW / 2, deskH);
  ctx.lineTo(-botW / 2, deskH);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#6d4a26';
  ctx.fillRect(-botW / 2, deskH, botW, deskH * 0.14);
  ctx.restore();
}

function drawBackpack(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  body: string,
  strap: string
): void {
  ctx.save();
  ctx.translate(cx, cy);

  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(0, size * 0.52, size * 0.55, size * 0.12, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = body;
  roundRect(ctx, -size * 0.45, -size * 0.5, size * 0.9, size, size * 0.28);
  ctx.fill();

  ctx.fillStyle = strap;
  roundRect(ctx, -size * 0.3, -size * 0.06, size * 0.6, size * 0.34, size * 0.1);
  ctx.fill();

  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  roundRect(ctx, -size * 0.12, -size * 0.44, size * 0.24, size * 0.2, size * 0.07);
  ctx.fill();
  ctx.restore();
}

/**
 * Paint the static classroom behind the desk into `ctx`.
 *
 * No caching here — the renderer bakes this and the desk into one offscreen
 * canvas, so this runs once per resize rather than once per frame.
 */
export function paintBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const horizon = horizonAt(h);
  drawWall(ctx, w, h, horizon);
  drawFloor(ctx, w, h, horizon);
  drawBoard(ctx, w, h);

  // Desks either side, small and low-contrast so they read as depth rather
  // than competing with the playfield.
  drawSideDesk(ctx, w * 0.045, h * 0.34, w * 0.15, w * 0.18, h * 0.028, h * 0.15, 0.06);
  drawSideDesk(ctx, w * 0.955, h * 0.34, w * 0.15, w * 0.18, h * 0.028, h * 0.15, -0.06);
  drawSideDesk(ctx, w * -0.01, h * 0.55, w * 0.19, w * 0.23, h * 0.035, h * 0.19, 0.05);
  drawSideDesk(ctx, w * 1.01, h * 0.55, w * 0.19, w * 0.23, h * 0.035, h * 0.19, -0.05);

  drawBackpack(ctx, w * 0.855, h * 0.43, h * 0.1, '#42528a', '#303d72');
  drawBackpack(ctx, w * 0.15, h * 0.46, h * 0.085, '#84404c', '#65303a');
}

/** The live scoreboard, chalked onto the board. */
export function drawChalkScore(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  info: BoardInfo
): void {
  const r = boardRect(w, h);
  const cx = r.x + r.w * 0.5;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(238, 245, 234, 0.9)';
  ctx.font = `${Math.round(h * 0.045)}px ${HAND}`;
  ctx.fillText('SHARPENER FIGHT', cx, r.y + r.h * 0.22);

  ctx.globalAlpha = 0.6;
  ctx.font = `${Math.round(h * 0.022)}px ${HAND}`;
  ctx.fillText(info.subtitle, cx, r.y + r.h * 0.44);
  ctx.globalAlpha = 1;

  if (!info.rows) {
    ctx.restore();
    return;
  }

  // Rows are fitted to the space left on the board rather than a fixed step,
  // so five players stay chalked on the board instead of spilling onto the wall.
  const top = r.y + r.h * 0.55;
  const span = r.h * 0.42;
  const gap = span / info.rows.length;
  const fontPx = Math.max(10, Math.min(h * 0.028, gap * 0.78));

  ctx.font = `${Math.round(fontPx)}px ${HAND}`;
  info.rows.forEach((row, i) => {
    const y = top + gap * (i + 0.5);
    ctx.textAlign = 'right';
    ctx.fillStyle = row.active ? '#fff8d8' : 'rgba(238, 245, 234, 0.82)';
    ctx.fillText(row.name, cx + r.w * 0.02, y);

    // Score boxes, like a tally on a real board.
    const box = Math.min(h * 0.022, gap * 0.62);
    for (let k = 0; k < info.target; k++) {
      const bx = cx + r.w * 0.08 + k * box * 1.35;
      ctx.strokeStyle = 'rgba(238, 245, 234, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx, y - box / 2, box, box);
      if (k < row.score) {
        ctx.fillStyle = row.color;
        ctx.fillRect(bx + 2.5, y - box / 2 + 2.5, box - 5, box - 5);
      }
    }
  });
  ctx.restore();
}
