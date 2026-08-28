# Sharpener Fight

A browser game of the classic desk sport: flick your sharpener across the table
and try to knock the opponent's sharpener off the edge. Play against the
computer, or sign in and play a friend over the internet from any device.

---

## 1. Goal & scope

**Goal:** ship a small, finished, fun game. Not a commercial hit — a real thing
that works, is smooth, and can be shared with a link.

**In scope (v1):**

- **Two to five players**, against the computer or against friends online. The
  desk grows with the count so nobody is crowded against an edge.
- Six pickable sharpener skins — cosmetic only, identical physics.
- Deterministic 2D physics (position, velocity, friction, collision, edge‑out).
- **Play vs computer** — simple AI opponent, no login required.
- **Google login.**
- **Play vs friend online**, two ways:
  - **Room code** — create a room, share the code/link.
  - **Friend list** — add friends, see who's online, invite them directly.
- **Lobby** — both players sit in the room, ready up, then the match starts.
- First to 3 rounds wins. Match history on the profile.
- **One page.** The game *is* the site — anyone who arrives lands on the desk.
  SEO tags and `<noscript>` copy ride on it; there is no separate landing page.

**Out of scope (until v1 is fun and shipped):**

- Ranked / matchmaking with strangers.
- Real‑time *simultaneous* physics (both sharpeners moving at once — see §2).
- In‑game chat, emotes.
- Cosmetics / loadouts / progression.
- Mobile app wrappers.

---

## 2. Why this is instant over the internet

The game is **turn‑based**: one player flicks, then the other. Only **one object
moves per turn**. This is how the real desk game works, and it removes almost
all multiplayer difficulty:

1. Player A drags and flicks → **A's client runs the physics immediately**
   (zero perceived latency for A).
2. A sends the flick input once: `{ angle, power, seed }`.
3. B's client runs the **same deterministic physics** from that input →
   identical result, ~1 network hop later.
4. Both clients save the resulting positions. Next turn is B's.

No client‑side prediction, no reconciliation, no authoritative physics server.
B sees the flick animate ~50 ms after A releases. Different devices, different
networks, different cities — it feels immediate, because you were waiting for
the other player's input anyway.

> "No latency" does not exist over the internet. This design hides it instead.

**Why not simultaneous play?** Once both players can flick at any moment,
determinism alone stops being enough — both clients must also agree on *which
tick* each input landed on, with packets arriving out of order. That means
lockstep with input delay or rollback with resimulation, plus a tick‑authoritative
server (Supabase Realtime is a message relay, not a game server). That is a
netcode project, not a game project. Deferred.

**Determinism requirement:** the physics step must be reproducible. Fixed
timestep, integer or fixed‑point math where practical, and a seeded RNG passed
in the flick payload. Same input → same outcome on both machines.

---

## 3. Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Language | Vanilla JS (or TS) | No game engine, no UI framework |
| Rendering | HTML `<canvas>` 2D | One canvas, hand‑rolled render loop |
| Build tool | **Vite** (`vanilla` template) | Dev server + bundler; output is static files |
| Static hosting | **Vercel** (or Cloudflare Pages) | Free, HTTPS, global CDN, custom domain |
| Auth | **Supabase Auth** — Google provider | Sessions stored in Supabase Postgres |
| Database | **Supabase Postgres** | Profiles, friendships, rooms, matches |
| Realtime sync | **Supabase Realtime** — broadcast | Flick inputs, lobby ready‑up, invites |
| Online status | **Supabase Realtime** — presence | Who's online in the friend list; no DB writes |
| AI opponent | Plain function, client‑side | Runs in the same turn loop as a human |
| Custom backend | **None** | Frontend talks to Supabase directly |

### Why Supabase

- One project gives **auth + database + realtime + presence** with a single
  client library. Less total work than stitching together separate services.
- Sessions are **stored server‑side in Postgres** (`auth.sessions`), with refresh
  tokens, expiry, and logout handled. The browser only holds an opaque token.
- Row Level Security means the friend list and rooms are secured **in the
  database**, so there's no backend to write and no endpoint to forget.
- Free tier is comfortably enough (see §8).

### Known limitations (acceptable for v1)

1. A free Supabase project **pauses after ~7 days of zero traffic**; it wakes on
   the next request with a short cold start.
2. Presence is per‑channel and in‑memory — if a user closes the tab without a
   clean disconnect they can show as online for a few seconds. Fine here.
3. **Nothing is authoritative.** Both clients trust the flicks that arrive on
   the room channel, because that is the whole design (§2). Channel
   authorisation now stops strangers from broadcasting into a room, and the
   receiver ignores any flick that does not belong to the seat whose turn it is
   — but a determined opponent running a patched client can still lie about
   their own shot. Closing that needs a server-side referee, which v1 does not
   have and does not need.

---

## 4. Repo layout

**One repo.** There is no backend service to separate — what lives in git is the
frontend plus a handful of SQL migrations. Splitting them would mean two PRs for
every schema change and no atomic commit. Skip npm workspaces / monorepo tooling
too; plain folders are enough for a single Vite build.

```
sharpener-fight/
├─ index.html              # the game, and the whole site
├─ play/index.html         # redirect only — keeps old /play/?room=CODE links alive
├─ public/
│  ├─ fonts/               # self-hosted Patrick Hand (latin subset, ~23 kB each)
│  ├─ sharpeners/          # generated skin sprites (256px webp, ~10 kB each)
│  └─ …                    # og-image.png, robots.txt, sitemap.xml
├─ src/
│  ├─ game/                # physics, scoring, AI — pure, no DOM, no network
│  ├─ net/                 # supabase client, auth, friends, rooms, realtime
│  └─ ui/                  # projection, classroom scene, renderer
├─ tools/                  # verify.mts, shot.mts, perf.mts, balance.mts
├─ supabase/
│  ├─ config.toml
│  └─ migrations/          # tables + RLS policies
├─ tsconfig.json           # the browser bundle
├─ tsconfig.tools.json     # the Node-only scripts in tools/
├─ .env.local              # gitignored
└─ package.json
```

### More than two players

The desk is `900 × 600` for two and grows by `130 × 86` per extra player, up to
`1290 × 858` for five. Three or more start evenly spaced around an ellipse and
facing the middle, so nobody begins closer to an edge than anyone else.

**A round ends when one sharpener is left.** With two players that reduces
exactly to the old rule — knock yourself off and the only survivor is the other
one. A wipeout (everyone off in the same tick) scores for nobody and the round
is replayed. Turn order skips anyone already knocked off.

Table size lives in `state.w` / `state.h` rather than as a constant, so a
resumed or replayed match cannot disagree with the client that produced it. The
hard AI now scores every surviving opponent, not just the one it aimed at, and
picks whoever is nearest an edge — the cheapest kill.

Online, a room has `seats uuid[]` instead of a host/guest pair, and the seat
index *is* the player number the sim uses. Duplicate ids are deliberately
allowed so a second tab can join your own room for testing.

### Performance

Two things were being redrawn every frame that never change: the classroom and
the desk — gradients, a blurred contact shadow, wood grain, 58 scratches. They
are now painted once into an offscreen canvas and blitted, and a per-sharpener
`ctx.filter = 'blur(3px)'` shadow was replaced with one cached radial sprite.

Measured with `node tools/perf.mts` in headless Chromium (software rendering, so
a real GPU does better):

```
before   433 ms/frame     2 fps
after     16.7 ms/frame   60 fps   (two players and five, both vsync-capped)
```

The sharpener sides are stacked silhouette copies, and the number of copies is
derived from how tall the sharpener actually is on screen — a five-player desk
draws smaller, so it needs fewer, which is exactly when the draw calls would
otherwise hurt most.

### Sound

Synthesised with WebAudio, not sampled — a plastic clack is a filtered noise
burst plus a short pitched body, which costs zero bytes of download and lets the
strike scale continuously with how hard the two sharpeners actually met.

The sim reports impacts through an **optional out-parameter**, never through
state:

```js
step(state, events)   // events?.push({ type: 'hit', speed })
```

Writing sound cues into `state` would change what gets hashed by
`npm run verify`, serialised into Postgres, and replayed on the other client.
Keeping them in a caller-owned array leaves the sim a pure function of state and
input, and the determinism checks still pass unchanged. `simulate()` — which the
hard AI runs fifty times a turn — passes no array, so searching the future is
silent.

Browsers refuse to start audio without a gesture, so the context is unlocked on
the first pointerdown. There is a mute toggle in the top bar, remembered in
`localStorage`.

### Sharpener skins

Six skins, chosen from the menu and remembered in `localStorage`. They are
**cosmetic only** — same collision radius, same physics, same everything. The
skin id lives in `src/ui/`, never in `src/game/`, so a skin cannot alter a
match outcome even by accident. Online, the two clients swap skin ids over the
room channel so each sees the other's real choice.

The sprites in `public/sharpeners/` are **pre-built and committed**. They came
from source photographs (1–2.4 MB each, ~9.5 MB total) that are no longer in the
repo, so there is nothing left to regenerate them from and no build step for
them. Shipping the originals would have cost 9.5 MB for something that draws at
about 80 CSS pixels:

```
9.5 MB of source  →  64 kB of sprites
```

If the photographs are ever re-shot, this is the recipe that produced the
current set — trim the transparent border, lay the standing ones down so every
skin faces the same way (pencil hole to the left), square the canvas so they all
rotate about their own centre and draw at one size, then encode to WebP with
alpha:

```bash
magick hq/1.png -background none -rotate 0 -trim +repage \
  -resize 240x240 -gravity center -extent 256x256 \
  -define webp:alpha-quality=100 -quality 88 public/sharpeners/bubblegum.webp
```

`hq/2.png` (grape) and `hq/5.png` (firecracker) were photographed standing up
and need `-rotate -90`; the rest use `-rotate 0`.

### First paint

Two things used to delay or spoil the first frame, both fixed:

1. **CSS came in through JavaScript.** `import './style.css'` works, but Vite's
   dev server only injects it once the module has run — so every refresh painted
   one frame of raw, unstyled HTML. The stylesheet is now a plain
   `<link>` in the head, which blocks that first paint in dev *and* in the build.
   With the JS entry artificially stalled for two seconds, the page still renders
   correctly styled.
2. **Fonts came from Google.** A third-party font stylesheet is render-blocking,
   so it cost a full network round trip before anything appeared, then swapped
   the type once it landed. Patrick Hand is now self-hosted and preloaded, latin
   subset only. The page makes **no external requests at all**.

There is a small inline `<style>` in the head as a backstop: if the stylesheet is
ever missing, the page shows the classroom's dark green rather than a stack of
bare markup.

### TypeScript

The whole codebase is TypeScript under `strict`, browser and tools alike. Vite
hands every module to esbuild, which strips types and checks nothing, so
type-checking is its own pass: `npm run typecheck`, which `npm run build` runs
first. There are two configs because the two halves resolve modules differently
— `tsconfig.json` for the bundled app, `tsconfig.tools.json` for `tools/`, which
runs on Node's own type stripping (node 22.18+, no build step) and therefore
wants explicit `.ts` extensions on relative imports. Every relative import in
the repo carries one, so the same source works either way.

The types that earn their keep are in `src/game/types.ts`: `GameState`, `Puck`,
and `Flick`. Those three are exactly the values that get JSON-serialised into a
Postgres `jsonb` column and broadcast over the Realtime channel, so they are all
plain data — a class or a method would not survive the round trip, and the type
now says so. `SimEvent` is a discriminated union, which is what lets `playEvents`
in `main.ts` tell a `hit` from an `off` without a cast.

### Realtime authorisation

A Supabase Realtime channel is guarded by nothing but its name unless you write
RLS policies on `realtime.messages` *and* open the channel with
`private: true`. Both were missing, and neither channel name was a secret:
`searchProfiles()` hands any signed-in user the id of any other profile, which
is the entire `user:<uuid>` topic. So any account could subscribe to a
stranger's invite channel, lift the room code out of it, and take their seat
with `join_room()` — or join `room:<CODE>` and broadcast a forged flick.

`20260828155435_realtime_authorization.sql` closes it:

| Channel | Read | Write |
| --- | --- | --- |
| `room:<CODE>` | you hold a seat in that room | same |
| `user:<UUID>` | only your own | only to an accepted friend |
| `online` (presence) | any signed-in user | your own presence only |

Joining a topic needs read *or* write, which is what lets `sendInvite()` connect
to a friend's channel to send without gaining the ability to read their other
invites.

The policies must exist before the clients ask for private channels, or online
play stops dead — `realtime.messages` already had RLS enabled with **zero**
policies, which denies every private channel. The migration is **applied**;
one manual step remains:

- Realtime Settings → **Channel Restrictions** → disable *Allow public access*

That step is not optional cosmetics. A private channel and a public channel with
the same topic are distinct channels that never exchange messages, so
`private: true` is what actually closes the hole — but leaving public access on
means any later code path that forgets the flag silently reopens it.

**The one boundary that matters:** `src/game/` must never import `src/net/` or
`supabase-js`. Physics is a pure function of state + input — no I/O, no clock,
no bare `Math.random()`. That is what makes determinism testable (run the sim
headless in Node, assert two runs from the same seed are byte‑identical) and
what lets the AI search by simulation (§6). `npm run verify` enforces this: it
fails the build if anything in `src/game/` picks up an import of network or UI
code, or a bare `Math.random`.

---

## 5. Architecture

```
┌─────────────────────────────────┐
│  Browser (Vite + canvas)        │
│                                 │
│  - render loop                  │
│  - deterministic physics (pure) │
│  - AI opponent (local)          │
│  - input (drag → flick)         │
│  - supabase-js client           │
└───────────────┬─────────────────┘
                │  HTTPS + WebSocket
                ▼
┌─────────────────────────────────┐
│  Supabase project               │
│                                 │
│  Auth      → Google OAuth       │
│  Postgres  → profiles, friends, │
│              rooms, matches     │
│  Realtime  → room:<code>   (match + lobby)
│              user:<uuid>   (invites)
│              online        (presence)
└─────────────────────────────────┘

Static files served by Vercel CDN.
```

### Login / session flow

Deliberately **not** `signInWithOAuth`. That redirects the browser to
`<project>.supabase.co`, so Google's consent screen shows the project ref
(`abcd…supabase.co`) instead of the game's name. Supabase's own answer to that
is the custom‑domain add‑on, which needs a paid plan. This is the free route:

1. Google Identity Services renders its own button on our page
   (`accounts.google.com/gsi/client`). The popup runs against **our** origin, so
   the player sees *sharpenerfight.com*, never Supabase.
2. Google hands the page an **ID token** → `supabase.auth.signInWithIdToken({
   provider: 'google', token })`.
3. Supabase verifies the token, creates the user, and returns access + refresh
   tokens. A DB trigger creates the matching `profiles` row on first sign‑in.
4. `supabase-js` stores the session, refreshes it, and attaches it to DB and
   Realtime calls. `detectSessionInUrl` is off — nothing ever arrives by redirect.
5. RLS policies enforce who can read/write. Logout → `supabase.auth.signOut()`
   plus `disableAutoSelect()`, or Google signs them straight back in.

**Setup this needs:** the Google client ID in `VITE_GOOGLE_CLIENT_ID`, the same
ID registered under the Supabase Google provider, and every origin the game runs
on listed under the client's *Authorised JavaScript origins*. No client secret —
that only exists for the redirect flow.

### Friends & presence

1. Search by handle → insert a `friendships` row (`status = 'pending'`).
2. The addressee sees the request, accepts → `status = 'accepted'`.
3. On login the client joins the `online` presence channel and tracks its user
   id. The friend list renders a dot per friend from the presence state.

### Lobby → match flow

Two ways in, one lobby out:

- **Room code:** A clicks *Create room* → insert a `rooms` row with a short code
  → subscribe to `room:<code>`. A shares the code or link; B opens it, signs in,
  joins → `rooms.guest` set, B subscribes.
- **Friend invite:** A clicks *Invite* on an online friend → same room is created,
  then a broadcast on `user:<B's uuid>` delivers the code. B gets a prompt and
  joins the same way.

Then:

1. Both players are in the lobby (`rooms.status = 'lobby'`). Each broadcasts
   `ready`. When both are ready the host writes `status = 'playing'`.
2. On each turn the active player broadcasts `{ angle, power, seed, turn }`.
   Both clients simulate; both write the resulting state.
3. Final result is written to `matches`. A page refresh re‑reads `rooms` from
   Postgres and resumes exactly where it left off.

---

## 6. The AI opponent

The AI needs no backend and no special casing, because a flick is just data.
A human flick and an AI flick are the same payload — `{ angle, power, seed }` —
fed into the same turn pipeline. The AI is one function:

```js
chooseFlick(state) → { angle, power }
```

Difficulty is just how much thought goes into it:

- **Easy** — aim roughly at the opponent, ±15° of noise, random power.
- **Medium** — aim true, power scaled to distance, ±5° of noise.
- **Hard** — because the physics is pure and deterministic, *simulate*: try ~50
  candidate flicks headless, score each outcome (opponent knocked off > opponent
  pushed toward an edge > self stays safe), play the best one.

That last one is the payoff for the determinism work in §7 step 2 — a genuinely
strong opponent for a few dozen lines and no ML, because the AI can play out the
future before committing. Add a small delay before it flicks so it feels like a
player thinking, not a computer.

---

## 7. Build order

Each step is shippable / demoable on its own. Do not start a step before the
previous one feels good.

> **Status: steps 1–10 are built.** Steps 6–9 (rooms, lobby, friends, invites)
> have not yet been played through with two real accounts — see the note at the
> end of §7.
>
> Google sign-in works without the browser ever visiting
> `<project>.supabase.co` — see §5. `npm run dev` gives a playable game at
> **`/`** — two to five players against the computer at three difficulties, or
> against friends online. The game vs the computer needs no backend, no account,
> and no env vars; everything online needs both variables below.

**The game (no backend, no login):**

1. ✅ **Local game loop.**
   Vite + canvas. Drag‑to‑flick, friction, collision, knock‑off detection, round
   scoring. Make the flicking *fun* — this is the whole product. Everything
   after this is plumbing.

2. ✅ **Deterministic physics pass.**
   Fixed timestep, seeded RNG, pure module. Verify identical outcome from
   identical input across two runs. Needed before AI search and before any
   networking.

3. ✅ **AI opponent.** (§6) Easy/medium first; hard once the sim is fast enough to
   run 50 times in a frame budget. **At this point the game is playable and
   shareable by anyone, with zero accounts.**

4. ✅ **SEO on the game page.**
   Open Graph + Twitter tags, `sitemap.xml`, `robots.txt`, JSON‑LD `VideoGame`
   schema, and a `<noscript>` block with real copy — all in the game's `<head>`,
   since the game is now the only page.

**Online (needs Supabase):**

5. ✅ **Google login.**
   Supabase project, `profiles` table + trigger + RLS, avatar/name in the header,
   logout. Uses Google Identity Services rather than `signInWithOAuth`, so the
   consent popup shows **your** domain instead of the Supabase project ref —
   Supabase's own fix for that is a paid custom-domain add-on, which this avoids.

6. ✅ **Rooms by code + live match.**
   `rooms` table + RLS, create/join by code, `room:<code>` channel, broadcast
   flick inputs, resume from Postgres on refresh. **Now two friends on two
   devices can play — ship this.**

7. ✅ **Lobby.**
   `status = 'lobby'`, both‑players‑ready gate, opponent name/avatar on screen,
   rematch button.

**Social:**

8. ✅ **Friends list + presence.**
   `friendships` table + RLS, search by handle, request/accept, `online` presence
   channel, online dots.

9. ✅ **Invites.** *Invite* button on an online friend → `user:<uuid>` broadcast →
   accept prompt → straight into the lobby.

10. ✅ **Match history.** Write `matches`, "recent games" list on the profile.

11. ⏳ **Polish & ship.** Sound is done — clack, flick, edge-fall, round chime.
    Screen shake and particles are not. Deploy to Vercel, custom domain and the
    share image are still outstanding.

Steps 1–6 are the actual product. 7–9 are the social layer and can land after
launch without breaking anything.

**Not yet verified:** the two-player flow needs two signed-in accounts on two
devices, which cannot be automated here. What *has* been checked directly
against the database: a signed-in stranger sees **0** rooms (`select count(*)
from rooms` under a different `auth.uid()`), so room codes cannot be
enumerated. The create → join → ready → flick path itself is still untested.

---

## 8. Data model (draft)

```sql
-- auth.users is managed by Supabase Auth. Public mirror for handles/avatars:
create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  handle       text unique not null,
  display_name text,
  avatar_url   text,
  created_at   timestamptz default now()
);

create table friendships (
  requester  uuid references auth.users(id) on delete cascade,
  addressee  uuid references auth.users(id) on delete cascade,
  status     text not null default 'pending',  -- pending | accepted | blocked
  created_at timestamptz default now(),
  primary key (requester, addressee),
  check (requester <> addressee)
);

create table rooms (
  code        text primary key,           -- short shareable code
  host        uuid references auth.users(id),
  guest       uuid references auth.users(id),
  host_ready  boolean default false,
  guest_ready boolean default false,
  state       jsonb,                      -- current board state
  turn        text,                       -- 'host' | 'guest'
  status      text default 'waiting',     -- waiting | lobby | playing | finished
  updated_at  timestamptz default now()
);

create table matches (
  id         uuid primary key default gen_random_uuid(),
  room_code  text,
  host       uuid references auth.users(id),
  guest      uuid references auth.users(id),
  winner     text,                        -- 'host' | 'guest'
  score      jsonb,                       -- { host: 3, guest: 1 }
  played_at  timestamptz default now()
);
```

**Notes**

- A friendship is **one row, either direction**. "My friends" queries both sides:
  `where status = 'accepted' and (requester = auth.uid() or addressee = auth.uid())`.
  Accepting is an update, not a second row.
- **RLS:** `profiles` readable by any authenticated user (needed for search),
  writable only by the owner. `friendships` visible only to the two parties; only
  the addressee may flip `pending → accepted`. `rooms` readable/writable only by
  `host` or `guest` (or when `status = 'waiting'` and the user is joining).
  `matches` read‑only to participants.
- Online status is **not** a column. It lives in Realtime presence — no writes,
  no stale rows, no cleanup job.

---

## 9. Free‑tier check (Supabase)

| Resource | Free tier | This project |
|---|---|---|
| Postgres storage | 500 MB | Kilobytes |
| Monthly active auth users | 50,000 | Fine |
| Realtime concurrent connections | 200 | Fine for friend matches |
| Realtime messages | 2M / month | ~1 msg per turn — fine |
| Project pause | after ~7 days idle | Wakes on next visit |

Upgrade path if it ever matters: Supabase Pro at ~$25/month removes the pause and
raises every limit.

---

## 10. SEO notes

- Ranking for generic "game" terms is not realistic. Target the specific name:
  *sharpener fight game*, *sharpener flick game online*, *sharpener war game*.
- Most traffic will come from **direct shares**, not search — so the Open Graph
  image and title matter more than keywords.
- **Tradeoff, taken deliberately:** with no marketing page, the only crawlable
  text is the `<head>` tags plus the `<noscript>` block. That costs some search
  surface. It buys the thing that matters more here — nobody lands on a page
  *about* the game and has to click again to reach it.
- **Let people play before signing in.** vs‑computer needs no account at all;
  the sign-in wall only stands in front of online play.

---

## 11. Local development

```bash
npm install
npm run dev      # the game, at /
npm run verify   # determinism + module-boundary checks
npm run typecheck # tsc over src/ and tools/, no emit
npm run build    # typecheck, then static output in dist/
npm run og       # regenerate public/og-image.png from the .svg (needs ImageMagick)

node tools/shot.mts http://localhost:5173/ shot.png --click="#playAi"
```

The game is at **`/`**. `appType: 'mpa'` in `vite.config.ts` turns off Vite's
single-page fallback, so an unknown path 404s honestly instead of silently
serving the wrong page. The dev port is pinned to **5173** because that exact
origin has to be registered in the Google client ID — if it drifts, sign-in
fails with `origin_mismatch`.

`npm run verify` is the guard rail for §2. It proves the sim is bit-identical
across runs, that stepping frame-by-frame matches running straight through, and
that nothing in `src/game/` has picked up an import of network or UI code or a
bare `Math.random`. Run it before touching anything in `src/game/`.

Environment variables (`.env.local`, not committed):

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_PUBLISHABLE_KEY=...
VITE_GOOGLE_CLIENT_ID=...
```

All three are public by design — they ship in the browser bundle. The
publishable key identifies the project and RLS does the protecting; the Google
client ID has no matching secret, because the ID-token flow does not use one.

Playing the computer needs none of them: without Supabase keys the game still
runs, and sign-in reports that the keys are missing rather than failing
silently.

Deploy: connect the repo to Vercel; build command `npm run build`, output `dist`.
# sharpner-fight
