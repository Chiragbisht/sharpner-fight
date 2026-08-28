import { DT, POWER_UNITS, MIN_POWER, PUCK_R, ROUNDS_TO_WIN, MAX_SPEED, MIN_PLAYERS, MAX_PLAYERS } from './game/constants.ts';
import { step, isAtRest, applyFlick, previewPath } from './game/physics.ts';
import { roundOutcome, createMatch, awardRound, stateForRound, nextTurn } from './game/rules.ts';
import { chooseFlick, DIFFICULTY_LABELS } from './game/ai.ts';
import { radiansToAngle, angleToRadians } from './game/trig.ts';
import { mixSeed } from './game/rng.ts';
import { createRenderer } from './ui/render.ts';
import { SKINS, getSkin, skinSrc, preloadSkins, DEFAULT_SKIN } from './ui/skins.ts';
import * as sound from './ui/sound.ts';
import { mountGoogleButton, signOut, onAuth, fetchProfile } from './net/auth.ts';
import { isConfigured } from './net/supabase.ts';
import {
  createRoom, joinRoom, fetchRoom, patchRoom, recordMatch, joinChannel, setReady,
} from './net/rooms.ts';
import {
  searchProfiles, requestFriend, acceptFriend, loadFriends,
  trackPresence, listenForInvites, sendInvite,
} from './net/friends.ts';
import type { Difficulty, Flick, GameState, Match, Point, SimEvent } from './game/types.ts';
import type { RoomChannel } from './net/rooms.ts';
import type { InvitePayload, OwnProfile, Profile, Room } from './net/types.ts';
import type { Aim } from './ui/render.ts';
import type { BoardInfo } from './ui/scene.ts';
import type { User } from '@supabase/supabase-js';

// Wiring only: turn order, input, and what goes on screen. Every rule and every
// number that decides an outcome lives in src/game/.

const MAX_DRAG = 230; // table units of pull-back for full power
const GRAB = PUCK_R * 3.4; // how close to your sharpener a drag must start

/**
 * Every id below is in index.html, so a miss is a wiring bug rather than a
 * runtime condition to handle — throwing here turns it into one loud failure
 * instead of a `null` that surfaces three frames later.
 */
function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

const canvas = $<HTMLCanvasElement>('board');
const renderer = createRenderer(canvas);

type Phase = 'menu' | 'aim' | 'sim' | 'roundover' | 'matchover';
type Mode = 'ai' | 'online';

interface Drag {
  pointer: Point;
  id: number;
}

interface Game {
  phase: Phase;
  mode: Mode;
  difficulty: Difficulty;
  /** null only in the menu phase — see the assertions below. */
  match: Match | null;
  state: GameState | null;
  flicker: number;
  drag: Drag | null;
  timers: number[];
  user: User | null;
  profile: OwnProfile | null;
  // --- online play ---
  seat: number;
  room: Room | null;
  channel: RoomChannel | null;
  online: Set<string>;
  invite: InvitePayload | null;
  // --- appearance ---
  mySkin: string;
  oppSkins: Record<number, string>;
  seatNames: string[];
  players: number;
}

const g: Game = {
  phase: 'menu', // menu | aim | sim | roundover | matchover
  mode: 'ai', // ai | local
  difficulty: 'medium',
  match: null,
  state: null,
  flicker: 0, // who took the shot currently being simulated
  drag: null,
  timers: [],
  user: null,
  profile: null,
  // --- online play ---
  seat: 0, // 0 = host, 1 = guest; matches the puck index
  room: null,
  channel: null,
  online: new Set(), // user ids currently connected
  invite: null,
  // --- appearance. Cosmetic only: skins never touch the sim. ---
  mySkin: DEFAULT_SKIN,
  oppSkins: {}, // seat -> skin id, for online games
  seatNames: [], // seat -> display name, for online games
  players: 2,
};

// `g.match` and `g.state` are null only while phase === 'menu'. Everything
// past this point runs from a phase that has both, so they assert rather than
// re-testing an invariant the phase already carries.
const match = (): Match => g.match as Match;
const board = (): GameState => g.state as GameState;

/**
 * Skins indexed by player number. Your own seat gets your choice; everyone else
 * gets a distinct one so five sharpeners never look alike.
 */
function skinIds(): string[] {
  const n = g.match?.players ?? g.players;
  const mine = g.mode === 'online' ? g.seat : 0;
  const spare = SKINS.map((s) => s.id).filter((id) => id !== g.mySkin);
  const ids: string[] = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (i === mine) ids.push(g.mySkin);
    else if (g.mode === 'online' && g.oppSkins[i]) ids.push(g.oppSkins[i]);
    else ids.push(spare[k++ % spare.length]);
  }
  return ids;
}

// ---------------------------------------------------------------- helpers

function later(fn: () => void, ms: number): number {
  const id = setTimeout(fn, ms);
  g.timers.push(id);
  return id;
}

function clearTimers(): void {
  g.timers.forEach(clearTimeout);
  g.timers = [];
}

function playerNames(): string[] {
  const n = g.match?.players ?? g.players;
  if (g.mode === 'online') {
    return Array.from({ length: n }, (_, i) =>
      i === g.seat ? 'You' : g.seatNames[i] || `Player ${i + 1}`
    );
  }
  if (n === 2) return ['You', 'Computer'];
  return Array.from({ length: n }, (_, i) => (i === 0 ? 'You' : `Computer ${i}`));
}

function isHumanTurn(): boolean {
  if (g.mode === 'online') return match().turn === g.seat;
  return match().turn === 0; // vs computer: you are always seat 0
}

const CARDS = [
  'menuCard', 'overCard', 'howCard', 'authCard',
  'onlineCard', 'lobbyCard', 'friendsCard', 'inviteCard', 'skinCard',
];

function showCard(id: string): void {
  CARDS.forEach((c) => ($(c).hidden = c !== id));
  $('overlay').hidden = false;
}

// ---------------------------------------------------------------- flow

function startMatch(): void {
  clearTimers();
  g.match = createMatch(
    mixSeed(Date.now() & 0xffffffff, Math.trunc(performance.now())),
    0,
    g.players
  );
  startRound();
  $('overlay').hidden = true;
}

function startRound(): void {
  clearTimers();
  g.state = stateForRound(match());
  g.flicker = match().turn;
  g.drag = null;
  g.phase = 'aim';
  $('banner').hidden = true;
  syncHint();
  maybeTakeAiTurn();
}

function commitFlick(flick: Flick, { broadcast = true } = {}): void {
  sound.flick(flick.power / POWER_UNITS);
  // Only the input travels. The other client replays it through the same
  // deterministic sim and lands on the same board — README §2.
  if (broadcast && g.mode === 'online' && g.channel) g.channel.send('flick', flick);
  g.drag = null;
  g.flicker = flick.player;
  applyFlick(board(), flick);
  g.phase = 'sim';
  syncHint();
}

function maybeTakeAiTurn(): void {
  if (g.mode !== 'ai' || match().turn === 0 || g.phase !== 'aim') return;
  const seat = match().turn;
  // A beat before it moves, so it reads as a player rather than a reflex.
  later(() => {
    if (g.phase !== 'aim' || match().turn !== seat) return;
    const seed = mixSeed(match().seed, match().round, board().tick);
    commitFlick(chooseFlick(board(), seat, g.difficulty, seed));
  }, 700);
}

function onSettled(): void {
  const m = match();
  const out = roundOutcome(board(), g.flicker);

  if (!out.over) {
    // Skips anyone already knocked off, so a five-player round keeps moving.
    m.turn = nextTurn(board(), g.flicker);
    g.phase = 'aim';
    syncHint();
    maybeTakeAiTurn();
    return;
  }

  awardRound(m, out.winner, out.reason);
  const names = playerNames();

  if (out.winner === null) {
    showBanner('Everyone went over', 'nobody scores — play it again');
  } else {
    showBanner(
      `${names[out.winner]} ${m.winner !== null ? 'wins the match' : 'takes the round'}`,
      out.reason === 'self-out'
        ? `${names[g.flicker]} went over the edge`
        : 'knocked clean off the desk'
    );
  }

  const me = g.mode === 'online' ? g.seat : 0;
  const iWon = out.winner === me;
  later(() => sound.chime(iWon), 260);

  if (m.winner !== null) {
    g.phase = 'matchover';
    later(showMatchOver, 1500);
  } else {
    g.phase = 'roundover';
    later(startRound, 1700);
  }

  // Both clients computed the same result independently. Only the host writes
  // it, so a refresh can pick the match back up where it stopped.
  if (g.mode === 'online' && g.seat === 0 && g.room) {
    const room = g.room;
    patchRoom(room.code, {
      score: m.score,
      round: m.round,
      turn: m.turn,
      state: board(),
      status: m.winner !== null ? 'finished' : 'playing',
    }).catch(() => {});
    if (m.winner !== null) {
      recordMatch(room, m.winner, m.score).catch(() => {});
    }
  }

  syncHint();
}

function showMatchOver(): void {
  const m = match();
  const names = playerNames();
  const w = m.winner;
  if (w === null) return;
  $('overTitle').textContent = w === 0 ? 'You win!' : `${names[w]} wins.`;
  $('overText').textContent = `${m.score.join(' — ')}${
    g.mode === 'ai' ? ` on ${DIFFICULTY_LABELS[g.difficulty].toLowerCase()}` : ''
  }`;
  showCard('overCard');
  $('banner').hidden = true;
}

function toMenu(): void {
  clearTimers();
  leaveRoom();
  g.mode = g.mode === 'online' ? 'ai' : g.mode;
  g.phase = 'menu';
  g.drag = null;
  showCard('menuCard');
  $('hint').hidden = true;
  $('banner').hidden = true;
}

// ---------------------------------------------------------------- screen text

function showBanner(title: string, sub?: string): void {
  const el = $('banner');
  el.innerHTML = '';
  el.append(document.createTextNode(title));
  if (sub) {
    const s = document.createElement('small');
    s.textContent = sub;
    el.append(s);
  }
  el.hidden = false;
}

function syncHint(): void {
  const show = g.phase === 'aim' && g.match && isHumanTurn() && !g.drag;
  $('hint').hidden = !show;
  if (!show) return;
  $('hint').textContent = 'Drag back from your sharpener, then let go';
}

// The score lives on the classroom blackboard rather than in a HUD.
function boardInfo(): BoardInfo {
  const names = playerNames();
  if (!g.match) {
    return { subtitle: 'best of five', rows: null, target: ROUNDS_TO_WIN };
  }
  const m = g.match;

  let subtitle = `round ${m.round}`;
  if (g.phase === 'aim') {
    subtitle =
      g.mode === 'ai' && m.turn !== 0
        ? `${names[m.turn].toLowerCase()} is thinking…`
        : `${names[m.turn].toLowerCase()} to flick`;
  } else if (g.phase === 'matchover') {
    subtitle = 'full time';
  }
  if (g.mode === 'ai') subtitle += ` · ${DIFFICULTY_LABELS[g.difficulty].toLowerCase()}`;

  return {
    subtitle,
    target: ROUNDS_TO_WIN,
    rows: Array.from({ length: m.players }, (_, i) => ({
      name: names[i],
      score: m.score[i],
      color: getSkin(skinIds()[i]).body,
      active: g.phase === 'aim' && m.turn === i,
    })),
  };
}

// ---------------------------------------------------------------- input

function aimFrom(pointer: Point): Flick | null {
  const m = match();
  const p = board().pucks[m.turn];
  // Slingshot: pull away from where you want to go.
  const dx = p.x - pointer.x;
  const dy = p.y - pointer.y;
  const d = Math.hypot(dx, dy);
  if (d < 1) return null;
  const power = Math.round(Math.min(d / MAX_DRAG, 1) * POWER_UNITS);
  return {
    player: m.turn,
    angle: radiansToAngle(Math.atan2(dy, dx)),
    power,
    seed: mixSeed(m.seed, m.round, board().tick),
  };
}

canvas.addEventListener('pointerdown', (e) => {
  sound.unlock(); // browsers will not start audio without a gesture
  if (g.phase !== 'aim' || !isHumanTurn()) return;
  const pt = renderer.toTable(e.clientX, e.clientY);
  const p = board().pucks[match().turn];
  if (Math.hypot(pt.x - p.x, pt.y - p.y) > GRAB) return;
  canvas.setPointerCapture(e.pointerId);
  g.drag = { pointer: pt, id: e.pointerId };
  syncHint();
});

canvas.addEventListener('pointermove', (e) => {
  if (!g.drag || e.pointerId !== g.drag.id) return;
  g.drag.pointer = renderer.toTable(e.clientX, e.clientY);
});

function releaseDrag(e: PointerEvent, cancel: boolean): void {
  if (!g.drag || e.pointerId !== g.drag.id) return;
  const flick = cancel ? null : aimFrom(g.drag.pointer);
  g.drag = null;
  if (flick && flick.power >= MIN_POWER) commitFlick(flick);
  else syncHint();
}

canvas.addEventListener('pointerup', (e) => releaseDrag(e, false));
canvas.addEventListener('pointercancel', (e) => releaseDrag(e, true));

// ---------------------------------------------------------------- loop

// Shown behind the menu before a match exists.
const IDLE_STATE = stateForRound(createMatch(1, 0));

let last = performance.now();
let acc = 0;

// Reused each frame so the sim never allocates on our behalf.
const stepEvents: SimEvent[] = [];

function playEvents(events: SimEvent[]): void {
  // Several ticks can land in one frame; one strike sound per frame is plenty,
  // and it should be the hardest of them.
  let hardest = 0;
  let wentOff = false;
  for (const e of events) {
    if (e.type === 'hit') hardest = Math.max(hardest, e.speed);
    else if (e.type === 'off') wentOff = true;
  }
  if (hardest > 0) sound.clack(hardest / MAX_SPEED);
  if (wentOff) sound.fall();
}

function currentAim(): Aim | null {
  if (!g.drag || g.phase !== 'aim') return null;
  const flick = aimFrom(g.drag.pointer);
  if (!flick) return null;

  const m = match();
  const p = board().pucks[m.turn];
  const rad = angleToRadians(flick.angle);
  const reach = 55 + (flick.power / POWER_UNITS) * 150;

  return {
    from: { x: p.x, y: p.y },
    pointer: g.drag.pointer,
    // Arrow tip in table space, so perspective foreshortens it correctly.
    tip: { x: p.x + Math.cos(rad) * reach, y: p.y + Math.sin(rad) * reach },
    power: flick.power,
    path: flick.power >= MIN_POWER ? previewPath(board(), flick) : null,
    color: getSkin(skinIds()[m.turn]),
  };
}

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;

  // Fixed timestep. However fast the display refreshes, the sim advances in
  // whole DT steps — so the outcome is the same on a 60Hz laptop and a 144Hz
  // monitor, which is what makes replaying a flick elsewhere safe.
  if (g.state && g.phase !== 'menu' && g.phase !== 'aim') {
    acc += dt;
    let guard = 0;
    stepEvents.length = 0;
    while (acc >= DT && guard++ < 600) {
      step(g.state, stepEvents);
      acc -= DT;
    }
    if (stepEvents.length) playEvents(stepEvents);
    if (g.phase === 'sim' && isAtRest(g.state)) {
      acc = 0;
      onSettled();
    }
  } else {
    acc = 0;
  }

  renderer.draw(g.state ?? IDLE_STATE, {
    aim: currentAim(),
    activePlayer: g.match ? g.match.turn : 0,
    showActive: g.phase === 'aim',
    board: boardInfo(),
    skins: skinIds(),
  });

  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- boot

/** The `button[data-value]` a click landed on, if any. */
function valueButton(e: Event): HTMLButtonElement | null {
  return (e.target as Element | null)?.closest<HTMLButtonElement>('button[data-value]') ?? null;
}

$('playerCount').addEventListener('click', (e) => {
  const btn = valueButton(e);
  if (!btn) return;
  g.players = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, Number(btn.dataset.value)));
  [...$('playerCount').children].forEach((b) => b.classList.toggle('on', b === btn));
});

$('difficulty').addEventListener('click', (e) => {
  const btn = valueButton(e);
  if (!btn) return;
  g.difficulty = btn.dataset.value as Difficulty;
  [...$('difficulty').children].forEach((b) => b.classList.toggle('on', b === btn));
});

$('playAi').addEventListener('click', () => {
  g.mode = 'ai';
  startMatch();
});

$('rematch').addEventListener('click', async () => {
  if (g.mode !== 'online' || !g.room) return startMatch();
  // Host picks the new seed so both sides deal from the same deck.
  if (g.seat === 0) {
    const seed = mixSeed(Date.now() & 0xffffffff, Math.trunc(performance.now()));
    await patchRoom(g.room.code, {
      seed,
      score: Array(g.room.players).fill(0),
      round: 1, turn: 0, status: 'playing',
    }).catch(() => {});
    g.channel?.send('rematch', { seed, players: g.room.players });
    beginOnlineMatch(seed, 0);
  } else {
    note('lobbyNote', 'Waiting for the host to start another…');
    showCard('lobbyCard');
  }
});
$('toMenu').addEventListener('click', toMenu);
$('overBack').addEventListener('click', toMenu);

// The overlay cards can be opened mid-match, so they remember where to return.
let cameFrom: string | null = 'menuCard';

function openCard(id: string): void {
  cameFrom = $('overlay').hidden ? null : (CARDS.find((c) => !$(c).hidden) ?? null);
  showCard(id);
}

function closeCard(): void {
  if (cameFrom) showCard(cameFrom);
  else $('overlay').hidden = true;
}

$('navHow').addEventListener('click', () => openCard('howCard'));
$('howBack').addEventListener('click', closeCard);
$('howClose').addEventListener('click', closeCard);
$('authBack').addEventListener('click', closeCard);

// ---------------------------------------------------------------- sign-in

function authNote(message: string | null): void {
  const el = $('authNote');
  el.textContent = message ?? '';
  el.hidden = !message;
}

$('navSignIn').addEventListener('click', async () => {
  openCard('authCard');
  authNote(null);

  if (!isConfigured) {
    authNote('Supabase keys are missing from .env.local.');
    return;
  }

  try {
    await mountGoogleButton($('googleButton'), {
      onError: (e) => authNote(e.message || 'Google sign-in failed.'),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : '';
    authNote(
      message === 'gis-blocked'
        ? "Google's sign-in script was blocked — check an ad blocker and reload."
        : message === 'no-client-id'
          ? 'VITE_GOOGLE_CLIENT_ID is missing from .env.local.'
          : 'Could not start Google sign-in.'
    );
  }
});

$('navSignOut').addEventListener('click', () => void signOut());

$('navFriend').addEventListener('click', () => {
  if (!requireSignIn()) return;
  openCard('onlineCard');
});

$('playOnline').addEventListener('click', () => {
  if (!requireSignIn()) return;
  openCard('onlineCard');
});

// Reflect who is signed in, in the top bar and on the online-play button.
onAuth(async (session) => {
  const user = session?.user ?? null;
  g.user = user;

  $('navSignIn').hidden = Boolean(user);
  $('navMe').hidden = !user;
  $<HTMLButtonElement>('navFriend').disabled = !user;
  $<HTMLButtonElement>('playOnline').disabled = !user;

  const soon = document.querySelector('#playOnline .soon');
  if (soon) soon.textContent = user ? 'room code or friend list' : 'needs sign-in';

  if (!user) return;

  // Close the sign-in card once it has actually worked.
  if (!$('authCard').hidden) closeCard();

  const profile = await fetchProfile(user.id);
  g.profile = profile;
  $('navName').textContent =
    profile?.display_name || user.user_metadata?.full_name || 'Player';
  // If the avatar still fails (Brave shields, offline, a dead URL), fall back
  // to an initial rather than leaving a broken-image box in the top bar.
  const name = $('navName').textContent ?? '';
  const avatar = profile?.avatar_url || user.user_metadata?.avatar_url;
  const img = $<HTMLImageElement>('navAvatar');
  const showInitial = () => {
    img.hidden = true;
    $('navInitial').textContent = (name[0] || '?').toUpperCase();
    $('navInitial').hidden = false;
  };
  img.onerror = showInitial;
  if (avatar) {
    img.hidden = false;
    $('navInitial').hidden = true;
    img.src = avatar;
  } else {
    showInitial();
  }

  startLiveSubscriptions(user);
  void consumeRoomLink();
});

let stopPresence: (() => void) | null = null;
let stopInvites: (() => void) | null = null;

function startLiveSubscriptions(user: User): void {
  stopPresence?.();
  stopInvites?.();

  stopPresence = trackPresence(user.id, (ids) => {
    g.online = ids;
    if (!$('friendsCard').hidden) void renderFriends();
  });

  stopInvites = listenForInvites(user.id, (payload) => {
    if (!payload?.code) return;
    g.invite = payload;
    $('inviteTitle').textContent = `${payload.from || 'A friend'} wants a game.`;
    $('inviteText').textContent = `Room ${payload.code}. First to three rounds.`;
    openCard('inviteCard');
  });
}

// A shared /play/?room=CODE link drops you straight into the room.
let roomLinkUsed = false;

async function consumeRoomLink(): Promise<void> {
  if (roomLinkUsed) return;
  const code = new URLSearchParams(location.search).get('room');
  if (!code) return;
  roomLinkUsed = true;
  history.replaceState(null, '', location.pathname);
  try {
    await enterRoom(await joinRoom(code), 1);
  } catch (e) {
    openCard('onlineCard');
    note('onlineNote', errorText(e, 'That room is no longer open.'));
  }
}

// ResizeObserver rather than a resize listener: in dev the stylesheet is
// injected by JS, so measuring at boot can read a pre-layout size.
new ResizeObserver(() => renderer.resize()).observe(canvas);
renderer.resize();
requestAnimationFrame(frame);

// ================================================================ online play

/** Whatever a rejected promise carried, reduced to something showable. */
function errorText(e: unknown, fallback: string): string {
  return (e instanceof Error && e.message) || fallback;
}

function note(id: string, message: string | null): void {
  const el = $(id);
  el.textContent = message ?? '';
  el.hidden = !message;
}

function myName(): string {
  return g.profile?.display_name || g.user?.user_metadata?.full_name || 'A friend';
}

function requireSignIn(): boolean {
  if (g.user) return true;
  $('navSignIn').click();
  return false;
}

async function refreshRoom(): Promise<Room | null> {
  if (!g.room) return null;
  const fresh = await fetchRoom(g.room.code).catch(() => null);
  if (fresh) g.room = fresh;
  return g.room;
}

/** Names for every occupied seat, so the lobby and blackboard read properly. */
async function refreshSeatNames(): Promise<void> {
  const seats = g.room?.seats ?? [];
  g.seatNames = await Promise.all(
    seats.map(async (id, i) => {
      if (i === g.seat) return 'You';
      const profile = await fetchProfile(id);
      return profile?.display_name || profile?.handle || `Player ${i + 1}`;
    })
  );
}

function renderLobby(): void {
  if (!g.room) return;
  const room = g.room;
  $('roomCode').textContent = room.code;

  const seats = room.seats ?? [];
  const ready = room.ready ?? [];
  const rows = Array.from({ length: room.players }, (_, i) => ({
    seat: i,
    empty: i >= seats.length,
    ready: Boolean(ready[i]),
    label:
      i >= seats.length
        ? 'Waiting for someone…'
        : i === g.seat
          ? 'You'
          : g.seatNames[i] || 'Player ' + (i + 1),
  }));

  $('seats').replaceChildren(
    ...rows.map((r) => {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = getSkin(skinIds()[r.seat] ?? DEFAULT_SKIN).body;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = r.label;
      li.append(dot, name);
      if (!r.empty) {
        const tick = document.createElement('span');
        tick.className = 'ready-tick';
        tick.textContent = r.ready ? '✓ ready' : '…';
        li.append(tick);
      }
      return li;
    })
  );

  const full = (room.seats?.length ?? 0) >= room.players;
  const mine = Boolean(room.ready?.[g.seat]);
  const readyUp = $<HTMLButtonElement>('readyUp');
  readyUp.disabled = mine || !full;
  readyUp.textContent = mine
    ? 'Waiting for the others…'
    : full
      ? "I'm ready"
      : `Waiting for ${room.players - (room.seats?.length ?? 0)} more`;
}

function beginOnlineMatch(seed: number, turn?: number, players?: number): void {
  clearTimers();
  g.mode = 'online';
  g.players = players ?? g.room?.players ?? 2;
  g.match = createMatch(seed >>> 0, turn ?? 0, g.players);
  startRound();
  $('overlay').hidden = true;
}

async function maybeStart(): Promise<void> {
  // Only seat 0 decides when play begins, so nobody starts the match twice.
  if (g.seat !== 0 || !g.room) return;
  const room = g.room;
  const seats = room.seats ?? [];
  if (seats.length < room.players) return;
  if (!(room.ready ?? []).slice(0, room.players).every(Boolean)) return;

  await patchRoom(room.code, { status: 'playing' }).catch(() => {});
  g.channel?.send('start', {
    seed: room.seed, turn: 0, players: room.players, skin: g.mySkin, seat: g.seat,
  });
  beginOnlineMatch(room.seed, 0, room.players);
}

async function enterRoom(room: Room | null, seat: number): Promise<void> {
  if (!room) throw new Error('That room is no longer open.');
  leaveRoom({ silent: true });
  g.room = room;
  g.seat = seat;
  g.mode = 'online';
  g.players = room.players ?? 2;
  g.oppSkins = {};

  g.channel = joinChannel(room.code, {
    joined: async (p) => {
      if (p?.skin && p.seat != null) g.oppSkins[p.seat] = p.skin;
      // Answer with ours, so the joiner learns what everyone else is using.
      g.channel?.send('ready', { seat: g.seat, skin: g.mySkin });
      await refreshRoom();
      await refreshSeatNames();
      renderLobby();
    },
    ready: async (p) => {
      if (p?.skin && p.seat != null) g.oppSkins[p.seat] = p.skin;
      await refreshRoom();
      renderLobby();
      void maybeStart();
    },
    start: (p) => {
      if (p?.skin && p.seat != null) g.oppSkins[p.seat] = p.skin;
      beginOnlineMatch(p.seed, p.turn, p.players);
    },
    flick: (flick) => {
      if (g.mode !== 'online' || !g.state || !g.match || g.phase !== 'aim') return;
      // A broadcast can claim to be any seat, and channel authorisation cannot
      // help here — the sender is a legitimate player in this room. Accept a
      // flick only for the seat whose turn it actually is, and never for our
      // own seat, whose shots we already ran locally before broadcasting.
      if (flick.player !== g.match.turn || flick.player === g.seat) return;
      commitFlick(flick, { broadcast: false });
    },
    rematch: (p) => beginOnlineMatch(p.seed, 0, p.players),
    left: () => note('lobbyNote', 'The other player left the room.'),
  });

  await refreshSeatNames();
  showCard('lobbyCard');
  note('lobbyNote', null);
  renderLobby();
  if (seat > 0) g.channel.send('joined', { seat, skin: g.mySkin });
}

function leaveRoom({ silent = false } = {}): void {
  if (g.channel) {
    if (!silent) g.channel.send('left', {});
    g.channel.leave();
  }
  g.channel = null;
  g.room = null;
}

$('onlineBack').addEventListener('click', closeCard);
$('lobbyBack').addEventListener('click', () => {
  leaveRoom();
  showCard('menuCard');
});

$('createRoom').addEventListener('click', async () => {
  if (!requireSignIn()) return;
  note('onlineNote', null);
  try {
    const code = await createRoom(g.players);
    const room = await fetchRoom(code);
    await enterRoom(room, 0);
  } catch (e) {
    note('onlineNote', errorText(e, 'Could not create a room.'));
  }
});

$('joinRoom').addEventListener('click', async () => {
  if (!requireSignIn()) return;
  const code = $<HTMLInputElement>('joinCode').value.trim();
  if (code.length < 5) return note('onlineNote', 'A room code is five letters.');
  note('onlineNote', null);
  try {
    const room = await joinRoom(code);
    // The seat we just took is the one we were appended to.
    await enterRoom(room, room.seats.length - 1);
  } catch (e) {
    note('onlineNote', errorText(e, 'That room is not available.'));
  }
});

$('joinCode').addEventListener('input', (e) => {
  const input = e.target as HTMLInputElement;
  input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

$('readyUp').addEventListener('click', async () => {
  if (!g.room) return;
  try {
    g.room = await setReady(g.room.code, g.seat);
    renderLobby();
    g.channel?.send('ready', { seat: g.seat, skin: g.mySkin });
    void maybeStart();
  } catch {
    note('lobbyNote', 'Could not mark you ready — try again.');
  }
});

$('copyCode').addEventListener('click', async () => {
  if (!g.room) return;
  const link = `${location.origin}/?room=${g.room.code}`;
  try {
    await navigator.clipboard.writeText(link);
    note('lobbyNote', 'Link copied — send it over.');
  } catch {
    note('lobbyNote', link);
  }
});

// ---------------------------------------------------------------- friends

let searchTimer: number | undefined;

function personRow(
  profile: Profile,
  actionLabel: string | null,
  onAction: (btn: HTMLButtonElement) => void,
  { showDot = false } = {}
): HTMLLIElement {
  const li = document.createElement('li');

  if (showDot) {
    const dot = document.createElement('span');
    dot.className = 'online-dot' + (g.online.has(profile.id) ? '' : ' off');
    li.append(dot);
  }

  if (profile.avatar_url) {
    const img = document.createElement('img');
    img.referrerPolicy = 'no-referrer';
    img.src = profile.avatar_url;
    img.alt = '';
    li.append(img);
  }

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = profile.display_name || profile.handle;
  li.append(name);

  if (actionLabel) {
    const btn = document.createElement('button');
    btn.className = 'pill';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => onAction(btn));
    li.append(btn);
  }
  return li;
}

async function renderFriends(): Promise<void> {
  if (!g.user) return;
  const me = g.user;
  const { friends, incoming } = await loadFriends(me.id);

  $('incomingLabel').hidden = incoming.length === 0;
  $('incomingList').replaceChildren(
    ...incoming.map((p) =>
      personRow(p, 'Accept', async (btn) => {
        btn.disabled = true;
        await acceptFriend(p.id, me.id).catch(() => {});
        void renderFriends();
      })
    )
  );

  $('friendsEmpty').hidden = friends.length > 0;
  $('friendsList').replaceChildren(
    ...friends.map((p) =>
      personRow(p, 'Invite', (btn) => void inviteFriend(p, btn), { showDot: true })
    )
  );
}

async function inviteFriend(profile: Profile, btn?: HTMLButtonElement): Promise<void> {
  if (btn) btn.disabled = true;
  try {
    if (!g.room) {
      const code = await createRoom(g.players);
      await enterRoom(await fetchRoom(code), 0);
    }
    await sendInvite(profile.id, { code: g.room!.code, from: myName() });
    showCard('lobbyCard');
    note('lobbyNote', `Invited ${profile.display_name || profile.handle}.`);
  } catch (e) {
    note('lobbyNote', errorText(e, 'Could not send that invite.'));
  } finally {
    if (btn) btn.disabled = false;
  }
}

$('openFriends').addEventListener('click', () => {
  if (!requireSignIn()) return;
  openCard('friendsCard');
  void renderFriends();
});

$('inviteFromLobby').addEventListener('click', () => {
  openCard('friendsCard');
  void renderFriends();
});

$('friendsBack').addEventListener('click', closeCard);

$('friendSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const query = (e.target as HTMLInputElement).value;
  searchTimer = setTimeout(async () => {
    if (!g.user) return;
    const me = g.user;
    const found = query.trim().length >= 2 ? await searchProfiles(query, me.id) : [];
    $('searchResults').replaceChildren(
      ...found.map((p) =>
        personRow(p, 'Add', async (btn) => {
          btn.disabled = true;
          btn.textContent = 'Asked';
          await requestFriend(p.id, me.id).catch(() => {});
        })
      )
    );
  }, 250);
});

// ---------------------------------------------------------------- invites

$('acceptInvite').addEventListener('click', async () => {
  const code = g.invite?.code;
  if (!code) return;
  try {
    const room = await joinRoom(code);
    await enterRoom(room, room.seats.length - 1);
  } catch (e) {
    note('onlineNote', errorText(e, 'That room is no longer open.'));
    showCard('onlineCard');
  }
});

$('ignoreInvite').addEventListener('click', closeCard);
$('inviteBack').addEventListener('click', closeCard);

// ================================================================ skin picker

const SKIN_KEY = 'sf.skin';

function applySkin(id: string): void {
  g.mySkin = getSkin(id).id;
  $('skinLabel').textContent = getSkin(g.mySkin).name;
  try {
    localStorage.setItem(SKIN_KEY, g.mySkin);
  } catch {
    // Private browsing can refuse storage; the choice just won't persist.
  }
  renderSkinGrid();
}

function renderSkinGrid(): void {
  $('skinGrid').replaceChildren(
    ...SKINS.map((skin) => {
      const btn = document.createElement('button');
      btn.className = 'skinopt' + (skin.id === g.mySkin ? ' on' : '');
      btn.type = 'button';

      const img = document.createElement('img');
      img.src = skinSrc(skin.id);
      img.alt = skin.name;

      const label = document.createElement('span');
      label.textContent = skin.name;

      btn.append(img, label);
      btn.addEventListener('click', () => applySkin(skin.id));
      return btn;
    })
  );
}

$('openSkins').addEventListener('click', () => openCard('skinCard'));
$('skinBack').addEventListener('click', closeCard);

try {
  applySkin(localStorage.getItem(SKIN_KEY) ?? DEFAULT_SKIN);
} catch {
  applySkin(DEFAULT_SKIN);
}

preloadSkins();

// ================================================================ chrome

// Every paper card carries a close chip; dismissing just reveals the desk.
document.addEventListener('click', (e) => {
  if ((e.target as Element | null)?.closest('[data-close]')) $('overlay').hidden = true;
});

// …and the corner badge is how you get back, so closing can never strand you.
// It reopens the lobby rather than the menu if you are sitting in a room.
$('badge').addEventListener('click', () => {
  if (!$('overlay').hidden) {
    $('overlay').hidden = true;
    return;
  }
  showCard(g.room ? 'lobbyCard' : 'menuCard');
});

function syncSoundButton(): void {
  const on = sound.isEnabled();
  $('navSound').textContent = on ? '🔊' : '🔇';
  $('navSound').title = on ? 'Sound on' : 'Sound off';
}

$('navSound').addEventListener('click', () => {
  sound.setEnabled(!sound.isEnabled());
  syncSoundButton();
});

syncSoundButton();

// Any first interaction is enough to let the audio context start.
document.addEventListener('pointerdown', () => sound.unlock(), { once: true });
