# Office Grand Prix V2 release gate

V2 remains intentionally hidden in production until every manual row below is
signed off. The completed V1 test session and its score rows are audit history;
do not delete or promote them.

## Automated gate

- [x] `node scripts/office-grand-prix-parity.mjs`
  - golden steering, neutral heading, off-road, reset, grid, checkpoint,
    item, finish, DNF, cosmetics, scoring, interpolation, and track-hash cases
  - 5,000 seeded races / 40,000 kart replays
  - zero browser/server mismatches
  - clean lap between 55 and 65 seconds
- [x] Classic inline JavaScript parses.
- [x] The Edge Function bundles as ESM with its npm imports external.
- [x] `git diff --check` passes.

## Manual gate

- [ ] At 30, 60, and 120 Hz there are no fixed-tick plateaus, camera shakes,
  sideways karts, road bands, triangle wireframes, seam flicker, or remote snaps.
- [ ] Left/right are correct on straights and bends; releasing input centers the
  wheels without aligning the kart; an unattended kart leaves the road.
- [ ] Eight unique grid poses, all items, shields, resets, checkpoint order, and
  the 90-second DNF are visible and correct.
- [ ] Two authenticated players (desktop and mobile) race with six bots.
- [ ] Reconnect, coordinator failover, stale engine/track/session rejection,
  idempotent retry, official replay, and leaderboard updates pass.
- [ ] Portrait, landscape, pointer cancellation, blur, and fullscreen pass.
- [ ] Representative mid-tier mobile p95 frame time is below 33 ms.
- [ ] One production smoke race completes without score or coin anomalies.

## Monday activation

Only after the manual gate passes, and only on a Monday boundary:

1. Set `OGP_PUBLIC_UI_ENABLED = true` in `index.html`.
2. Set `OGP_SESSIONS_ENABLED = true` in
   `supabase/functions/office-grand-prix-action/index.ts`.
3. Replace the first gated `popup_panic` entry with `office_grand_prix` in
   `supabase/season-award-gating.sql`, then re-run that SQL and
   `supabase/polish-midnight-schedules.sql`.
4. Deploy the Edge Function, publish the client, and run the production smoke
   race. If any smoke check fails, restore both gates to `false`.
