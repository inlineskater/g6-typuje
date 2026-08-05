# Filler — 1v1 territory flood-fill (full design doc)

„Filler" is the classic Gamos Ltd 1990 DOS game (international release „7 Colors"),
designed by Dmitry Pashkov: two players start in opposite corners of a colored-tile
grid; each turn the active player picks a palette color and every tile of that
color connected to their territory joins it; whoever ends up controlling the
majority of the board wins. `CLAUDE.md` keeps a short pointer here; this is the
full story.

Added 2026-08 as arcade-only (Phase 1, via „Wszystkie Gry"). The seasonal
promotion (Phase 2) is **fully deployed but scheduled for no week** — the
2026-08-10 debut it had been given was reassigned to „Kulki G6" on 2026-08-05
(see the bottom of this doc for why, and for how to schedule a Filler week).

## Why Filler is architecturally different from every other game here

Every other seasonal/arcade game (Snake, Tetris, Healer Dungeon, etc.) runs a
**deterministic-tick simulation client-side**: the browser is authoritative for
gameplay, logs a compact event stream, and an Edge Function replays that log to
derive a trusted score. Each of those games carries a byte-for-byte parity
contract between the client copy and the server copy, verified by a
`scripts/*-parity.mjs` fuzzer.

Filler instead is **server-authoritative for every single move**, like
Poker/Roulette/Wheel:

1. It's PvP, so a live shared authority is unavoidable anyway — there's no
   client to trust as "the" simulation when two different browsers are playing
   each other.
2. Moves are infrequent discrete color-picks (a match is ~50-85 total plies
   across both players), not a 50ms physics tick — a live round-trip per move
   is cheap and correct, unlike a fast game loop.
3. It unifies bot-mode and PvP-mode under **one** Edge Function and **one**
   pair of tables: a "vs bot" match is just a 2-seat match where seat 1 is
   `(user_id NULL, is_bot true)` — exactly Poker's `bots.sql` trick
   (`supabase/bots.sql`). There's no separate "solo" code path to keep in sync
   with a "PvP" one.
4. There is **no hidden information** — the whole board is public to both
   players at all times. Unlike Poker (hidden deck + per-caller response
   sanitization) or Mines/Crash (separate `*_round_secrets` tables), Filler
   needs no secrets table and no per-caller filtering: every caller gets
   exactly the same board.

**Net effect: zero parity contracts** for the *rules*. `games/filler.js` never
runs an authoritative sim — it only renders whatever board state
`supabase/functions/filler-action` returns and sends the player's own color
picks. There is deliberately no `scripts/filler-parity.mjs`.

Two narrow exceptions, both added 2026-08-04, both deliberate:

- **The lattice geometry is shared** (see "Board geometry" below). The server
  decides which tiles a fill flows through; the client decides which tiles
  visibly touch. Those are the same decision, so `neighbors4()` in
  `filler-action` and the layout math in `games/filler.js` must agree.
  ⚠️ **This is the one change here that requires the frontend and the Edge
  Function to ship together** — GitHub Pages auto-deploys `index.html` on push
  while the Edge Function needs a separate `supabase functions deploy`, so
  landing one without the other gives a board whose fills contradict what the
  player sees.
- **`fillerPreviewPick`** in `games/filler.js` re-runs the flood-fill locally
  so your own move paints instantly instead of after a round trip. It is
  explicitly non-authoritative: the server's snapshot overwrites it wholesale
  a few hundred ms later, so a wrong preview self-corrects within one turn and
  can never affect the real board or the score. Without it, the response
  arrives with both your move *and* the bot's reply already applied and you
  never see what your own pick did.

## Board geometry — a DIAMOND LATTICE, not a square grid

⚠️ **Read this before touching `neighbors4`, the board dimensions, or the
rendering.** The playfield is drawn as interlocking rhombi like the original,
which is a square grid **rotated 45° and re-indexed** so the field stays
rectangular:

- odd rows sit **half a tile to the right**;
- rows overlap by **half a tile height**;
- so a rhombus shares a full **edge** only with the two tiles above and the
  two below. Same-row left/right neighbors meet at a single **point** and are
  **not connected**.

```
neighbors of (x, y), with d = (y & 1) ? 0 : -1:
  (x+d, y-1)  (x+d+1, y-1)  (x+d, y+1)  (x+d+1, y+1)     [clamped to the board]
```

Two consequences that are easy to trip over:

1. **h rows are only `(h + 1) / 2` tiles tall**, because rows overlap. That is
   why the boards look portrait in the constants and render landscape:
   21×27 draws as 21.5 × 14 (1.54:1). The old square-grid 31×17 would draw
   3.5:1 here — a letterbox slit.
2. **The corners are not equivalent.** The left column's ends have one
   edge-neighbor where the right column's have two, so a *fixed* corner
   assignment is measurably unfair: `scripts/filler-balance.mjs` measured seat
   0 at 43-45% over 1500 bot-vs-bot matches, and every alternative pair of
   near-corners was skewed too, just in one direction or the other. So
   `generateBoard` **randomizes which seat gets which corner**, which restores
   49-51%. Same principle as `activateMatch` randomizing the first mover:
   fairness comes from randomizing an unavoidable asymmetry, not from
   pretending it isn't there.

## Game rules

Board: **21 cols × 27 rows = 567 tiles, 7 colors** (`FILLER_W`/`FILLER_H`/
`FILLER_COLORS` in `filler-action`), drawn as a 1.54:1 landscape field per the
geometry above. Practice matches **vs a bot use a smaller 15×19 = 285**
(`FILLER_BOT_W`/`FILLER_BOT_H`), which is a ~30% shorter game — median 40
total plies against 58. Sizes may differ per match because a bot match never
scores, so it can't skew a leaderboard calibrated on the PvP board, and
because every dimension-dependent value is derived from the match row's own
`width`/`height` rather than from the module constants (`evaluateEnd`
computes majority per board; the client reads dimensions off the match).

Odd tile count ⇒ majority = 284 ⇒ **ties are structurally impossible** — no
draw-handling logic needed anywhere. **Any future resize must keep
`width × height` odd**, or a real tie becomes reachable and every piece of
code that treats `winner_seat IS NULL` as "abandoned/cancelled only" (the SQL
comment, `evaluateEnd`, the frontend result text) needs a genuine draw case
added. The two seats start in opposite corners — bottom-left and top-right,
assigned at random per the fairness note above; the board is generated with a
seeded PRNG (`mulberry32`) and stored **verbatim** on the match row (the seed
is kept only for audit — there's no client replay that needs to reproduce the
board).

Board sizes have gone 13×11×6 (launch) → 31×17×7 (2026-08-02, a wider DOS-ish
field) → 21×27×7 (2026-08-04, the diamond lattice).

⚠️ **The rule that's easy to get wrong:** a legal color pick is any color
**except the caller's own current territory color AND the opponent's current
territory color** (`color_count − 2` = 5 legal picks with 7 colors, always
≥1 available since `color_count >= 3`). Skipping the opponent-color exclusion
is an **instant-win exploit** — picking the opponent's color would absorb
their entire territory in one flood, since their whole territory is uniformly
that one color. A 0-gain pick (recoloring purely to deny a color to the
opponent, without gaining any neutral tiles) is legal and a real tactic;
`FILLER_MAX_MOVES` (100) is the only anti-stall safety cap — set from
`scripts/filler-balance.mjs`, a bot-vs-bot balance harness (not a parity
contract — there's nothing here to keep byte-identical with, see above) that
measured median/p90/p99/max total plies over 2000 simulated matches at the
current board size (pass dimensions to measure another: `node
scripts/filler-balance.mjs 15 19`); real games finish in ~58 plies on the PvP
board, ~40 on the bot board.

Absorption (`absorb()` in `filler-action`) is standard flood-fill semantics:
recolor the seat's whole territory to the picked color, then transitively
absorb every same-colored **neutral** tile sharing an edge (per the diamond
lattice above — NOT the four orthogonal squares), cascading through
newly-absorbed tiles' own same-colored neighbors — one full connected blob
per move, not a one-tile ring. It can never "steal" the opponent's territory
regardless of color, because it only ever absorbs `owners[j] === -1` (neutral)
tiles.

Win conditions, checked after every applied ply (`evaluateEnd()`): majority
(≥284 tiles on the PvP board — derived from the match's own dimensions, since
bot matches are a different size) → immediate win; board fully partitioned
(no neutral tiles left)
→ higher tile count wins; move cap hit → higher tile count wins (the tie case
in both is handled defensively via a nullable `winner_seat`, even though the
odd tile count makes a real tie unreachable today).

## Schema (`supabase/filler.sql`)

Two tables, no secrets table:

- **`filler_matches`** — one row per match. `status`
  (`waiting|active|finished|cancelled`); `mode` (`bot|pvp`, what was
  *requested*) vs **`opponent_kind`** (`bot|human`, who was *actually* got,
  NULL while waiting) — a `pvp` match that times out to a bot fallback must
  behave like a bot match from then on (no score, the abandon rule applies),
  so scoring and the abandon rule key on `opponent_kind`, never `mode`. Board
  state as two fixed-length `text` columns, `cells` and `owners` (one char per
  tile — `cells` is the color digit, `owners` is `.`/`0`/`1`), **not jsonb**:
  cheap O(n) flood-fill input, cheap client-side diffing (repaint only changed
  indices), ~1134 bytes/match on the wire, backed by
  `CHECK (char_length(cells) = width*height)` so a malformed board can't
  exist. `move_no` is an **optimistic-concurrency token** the client echoes
  back on `pick_color`; a stale/double-clicked call becomes a silent no-op
  (fresh state returned) instead of double-applying. `turn_deadline` is NULL
  until `status='active'` (so the very first waiting player never has a
  stolen head start); `queue_expires_at` is the bot-fallback timer.
- **`filler_match_players`** — one row per seat. `seat` (0/1), `user_id`
  nullable (NULL for bots — Poker's exact `bots.sql` shape;
  `UNIQUE(match_id, user_id)` treats NULLs as distinct so two bot seats never
  collide), `is_bot`, `bot_nick`, `color` (current territory color, cheap
  lookup for legality checks), `tiles`, `moves_made`, **`timeouts`**
  (consecutive auto-played turns, resets to 0 on a real move — drives the
  abandon rule), `score` (NULL for bots and until match end).

**"One open match per user" is a real DB constraint, not just app
discipline:** a denormalized `active boolean` on `filler_match_players`,
maintained by a **trigger** (`filler_sync_players_active`) on
`filler_matches` status changes — not by application code, so a future admin
tool or rematch feature can't silently violate the invariant — backs a
partial unique index:

```sql
CREATE UNIQUE INDEX filler_players_one_open_per_user
  ON public.filler_match_players(user_id) WHERE active AND user_id IS NOT NULL;
```

A violation surfaces as a clean, recoverable 23505 instead of silent data
corruption.

RLS: `SELECT` to `authenticated USING (true)` on both tables — no hidden
info, so spectating a Filler match costs nothing to allow (same reasoning as
`poker_seats`). All writes go through `filler-action`'s own privileged
`SUPABASE_DB_URL` connection; `anon`/`authenticated` have no write grants at
all.

⚠️ **`supabase/arcade.sql` needs zero changes.** `'filler'` is deliberately
absent from `pay_arcade_entry`'s allowlist and `record_arcade_score`'s
score-cap `CASE`, so a forged client call to self-report a Filler score fails
cleanly with `invalid_game_type`. `filler-action`'s privileged connection
(same role Poker/Wheel already write `profiles`/their own tables through,
unaffected by RLS — there is no `FORCE ROW LEVEL SECURITY` anywhere in this
repo) is *provably* the only writer of `game_type='filler'` rows — a stronger
anti-cheat guarantee than the client-callable-RPC path every other arcade
game uses.

## Locking discipline (`supabase/functions/filler-action`)

One fixed order, never violated, matching Poker's "table then seats" shape
with a user-level lock prepended:

1. the caller's `profiles` row — `SELECT ... FOR NO KEY UPDATE` (serializes a
   user's own concurrent calls/tabs without blocking unrelated FK-referencing
   inserts from other users — `FOR NO KEY UPDATE` specifically so it doesn't
   conflict with the `FOR KEY SHARE` other transactions take via FK checks)
2. the `filler_matches` row — `FOR UPDATE` for a known match, or
   `FOR UPDATE SKIP LOCKED` when *scanning* the waiting queue
3. that match's `filler_match_players` rows — `FOR UPDATE ORDER BY seat`
4. `arcade_scores` INSERT last (no row lock needed)

Every transaction opens with `set local lock_timeout = '4s'` (Wheel's
convention). The self-healing sweep only ever locks a *suffix* of this order,
so no cycle is possible.

**Races this resolves, concretely:**
- *Two different users racing `find_opponent` for the same waiting match* —
  `FOR UPDATE SKIP LOCKED` means the loser just skips that row (it's already
  locked) and either finds the next waiting match or creates its own. This is
  NOT Wheel's `wheel_rounds_single_betting_idx` pattern (a partial unique
  index forcing *at most one* globally open row) — Filler needs **many**
  concurrent matches at once, so that pattern doesn't transfer. The
  occasional outcome of two people racing into the queue at the same instant
  is two separate waiting matches instead of one instant pairing — self-
  healing (the next joiner picks the older one; both eventually get a bot
  fallback), not a bug.
- *The same user double-clicking, or two open tabs* — serialized by their own
  `profiles` row lock; the second call sees the same live match (via
  `loadLiveMatchOf`) and returns it idempotently rather than creating a
  duplicate.
- *A move racing the lazy timeout auto-play* — both need the
  `filler_matches` row lock; whichever loses re-validates `current_seat`/
  `move_no`/`turn_deadline` against the post-lock row and either applies
  cleanly or (for a stale `move_no`) silently no-ops.
- *Self-join* — a user can never join their own waiting match: `find_opponent`
  short-circuits to the caller's own live match (if any) *before* it ever
  scans for a waiting match to join, so a user with zero live matches can
  never encounter their own row in that scan. `UNIQUE(match_id, seat)` /
  `UNIQUE(match_id, user_id)` are the backstop.

## Matchmaking (`play_bot` / `find_opponent` / `cancel_queue`)

- **`play_bot`** — instant vs-bot. If the caller already has a live
  **waiting** match (they queued via `find_opponent` and are still waiting),
  *converts* it — fills seat 1 with a bot, flips to active — instead of
  erroring "already have an open match." A live **active** match is just
  returned as-is. Otherwise creates a fresh 2-seat match (human seat 0, bot
  seat 1) and activates it immediately.
- **`find_opponent`** — public queue + bot fallback. Short-circuits to the
  caller's existing live match if any (idempotent on double-click/second
  tab); otherwise joins the oldest `status='waiting'` match via
  `SKIP LOCKED`, or creates a new one with `queue_expires_at = now() + 18s`
  if none exists. The self-healing sweep (below) fills that seat with a bot
  once the timer passes, if no human ever joins.
- **`cancel_queue`** — only while the caller's match is still `waiting`;
  marks it `cancelled`.
- `activateMatch()` randomizes who moves first (`current_seat`) rather than
  mirroring the board — **fairness comes from randomizing the first mover**,
  not from a symmetric board, which would look artificial and invite
  degenerate mirror play.

## Bot heuristic (`chooseColor()`)

Single-ply greedy argmax — matching this repo's house style for every bot
here (Poker's `applyBotMove`; the preview bots' `agpSnakeChooseDir`/
`agpTetrisPlan`). Nothing in this codebase does multi-ply search, and Filler
doesn't either. For each of the (at most 5) legal colors: clone the board,
simulate the absorb, score:

```
score = tilesGained
      + 0.25 × frontierGrowth        (skipped once neutral tiles < 15% of board — "endgame")
      − 0.35 × deniedOpponentGain    (what the OPPONENT would have gained from this same color,
                                       now forbidden to them since it becomes the bot's color)
      + jitter (±0.3 tiles, uniform) (variety, mirrors poker's per-seat randomness)
```

argmax, ties broken by whichever was evaluated first. ~10 flood-fills of 567
cells per decision — still microseconds. This same function serves the real bot
**and** the timeout auto-play (an idle human's turn is substituted with the
identical heuristic — see below), so "what does a reasonable move look like"
is defined in exactly one place.

Poker's **inline bot-turn mechanism** applies directly: after a human's move
(or match activation), if the new current seat is a bot, `advanceAfterMove()`
computes and applies its move **in the same request**, bounded
(`FILLER_INLINE_BOT_MAX = 20`, though in practice this never loops more than
once since a match never has two bot seats) — a human never waits on a
cron/poll for a bot's reply.

## Self-healing sweep + cron backstop

`sweepGlobal()` scans **globally** (any user's action heals *other* users'
stuck matches too, not just their own), bounded to `FILLER_SWEEP_LIMIT` (5)
distinct matches per call:

It runs on `state` and the two matchmaking actions, but **deliberately not on
`pick_color`/`resign`** (2026-08-04). Bounded-but-cheap is still up to 5 stale
matches × `FILLER_CATCHUP_MAX` (6) plies of *somebody else's* game replayed
inline, and on the move path that latency lands squarely between a player's
click and their own board updating. Coverage is unaffected: every mounted
client polls `state` every ~2s, so the sweep still runs constantly whenever
anyone has Filler open, and the cron below covers the case where nobody does.

1. **Bot fallback** — `waiting AND queue_expires_at <= now()` → fill seat 1
   with a bot, go active.
2. **Turn-timeout auto-play** — `active AND turn_deadline + 1.5s grace <=
   now()` → `chooseColor()` plays the overdue seat's turn (human or bot,
   doesn't matter which), catching up to `FILLER_CATCHUP_MAX` (6) plies per
   stale match per call — since the surviving player's client polls every
   ~2s, an abandoned match resolves within seconds/low tens-of-seconds of
   wall-clock, not "one move per poll ⇒ minutes."
3. **Abandon rule** — if the overdue seat is human, `opponent_kind === 'bot'`
   (a solo practice match — nobody real is waiting on the result), and it has
   ≥3 consecutive `timeouts` → cancel the match, no score for anyone, rather
   than grinding a phantom match forever. In a genuine **PvP** match, this
   never fires — auto-play instead runs the game out to a real conclusion for
   the present player, since someone real IS waiting on the result. No
   explicit forfeit/leave action is needed for the common case.

⚠️ **A minimal `pg_cron` backstop exists too** (`filler_sweep_abandoned`,
every 10 minutes, calling `filler_cron_abandon_stale()`), even though the
on-read sweep is global and self-triggering — because "one open match per
user" means a truly-forgotten match (both players closed their tab and
**nobody** ever calls `filler-action` again, so the on-read sweep never
fires) costs two *specific* players their ability to play at all, and that
shouldn't depend on some unrelated player happening to open Filler first.
This cron is deliberately **dumber** than the on-read sweep — it's a plain
SQL function that force-cancels anything stale by 30+ minutes (far longer
than any real turn/queue timeout), rather than an HTTP call out to the Edge
Function — avoiding the need for project-ref/secret app settings or loosening
`verify_jwt`. Anything with real traffic is healed by the on-read sweep long
before this ever runs.

## Anti-farming scoring (PvP only)

**Bot matches never write an `arcade_scores` row, win or lose.** This is the
actual fix for a real hole, not a stylistic choice: `filler-action` bypasses
`record_arcade_score` (and therefore its 5-second-per-user-per-game throttle)
on purpose, because it's already authoritative for the whole match — but
`arcade_leaderboard` (`arcade.sql`) keeps only the **best score ever** per
user. If a free, risk-free, unlimited-attempts bot win scored anything at
all, a script could grind `play_bot` in a loop forever until it rolled high.
Scaling the bot-mode score down doesn't close this (only the best-ever row
matters); only excluding bot matches from scoring entirely does.

A resignation (`resign`) also gets no score row **for the resigner** — only
the opponent scores a normal win — closing a "resign instantly, farm cheap
low-effort attempts" angle a scored loss-on-resign would otherwise open.

Extra guards on the PvP scoring path (`scoreOnePlayer`):
- `totalMoveNo < FILLER_SCORE_MIN_MOVES` (6) → no score at all (an
  implausibly short match is no exploit surface either way, but skipping it
  keeps the leaderboard meaningful).
- A per-user 20s cooldown before the next `arcade_scores` insert, mirroring
  `record_arcade_score`'s own spirit even though that RPC isn't called.
- The insert is wrapped in a **savepoint**, so a failure there (a bad grant,
  a deleted profile, anything) can **never roll back the match-finish
  transaction** — combined with the one-open-match constraint, a fatal
  scoring failure would otherwise permanently lock both players out on
  every retry. Losing a leaderboard row is recoverable; a bricked match is
  not.
- `client_meta` records the **opponent's `user_id`** (not just nick — nicks
  aren't a stable audit key), so two-account collusion (queue with a second
  account, always throw the match) is at least greppable by an admin later.
  This residual risk is accepted as proportionate to a small office
  community, not actively prevented.

### Score formula

```
base  = round(120 × territoryShare)                                   // 0..120
win   = won ? 80 : 0
dom   = won ? round(60 × clamp01((territoryShare − 0.5) × 2)) : 0      // decisiveness, 0..60
eff   = won ? round(40 × clamp01((33 − movesMade) / 33)) : 0           // speed bonus, 0..40 (33 = FILLER_MOVES_PAR)
score = clamp(round(base + win + dom + eff), 0, 350)
```

Calibrated against `scripts/filler-balance.mjs`'s 2000-match bot-vs-bot
simulation at the current board size: a typical loss scores ≈ 29-58 pts, a
typical win ≈ 146-153 pts (median-to-p90). The 350 cap is a hard ceiling for a
maximally lopsided finish (near-total territory, minimal moves), not
something ordinary play reaches — a match always ends the **instant**
majority is crossed (~50-55% territory share in practice, per the same
simulation), so `dom` stays small in nearly every real game; only an
unusually decisive `partitioned`/`move_cap` finish pushes it higher. Every
finished PvP match scores *something* (loss included), so the leaderboard
rewards playing, but only human opponents ever reach it at all.

## Frontend (`games/filler.js`)

Rendering-only for the rules — it paints whatever board the server returns
and never decides an outcome (the one local flood-fill, `fillerPreviewPick`,
is the non-authoritative optimistic preview described at the top). Keeps the
last-rendered `cells`/`owners` strings plus the merge sizes, and repaints only
the tiles that actually changed (`fillerRenderBoard`) rather than rebuilding
the 567-tile DOM on every poll. Tiles are `div`s, not canvas — the game
updates a handful of times a minute (turn-based, not a frame loop), so a full
CSS repaint is cheap and canvas buys nothing here.

**Tiles are absolutely positioned in percentages, not a CSS grid**: a grid
cannot express the diamond lattice's half-offset, half-overlapping rows (see
"Board geometry"), and percentages stay responsive with no resize handler. The
board's zigzag left/right edges are cropped by `overflow: hidden`, exactly as
the original's frame cuts its edge rhombi in half. Each tile is clipped to a
diamond and split hard along its long diagonal into a lit upper-left face and
a shaded lower-right one — the chunky two-tone gem of the original, not a soft
gradient. Territory is expressed by shading unclaimed tiles rather than
ringing claimed ones, since the two seats can never share a color (below) —
the only real ambiguity is a neutral tile that happens to match your own
color.

**Merged gems.** A diamond-shaped group of four rhombi sharing both color and
owner is drawn as ONE rhombus of twice the size, and four of *those* as one of
four times the size (`FILLER_MERGE_SIZES`, `fillerComputeSpans`). Purely
cosmetic — the server's board is always `w*h` single tiles — and it is an
exact retiling rather than an approximation, because four unit rhombi meeting
at a lattice vertex occupy precisely the area of one double-size rhombus
centred on that vertex. That is also why **no alignment rule is needed**: any
such group retiles cleanly, so whatever the greedy largest-first pass leaves
behind still tiles as unit rhombi. It matters because a grown territory is
uniformly one color *by definition*, so without merging a large holding reads
as a wall of identical specks; with it, territory visibly consolidates into
big gems as you take the board.

Two entry points: **"▶ Zagraj z botem"** (instant, `play_bot`, smaller/faster
board) and **"🔎 Znajdź przeciwnika"** (queue, `find_opponent`, with a
**"✕ Anuluj szukanie"** escape hatch while waiting). Once active, 7 palette
buttons let the player pick a color — 2 are visually disabled and framed (own
color in green, opponent's in dark) via the server-returned `legalColors`
list, never computed client-side. The **"🏳️ Poddaj się"** (resign) button
sits in the status bar at the top of the panel, **not** in `.filler-actions`
with the two start buttons: it is a mid-match control (those two only show
when idle), and a concede button in the row a player clicks to start a game is
where a misclick hurts most. The rules are three chips under the title rather
than the intro paragraph the panel shipped with.
**Deliberately does NOT call `payArcadeEntry()`/`recordArcadeScore()`** —
those RPCs are intentionally bypassed (see the scoring section above);
calling them would just fail (`'filler'` isn't in either's allowlist).

Realtime is a pure **doorbell**, matching every other shared-state game
here (`sb.channel('filler-match-' + matchId)` on `filler_matches`/
`filler_match_players`) — the payload is never trusted, every notification
just triggers a re-fetch via the `state` action. **Filtered by match id**
(`filter: 'id=eq.' + matchId`), unlike Poker/Wheel's table-wide subscriptions
— since Filler can have many concurrent matches, an unfiltered subscription
would push every match's full board to every connected client on every move,
whereas Poker/Wheel each only ever have one live table/round. A 2s poll runs
alongside realtime as a fallback (mirrors Wheel's poll-driven
`resolveDueRound`).

No explicit "leave match" call is needed on tab-exit
(`stopFillerRound()` just tears down local polling/realtime) — the
self-healing sweep above handles an abandoned match on its own, whether the
tab closed cleanly or not.

## Preview (`games/previews.js` — `AGP_DEFS.filler`)

A small, **fully self-contained** cosmetic demo (`dep: null`, a smaller 13×15
board — 13.5 × 8 rendered, per the lattice's half-height rows — 5 colors, its
own tiny flood-fill + a plain greedy-only chooser) — deliberately NOT sharing
any code with `games/filler.js` or `supabase/functions/filler-action`,
matching every other preview's "cosmetic-only, never calls the real game
logic" convention. Since Filler is server-authoritative with no client-side
simulation to reuse, there would be nothing to share even if the house style
allowed it. It does mirror the lattice's adjacency *rule* and rhombus look
(not as a parity contract) — a storefront demo filling through tiles that
visibly don't touch would advertise the wrong game. No merge pass: it is
cosmetic-only and never renders a grown territory for long.

## Phase 2 — seasonal promotion (deployed and armed, scheduled for no week)

⚠️ **Filler is NOT currently on the calendar.** Everything below shipped and is
live in the database — tables, views, `award_filler_week()`, the season-gated
`filler_weekly_awards` cron job, the rotation entry, the league ranking — but
on **2026-08-05** the 2026-08-10 slot it had been given was reassigned to
„Kulki G6". The reason is not a defect in any of this: Filler is the only PvP
game in the rotation, so a Filler week only works if two willing players are
online at the same time, and the four weeks from 2026-08-10 were planned in
advance precisely because nobody would be steering them day to day. The cron
job stays armed, so scheduling a Filler week later is a one-line
`SEASONAL_OVERRIDES` entry in `index.html` plus the matching `WHEN` clause in
`seasonal_game_for_week()` — nothing here needs rebuilding.

Well-precedented shape, verbatim template `supabase/healer-dungeon.sql`:

- `supabase/filler-seasonal.sql` — `filler_scores` (one row per scored PvP
  match — `finishMatch` already produces exactly one score per human per
  match, so this is directly analogous to every other seasonal game's
  best-single-run-per-week model) + `filler_weekly_awards`, a
  `filler_week_start()` helper, the three views (`_current_week`/`_all_time`/
  `_recent_awards`), `award_filler_week()` (🥇1000/🥈500/🥉200), realtime
  publication, a Warsaw-midnight-Sunday-gated `pg_cron` job.
- `filler-action`'s `finishScoring`/`scoreOnePlayer` gain one branch: when the
  match's `arcade_mode` is false (launched from the seasonal tab, not the
  arcade picker — mirrors Healer Dungeon's `archiveMode` flag, decided once
  at match creation from the action context and never trusted from the
  request body afterward), also insert into `filler_scores` with a computed
  `week_start`. No other Edge Function change — the whole match-finish
  machinery is already in place.
- `index.html`: append `filler` to `SEASONAL_ROTATION`; add
  `SEASONAL_OVERRIDES['2026-08-10']`; move the Bug Jumper relaunch override
  to `'2026-08-17'`; the standard `loadSeasonalTab()` 6-line insertion
  pattern; a weekly-board UI block.
- `supabase/season-award-gating.sql`: the matching `WHEN` clause moves,
  `'filler'` appended to the rotation array, modulus 11→12, a
  `cron.schedule('filler_weekly_awards', ...)` block.

### The weekly ranking is a LEAGUE (resolved 2026-08-04)

The open question was whether the week ranks best-single-match-score (free,
consistent with every other game) or something more PvP-flavoured. It ranks
**accumulated league points**, because best-single-match is actively wrong
here: Filler is the only PvP game in the rotation, and "your best match wins
the week" means one lucky win ends your week — there is no reason to ever
play a second opponent, which is the entire behaviour this game exists to
create.

`public.filler_league_week(week_start)` in `supabase/filler-seasonal.sql` is
the **one** definition — the current-week view, the all-time view and the
Monday payout all call it, so what players watch during the week cannot
drift from what actually pays out.

```
per match : (win ? 100 : 35) + round(match_score / 10)        -- 0..35 bonus
× decay   : Nth match against the SAME opponent this week
            1st 100% · 2nd 70% · 3rd 45% · 4th 25% · 5th 15% · 6th+ 10%
+ bonus   : 60 × distinct opponents faced
```

Why each piece:

- **Losses score.** Load-bearing, not generosity: if losing were worth
  nothing, the correct play is to duck the strong colleagues, and the people
  most worth playing get no games. A win is still worth ~3× a loss, so
  ducking never pays.
- **Repeat-opponent decay + distinct-opponent bonus** are the same mechanism
  seen from two sides, and they are what make the ranking mean "played the
  office" instead of "played one friend a lot". They double as the
  anti-collusion device: a two-account pair cannot manufacture distinct
  opponents, and their 5th rematch is worth 10%.
- It composes with guards already in `filler-action` — a resigner scores
  nothing, matches under `FILLER_SCORE_MIN_MOVES` plies score nothing, and a
  20s per-user cooldown sits in front of every insert — so feeding wins by
  instant-resigning is both rate-limited and decayed into irrelevance.

Modelled against the balance harness's typical match scores (win ≈ 150,
loss ≈ 45):

| week | points |
|---|---|
| 5 matches vs 5 different people, 3W2L | **725** |
| 8 matches vs 4 people (2 each), 4W4L | **812** |
| 20 matches vs ONE person, all wins | 526 |
| 10 matches vs ONE person, 6W4L | 332 |
| 5 matches vs 5 people, ALL losses | 500 |
| 1 match, won | 175 |

A new opponent is always worth +175 (win) where a 3rd rematch is worth +29,
and five varied matches beat twenty against a single partner. Note the last
two rows: showing up and losing to five people beats a dominant run against
one, which is the intended signal. Once you have played everyone, breadth is
capped for all and wins decide the week — breadth gets you into the race,
skill wins it.

Two supporting changes, since a league nobody can find opponents for is
still a dead week:

- `filler_scores.opponent_id` is a real indexed column (not
  `client_meta->>'opp'`), because the decay and the distinct count group on
  it. `ON DELETE SET NULL`, and `filler_league_week` falls back to the
  `match_id` as the grouping key so a NULL behaves like a one-off opponent
  rather than merging every such match into one bucket.
- **`FILLER_QUEUE_SEASONAL_MS` (150s)** replaces the 18s bot fallback in
  seasonal mode — there a bot match is worth literally nothing, so dumping a
  player into one after 18s is a wasted trip rather than a convenience — and
  `state` now returns a `waiting[]` list of nicks currently queued, which the
  panel surfaces as a „🔎 X czeka na przeciwnika — Dołącz" nudge. The biggest
  obstacle to a PvP week is not unwillingness, it is two people missing each
  other by a minute all week.

The frontend does **no** ranking math: `games/filler.js` reads the ranked
rows straight off `filler_current_week`, and the seasonal „na żywo" podium
does the same via `SEASON_LIVE_VIEW_SOURCES` (which replaced a hardcoded
`isBugJumper` branch — Bug Jumper's top-5 average and Filler's league are
both pre-aggregated rankings that cannot be derived by ordering the raw
scores table).
