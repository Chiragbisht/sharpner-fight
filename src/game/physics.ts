import {
  PUCK_R,
  DT,
  MAX_STEPS,
  FRICTION,
  REST_SPEED,
  RESTITUTION,
  SPIN_TRANSFER,
  SPIN_DECAY,
  MAX_SPEED,
  POWER_UNITS,
  tableFor,
  ANGLE_UNITS,
} from './constants.ts';
import { cosA, sinA, angleToRadians } from './trig.ts';
import { makeRng, mixSeed } from './rng.ts';
import type { Flick, GameState, Point, Puck, SimEvent, Start } from './types.ts';

// Pure deterministic simulation. No DOM, no clock, no bare Math.random, no
// network. Same state + same flick => same result, on any machine.
//
// State is plain JSON-serializable data so it can be written straight into a
// Postgres jsonb column and read back to resume a match.

// Started further in than you'd expect: there has to be enough desk behind you
// to survive one shove, or every round is decided by whoever flicks first.
//
// Three or more sit evenly around an ellipse, so nobody starts closer to an
// edge than anyone else. Positions come off the integer trig table rather than
// Math.cos/sin: they are baked into state, so both clients must compute them
// bit-identically. See trig.ts.
export function startsFor(players: number, w: number, h: number): Start[] {
  if (players === 2) {
    return [
      { x: w * 0.28, y: h * 0.5, rot: 0 },
      { x: w * 0.72, y: h * 0.5, rot: Math.PI },
    ];
  }
  const rx = w * 0.33;
  const ry = h * 0.33;
  const quarter = ANGLE_UNITS / 4;
  return Array.from({ length: players }, (_, i) => {
    const a = Math.round((i * ANGLE_UNITS) / players) - quarter;
    return {
      x: w / 2 + cosA(a) * rx,
      y: h / 2 + sinA(a) * ry,
      // Facing in toward the middle, like players leaning over a desk.
      rot: angleToRadians(a + ANGLE_UNITS / 2),
    };
  });
}

export function createState(seed = 1, round = 1, players = 2): GameState {
  const { w, h } = tableFor(players);
  return {
    tick: 0,
    seed: seed >>> 0,
    round,
    // Table size travels with the board, so a resumed or replayed match cannot
    // disagree with the client that produced it.
    w,
    h,
    players,
    pucks: startsFor(players, w, h).map((p) => ({
      x: p.x,
      y: p.y,
      vx: 0,
      vy: 0,
      rot: p.rot,
      spin: 0,
      alive: true,
      deadTick: -1,
    })),
  };
}

export function cloneState(s: GameState): GameState {
  return {
    tick: s.tick,
    seed: s.seed,
    round: s.round,
    w: s.w,
    h: s.h,
    players: s.players,
    pucks: s.pucks.map((p) => ({ ...p })),
  };
}

function clampInt(v: number, lo: number, hi: number): number {
  v = Math.round(v);
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * A flick is the entire input for one turn: { player, angle, power, seed }.
 * angle and power are integers; seed makes the (small) random component
 * reproducible. This object is exactly what gets broadcast over the network.
 */
export function applyFlick(state: GameState, flick: Flick): GameState {
  const p = state.pucks[flick.player];
  if (!p || !p.alive) return state;

  const power = clampInt(flick.power, 0, POWER_UNITS);
  const speed = (power / POWER_UNITS) * MAX_SPEED;

  p.vx = cosA(flick.angle) * speed;
  p.vy = sinA(flick.angle) * speed;

  // A little spin off the flick so it tumbles instead of sliding rigidly.
  // Visual only, but it lives in state, so it has to be deterministic.
  const rng = makeRng(mixSeed(state.seed, flick.seed, state.tick, flick.angle));
  p.spin = (rng() - 0.5) * (power / POWER_UNITS) * 0.35;

  return state;
}

// Impacts gentler than this are the two pucks settling against each other, not
// a strike worth hearing.
const HIT_MIN_SPEED = 90;

function collide(a: Puck, b: Puck, events: SimEvent[] | null): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  const min = PUCK_R * 2;

  if (d2 >= min * min) return false;
  if (d2 === 0) {
    // Perfectly stacked. Nudge along a fixed axis so the result stays defined.
    a.x -= PUCK_R;
    b.x += PUCK_R;
    return true;
  }

  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;

  // Push both out of overlap equally.
  const overlap = (min - d) / 2;
  a.x -= nx * overlap;
  a.y -= ny * overlap;
  b.x += nx * overlap;
  b.y += ny * overlap;

  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const vn = rvx * nx + rvy * ny;
  if (vn > 0) return true; // already separating

  // Equal mass, so the impulse splits evenly.
  const j = (-(1 + RESTITUTION) * vn) / 2;
  a.vx -= j * nx;
  a.vy -= j * ny;
  b.vx += j * nx;
  b.vy += j * ny;

  // Glancing hits set both spinning.
  const vt = rvx * -ny + rvy * nx;
  a.spin -= vt * SPIN_TRANSFER;
  b.spin += vt * SPIN_TRANSFER;

  if (events && -vn > HIT_MIN_SPEED) events.push({ type: 'hit', speed: -vn });

  return true;
}

/**
 * Advance one fixed tick.
 *
 * `events` is an optional array the caller passes in; impacts and edge-outs are
 * pushed onto it so the UI can make a noise. It is deliberately NOT part of
 * state: writing sound cues into the board would change what gets hashed,
 * serialised into Postgres, and replayed on the other client. The sim stays a
 * pure function of state + input either way.
 */
export function step(state: GameState, events: SimEvent[] | null = null): GameState {
  const pucks = state.pucks;

  for (const p of pucks) {
    p.x += p.vx * DT;
    p.y += p.vy * DT;
    p.rot = (p.rot + p.spin) % (Math.PI * 2);

    p.vx *= FRICTION;
    p.vy *= FRICTION;
    p.spin *= SPIN_DECAY;

    if (p.alive) {
      // Centre crosses the edge => off the table. Half-hanging survives.
      if (p.x < 0 || p.x > state.w || p.y < 0 || p.y > state.h) {
        p.alive = false;
        p.deadTick = state.tick;
        if (events) events.push({ type: 'off', speed: Math.hypot(p.vx, p.vy) });
      } else if (p.vx * p.vx + p.vy * p.vy < REST_SPEED * REST_SPEED) {
        p.vx = 0;
        p.vy = 0;
        p.spin = 0;
      }
    }
  }

  // Every pair, not just the one: with five on the desk a single flick can set
  // off a chain of collisions in the same tick.
  for (let i = 0; i < pucks.length; i++) {
    for (let j = i + 1; j < pucks.length; j++) {
      if (pucks[i].alive && pucks[j].alive) collide(pucks[i], pucks[j], events);
    }
  }

  state.tick++;
  return state;
}

// A puck that has fallen off keeps travelling for the animation, so it is not
// part of the "has everything stopped" question.
export function isAtRest(state: GameState): boolean {
  return state.pucks.every((p) => !p.alive || (p.vx === 0 && p.vy === 0));
}

/** Run a flick to completion. Does not mutate the input state. */
export function simulate(state: GameState, flick: Flick): GameState {
  const s = applyFlick(cloneState(state), flick);
  let n = 0;
  while (!isAtRest(s) && n < MAX_STEPS) {
    step(s);
    n++;
  }
  return s;
}

/** Sampled path of one puck, for drawing the aim preview. */
export function previewPath(
  state: GameState,
  flick: Flick,
  steps = 46,
  every = 4
): Point[] {
  const s = applyFlick(cloneState(state), flick);
  const p = s.pucks[flick.player];
  const path: Point[] = [{ x: p.x, y: p.y }];
  for (let i = 0; i < steps; i++) {
    if (isAtRest(s)) break;
    step(s);
    if (i % every === every - 1) path.push({ x: p.x, y: p.y });
  }
  return path;
}
