import { simulate } from '../src/game/physics.ts';
import { roundOutcome, createMatch, awardRound, stateForRound } from '../src/game/rules.ts';
import { chooseFlick } from '../src/game/ai.ts';
import { mixSeed } from '../src/game/rng.ts';
import type { Difficulty } from '../src/game/types.ts';

const levels = (process.argv[2] ? process.argv[2].split(',') : ['medium', 'hard']) as Difficulty[];

interface MatchResult {
  stuck?: string;
  winner?: number;
  score?: number[];
  rounds?: number;
  turns?: number;
}

function playMatch(seed: number): MatchResult {
  const match = createMatch(seed, 0);
  let rounds = 0, turns = 0;
  while (match.winner === null) {
    let state = stateForRound(match);
    rounds++;
    if (rounds > 12) return { stuck: 'too many rounds' };
    for (let t = 0; t < 60; t++) {
      const flicker = match.turn;
      state = simulate(state, chooseFlick(state, flicker, levels[flicker], mixSeed(seed, rounds, t)));
      turns++;
      const out = roundOutcome(state, flicker);
      if (out.over) { awardRound(match, out.winner, out.reason); break; }
      match.turn = 1 - flicker;
      if (t === 59) return { stuck: 'round never ended' };
    }
  }
  return { winner: match.winner!, score: match.score, rounds, turns };
}

let stuck = 0, totalTurns = 0, totalRounds = 0;
const wins = [0, 0];
for (let i = 0; i < 60; i++) {
  const r = playMatch(4000 + i);
  if (r.stuck) { stuck++; continue; }
  wins[r.winner!]++; totalTurns += r.turns!; totalRounds += r.rounds!;
}
console.log(`${levels[0]} ${wins[0]} / ${levels[1]} ${wins[1]}, stuck ${stuck}`);
console.log(`avg ${(totalRounds / 60).toFixed(1)} rounds, ${(totalTurns / totalRounds).toFixed(1)} flicks per round`);
