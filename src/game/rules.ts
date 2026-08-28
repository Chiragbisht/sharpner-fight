import { ROUNDS_TO_WIN } from './constants.ts';
import { createState } from './physics.ts';
import type { GameState, Match, RoundOutcome, RoundReason } from './types.ts';

// Round and match bookkeeping. Pure — given the same sequence of flicks every
// client arrives at the same score without talking to each other.

/**
 * A round ends when one sharpener is left on the desk. With two players that
 * reduces to the old rule, including "knock yourself off and you lose": if you
 * go over the edge, the other one is the only survivor.
 *
 * A wipeout — everyone off in the same tick — is a dead heat and nobody scores.
 */
export function roundOutcome(state: GameState, flicker: number): RoundOutcome {
  const alive: number[] = [];
  state.pucks.forEach((p, i) => p.alive && alive.push(i));

  if (alive.length > 1) return { over: false, winner: null, reason: null };
  if (alive.length === 0) return { over: true, winner: null, reason: 'wipeout' };

  const winner = alive[0];
  return {
    over: true,
    winner,
    reason: winner === flicker ? 'knock-out' : 'self-out',
  };
}

/** The next player still on the desk, going round the table. */
export function nextTurn(state: GameState, from: number): number {
  const n = state.pucks.length;
  for (let step = 1; step <= n; step++) {
    const i = (from + step) % n;
    if (state.pucks[i].alive) return i;
  }
  return from;
}

export function createMatch(seed = 1, firstTurn = 0, players = 2): Match {
  return {
    seed: seed >>> 0,
    players,
    score: Array(players).fill(0),
    round: 1,
    turn: firstTurn,
    winner: null,
    lastReason: null,
  };
}

export function awardRound(
  match: Match,
  winner: number | null,
  reason: RoundReason
): Match {
  match.lastReason = reason;

  // A wipeout scores for nobody; the round is simply replayed.
  if (winner === null) {
    match.round++;
    return match;
  }

  match.score[winner]++;
  if (match.score[winner] >= ROUNDS_TO_WIN) {
    match.winner = winner;
  } else {
    match.round++;
    // Whoever lost flicks first next round. With more than two, that is the
    // player after the winner, so the advantage rotates.
    match.turn = (winner + 1) % match.players;
  }
  return match;
}

export function stateForRound(match: Match): GameState {
  return createState(match.seed + match.round, match.round, match.players);
}
