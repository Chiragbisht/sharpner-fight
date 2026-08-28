// Every number here is in logical table units, not pixels. The renderer scales
// table units to whatever the screen is; the physics never sees a pixel.

// Two players get the classic desk. Every extra player needs somewhere to sit
// and somewhere to be shoved toward, so the desk grows with the count.
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 5;

export function tableFor(players: number): { w: number; h: number } {
  const n = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, players));
  return { w: 900 + (n - 2) * 130, h: 600 + (n - 2) * 86 };
}

// Kept for the two-player defaults the renderer falls back to before a match
// exists. Live geometry always comes from state.w / state.h.
export const TABLE_W = 900;
export const TABLE_H = 600;

// Collision radius. The rendered body is a rounded square whose half-diagonal
// is about this, so what you see is what you hit.
export const PUCK_R = 33;
export const BODY_W = 50;
export const BODY_H = 45;

// --- Fixed timestep -------------------------------------------------------
// The sim always advances by exactly DT. The render loop accumulates real time
// and runs whole steps. Frame rate never changes the outcome.
export const DT = 1 / 120;
export const MAX_STEPS = 2400; // 20s hard cap on a single flick

// --- Feel -----------------------------------------------------------------
// These three decide whether a round is a rally or a one-punch knockout.
//
// Two equal masses hitting head on transfer almost all their momentum, so with
// a bouncy collision any solid hit throws you as far as the attacker would have
// travelled — which means the first clean shot always wins and there is no
// game. RESTITUTION well under 1 makes a hit *shove* rather than launch, so a
// good flick leaves your opponent teetering near the lip and the kill is the
// turn after. That's where the tension is.
//
// MAX_SPEED and RESTITUTION are set so that a dead-centre, full-power strike
// from the starting positions leaves the opponent about 60 units short of the
// edge — a shove, never an instant win. Measured, not guessed: at 2100/0.50 it
// knocked them off by 16 units. Close range still kills, which is the skill.
export const FRICTION = 0.975; // velocity multiplier per step
export const REST_SPEED = 8; // units/sec; below this a puck is parked
export const RESTITUTION = 0.36;
export const SPIN_TRANSFER = 0.00035;
export const SPIN_DECAY = 0.985;
export const MAX_SPEED = 1850; // units/sec at power === POWER_UNITS

// --- Flick payload --------------------------------------------------------
// A flick is quantized to integers so it survives a round trip through JSON
// and reproduces exactly on the other machine.
export const POWER_UNITS = 1000; // power is an int 0..1000
export const ANGLE_UNITS = 4096; // angle is an int 0..4095 (a full turn)
export const MIN_POWER = 90; // shorter drags than this don't count as a flick


// Start positions live in physics.ts: they need the integer trig table, and
// trig.ts already imports ANGLE_UNITS from here.

export const ROUNDS_TO_WIN = 3;
