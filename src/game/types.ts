// The shapes the simulation is built from.
//
// Everything here is plain JSON-serialisable data: a Puck or a GameState goes
// straight into a Postgres jsonb column and comes back out intact, and a Flick
// is exactly what travels over the Realtime channel. No classes, no methods —
// a method would not survive the round trip.

export interface Puck {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  spin: number;
  alive: boolean;
  /** The tick it went over the edge, or -1 while it is still on the desk. */
  deadTick: number;
}

export interface GameState {
  tick: number;
  seed: number;
  round: number;
  /** Table size travels with the board, because the desk grows with players. */
  w: number;
  h: number;
  players: number;
  pucks: Puck[];
}

/** The entire input for one turn. angle and power are integers. */
export interface Flick {
  player: number;
  angle: number;
  power: number;
  seed: number;
}

/**
 * Sound cues raised by a step. Deliberately not part of GameState: writing them
 * into the board would change what gets hashed, serialised, and replayed.
 */
export type SimEvent =
  | { type: 'hit'; speed: number }
  | { type: 'off'; speed: number };

/** Where a puck begins the round, facing in toward the middle. */
export interface Start {
  x: number;
  y: number;
  rot: number;
}

export interface Point {
  x: number;
  y: number;
}

export type RoundReason = 'knock-out' | 'self-out' | 'wipeout';

export type RoundOutcome =
  | { over: false; winner: null; reason: null }
  | { over: true; winner: number | null; reason: RoundReason };

export interface Match {
  seed: number;
  players: number;
  score: number[];
  round: number;
  turn: number;
  /** The seat that took the match, or null while it is still being played. */
  winner: number | null;
  lastReason: RoundReason | null;
}

export type Difficulty = 'easy' | 'medium' | 'hard';
