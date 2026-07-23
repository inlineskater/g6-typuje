# Office Grand Prix release gate (history)

V1 and V2 are historical. **V3** (2026-07-23) is the live engine: it replaced
V2's tight-inner-loop track (whose constant-offset road/curb geometry
self-intersected — the "weird inner corners" bug) with a straights +
true-radius-corners circuit, added a `moveHeading`-chases-`heading` drift
model (steer-only input, no drift button), raised speed/turn responsiveness,
and replaced the live lobby/coordinator/broadcast multiplayer with **async
ghosts**: every race is its own solo server session (player + 7 bots,
started instantly, no waiting), and up to 7 other players' most recently
recorded laps are replayed locally as extra visual karts. Ghosts never touch
the authoritative roster or scoring — the server always fills non-player
slots with the bot AI, so a ghost can never affect the caller's official
result. This removed the entire class of risk the V2 manual gate below was
tracking (coordinator failover, reconnect, stale peer state); those rows no
longer apply and are kept only as historical context.

Completed V1/V2 test sessions and their score rows are audit history; do not
delete or promote them.

## V3 automated gate

- [x] `node scripts/office-grand-prix-parity.mjs`
  - golden steering/drift, neutral-heading, off-road, reset, grid, checkpoint,
    item, finish, DNF, cosmetics, scoring, interpolation, and track-hash cases
  - 5,000 seeded races / 40,000 kart replays, zero browser/server mismatches
  - clean lap in the 25-55s band (drift physics is meaningfully faster)
- [x] New track control points verified offline: minimum curvature radius
  ~24 world units against a 7.6 curb half-width (3x+ margin), plus a direct
  offset-polyline self-intersection check at width up to 9 — see the track
  design notes in `index.html`'s `ogpBuildScene`.
- [x] Classic inline JavaScript parses; edge function is valid TypeScript.

## V3 manual gate (recommended before/soon after the 2026-07-27 feature week)

- [ ] At 30/60/120 Hz there are no fixed-tick plateaus or camera shakes; no
  road/curb visual artifacts anywhere around the new circuit.
- [ ] Left/right steer correctly; releasing input centers the wheel without
  aligning the kart; sustained hard steering shows a visible, bounded drift
  that eases back out; an unattended kart leaves the road.
- [ ] Starting a race is instant (no lobby wait); ghosts (when any exist for
  the current track version) appear as extra karts and race believably; empty
  ghost slots are filled by bots; finishing submits and the weekly leaderboard
  updates.
- [ ] Portrait, landscape, pointer cancellation, blur, and fullscreen pass.
- [ ] Mobile frame time stays reasonable on a mid-tier device.

## Historical: V2 manual gate (superseded, kept for context)

- [ ] Two authenticated players race live with six bots via the coordinator.
- [ ] Reconnect, coordinator failover, stale engine/track/session rejection.

These rows described the live-multiplayer surface V3 removed; they will
never be checked off and should not block anything going forward.
