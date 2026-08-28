// Two checks that guard the things the rest of the plan rests on:
//
//   1. the physics is deterministic — identical input, identical bits
//   2. src/game/ stays pure — no imports of network or UI code
//
// Run with: npm run verify

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { createState, cloneState, simulate, step, applyFlick, isAtRest } from '../src/game/physics.ts';
import { chooseFlick } from '../src/game/ai.ts';
import { MAX_STEPS } from '../src/game/constants.ts';
import type { Difficulty, Flick, GameState } from '../src/game/types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// Exact byte comparison. Comparing rounded numbers would hide precisely the
// kind of last-bit drift that desyncs a match twenty turns in.
function fingerprint(s: GameState): string {
  const nums = [s.tick, s.seed, s.round];
  for (const p of s.pucks) {
    nums.push(p.x, p.y, p.vx, p.vy, p.rot, p.spin, p.alive ? 1 : 0, p.deadTick);
  }
  return Buffer.from(new Float64Array(nums).buffer).toString('hex');
}

// A fixed script of flicks, so a change in feel constants shows up as a
// different final fingerprint rather than silently passing.
const SCRIPT: Flick[] = [
  { player: 0, angle: 40, power: 820, seed: 11 },
  { player: 1, angle: 2100, power: 640, seed: 22 },
  { player: 0, angle: 300, power: 910, seed: 33 },
  { player: 1, angle: 1900, power: 500, seed: 44 },
  { player: 0, angle: 120, power: 1000, seed: 55 },
];

function playScript(): GameState {
  let s = createState(1234);
  for (const flick of SCRIPT) {
    if (!s.pucks[flick.player].alive) break;
    s = simulate(s, flick);
  }
  return s;
}

console.log('\ndeterminism');

const a = playScript();
const b = playScript();
check('same script twice is bit-identical', fingerprint(a) === fingerprint(b));

const c = createState(1234);
const before = fingerprint(c);
simulate(c, SCRIPT[0]);
check('simulate() does not mutate its input', fingerprint(c) === before);

// Stepping by hand must match simulate() exactly — this is the property the
// networked replay depends on, since the flicking client renders step-by-step
// while the receiving client may run it straight through.
const manual = applyFlick(cloneState(createState(1234)), SCRIPT[0]);
let n = 0;
while (!isAtRest(manual) && n < MAX_STEPS) {
  step(manual);
  n++;
}
const straight = simulate(createState(1234), SCRIPT[0]);
check('stepwise and straight-through agree', fingerprint(manual) === fingerprint(straight), `${n} steps`);

const json = JSON.parse(JSON.stringify(createState(7))) as GameState;
check(
  'state survives a JSON round trip',
  fingerprint(simulate(json, SCRIPT[0])) === fingerprint(simulate(createState(7), SCRIPT[0]))
);

check('every flick settles inside the step cap', playScript().tick < MAX_STEPS);

console.log('\nai');

for (const level of ['easy', 'medium', 'hard'] as Difficulty[]) {
  const s = createState(99);
  const f1 = chooseFlick(s, 1, level, 424242);
  const f2 = chooseFlick(s, 1, level, 424242);
  check(
    `${level}: same seed picks the same flick`,
    f1.angle === f2.angle && f1.power === f2.power
  );
  check(
    `${level}: emits integer angle/power`,
    Number.isInteger(f1.angle) && Number.isInteger(f1.power)
  );
}

const hardWins = scoreOf('hard');
const easyWins = scoreOf('easy');
check('hard beats easy over 40 matches', hardWins > easyWins, `${hardWins} vs ${easyWins}`);

function scoreOf(level: Difficulty): number {
  let wins = 0;
  for (let m = 0; m < 40; m++) {
    let s = createState(1000 + m);
    let turn = 0; // 0 = the level under test, 1 = easy
    for (let t = 0; t < 24; t++) {
      const lvl: Difficulty = turn === 0 ? level : 'easy';
      s = simulate(s, chooseFlick(s, turn, lvl, m * 97 + t));
      if (!s.pucks[0].alive) break;
      if (!s.pucks[1].alive) break;
      turn = 1 - turn;
    }
    if (s.pucks[0].alive && !s.pucks[1].alive) wins++;
  }
  return wins;
}

console.log('\nmodule boundaries');

const gameDir = join(root, 'src', 'game');
const forbidden = /(supabase|\.\.\/net\/|\.\.\/ui\/|\.\.\/main)/;
for (const file of readdirSync(gameDir).filter((f) => f.endsWith('.ts'))) {
  const src = readFileSync(join(gameDir, file), 'utf8');
  const imports = [...src.matchAll(/^\s*import[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const bad = imports.filter((i) => forbidden.test(i));
  check(
    `${relative(root, join(gameDir, file))} imports nothing impure`,
    bad.length === 0,
    bad.join(', ')
  );
}

// Math.random in the sim would be a silent desync: both clients would run the
// "same" input and quietly drift apart.
for (const file of readdirSync(gameDir).filter((f) => f.endsWith('.ts'))) {
  const src = readFileSync(join(gameDir, file), 'utf8');
  const line = src.split('\n').findIndex((l) => /Math\.random\s*\(/.test(l) && !l.trim().startsWith('//'));
  check(`${relative(root, join(gameDir, file))} has no bare Math.random`, line === -1, line >= 0 ? `line ${line + 1}` : '');
}

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
