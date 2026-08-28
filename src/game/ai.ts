import {
  DT,
  FRICTION,
  MAX_SPEED,
  POWER_UNITS,
  ANGLE_UNITS,
  MIN_POWER,
} from './constants.ts';
import { simulate } from './physics.ts';
import { radiansToAngle } from './trig.ts';
import { makeRng } from './rng.ts';
import type { Difficulty, Flick, GameState, Puck } from './types.ts';

// The AI produces the same { player, angle, power, seed } payload a human drag
// produces, so it drops into the identical turn pipeline — nothing downstream
// knows or cares whether a flick came from a finger or from here.
//
// Math.atan2 appears below, which is not bit-portable. That is fine: it only
// picks an input. The chosen angle is an integer, and replaying that integer is
// what has to be identical, not how it was decided.

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
};

function clampInt(v: number, lo: number, hi: number): number {
  v = Math.round(v);
  return v < lo ? lo : v > hi ? hi : v;
}

function aimAngle(state: GameState, me: number, opp: number): number {
  const a = state.pucks[me];
  const b = state.pucks[opp];
  return radiansToAngle(Math.atan2(b.y - a.y, b.x - a.x));
}

/** Everyone still on the desk who is not us. */
function opponents(state: GameState, me: number): number[] {
  const out: number[] = [];
  state.pucks.forEach((p, i) => {
    if (i !== me && p.alive) out.push(i);
  });
  return out;
}

/**
 * With more than two on the desk, go for whoever is closest to an edge — the
 * cheapest kill — rather than simply the nearest player.
 */
function pickTarget(state: GameState, me: number, foes: number[]): number {
  let best = foes[0];
  let bestScore = Infinity;
  const a = state.pucks[me];
  for (const i of foes) {
    const p = state.pucks[i];
    const dist = Math.hypot(p.x - a.x, p.y - a.y);
    const score = edgeMargin(state, p) * 2 + dist * 0.35;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

// A puck sliding at v covers v*DT*(1 + f + f² + …) = v*DT/(1-f) before parking.
// Invert that to get the power needed to travel a given distance.
function powerForDistance(d: number): number {
  const v = (d * (1 - FRICTION)) / DT;
  return clampInt((v / MAX_SPEED) * POWER_UNITS, MIN_POWER, POWER_UNITS);
}

function edgeMargin(state: GameState, p: Puck): number {
  return Math.min(p.x, state.w - p.x, p.y, state.h - p.y);
}

// Higher is better for `me`. Weighs every surviving opponent, not just the one
// aimed at — a shot that shoves two of them toward the lip beats one that
// shoves a single player the same distance.
function scoreOutcome(after: GameState, me: number): number {
  const m = after.pucks[me];
  if (!m.alive) return -1e6; // never trade yourself for a kill

  let score = edgeMargin(after, m); // keep your own room to manoeuvre
  after.pucks.forEach((p, i) => {
    if (i === me) return;
    if (!p.alive) score += 1e5; // knocked off: overwhelmingly the best outcome
    else score -= edgeMargin(after, p) * 3;
  });
  return score;
}

export function chooseFlick(
  state: GameState,
  me: number,
  difficulty: Difficulty,
  seed: number
): Flick {
  const rng = makeRng(seed >>> 0);
  const foes = opponents(state, me);
  if (foes.length === 0) {
    return { player: me, angle: 0, power: MIN_POWER, seed: seed >>> 0 };
  }

  const opp = pickTarget(state, me, foes);
  const a = state.pucks[me];
  const b = state.pucks[opp];
  const direct = aimAngle(state, me, opp);
  const dist = Math.hypot(b.x - a.x, b.y - a.y);

  if (difficulty === 'easy') {
    const spread = Math.round(ANGLE_UNITS * 0.045); // roughly ±16°
    return {
      player: me,
      angle: direct + Math.round((rng() * 2 - 1) * spread),
      power: clampInt(340 + rng() * 520, MIN_POWER, POWER_UNITS),
      seed: seed >>> 0,
    };
  }

  if (difficulty === 'medium') {
    const spread = Math.round(ANGLE_UNITS * 0.014); // roughly ±5°
    // Aim past them so the hit carries through rather than stopping short.
    const power = powerForDistance(dist + 240);
    return {
      player: me,
      angle: direct + Math.round((rng() * 2 - 1) * spread),
      power: clampInt(power * (0.9 + rng() * 0.2), MIN_POWER, POWER_UNITS),
      seed: seed >>> 0,
    };
  }

  // Hard: the physics is pure and deterministic, so the AI can just play the
  // future out. Try a fan of candidate flicks, simulate each to rest, keep the
  // best. No model, no tuning table — the sim is the evaluation function.
  const spread = Math.round(ANGLE_UNITS * 0.03); // ±11° fan
  const base = powerForDistance(dist + 200);
  const powers = [
    clampInt(base * 0.8, MIN_POWER, POWER_UNITS),
    clampInt(base, MIN_POWER, POWER_UNITS),
    clampInt(base * 1.25, MIN_POWER, POWER_UNITS),
    POWER_UNITS,
  ];

  let best: Flick | null = null;
  let bestScore = -Infinity;

  for (let i = -6; i <= 6; i++) {
    const angle = direct + Math.round((i / 6) * spread);
    for (const power of powers) {
      const flick: Flick = { player: me, angle, power, seed: seed >>> 0 };
      const score = scoreOutcome(simulate(state, flick), me);
      if (score > bestScore) {
        bestScore = score;
        best = flick;
      }
    }
  }

  return best ?? { player: me, angle: direct, power: base, seed: seed >>> 0 };
}
