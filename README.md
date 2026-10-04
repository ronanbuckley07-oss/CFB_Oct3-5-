# College football + NFL live board and Monte Carlo simulator

Two pages served by one small Node server, built for Render.

- `/` is the board. Every game this week, Top 25 by default or all FBS, with score, clock, down and distance, a field strip
  showing the line of scrimmage and the line to gain, ESPN's win probability and the betting line. It refreshes every
  30 seconds and runs no simulations, so it's cheap to leave open.
- `/nfl` and `/nfl/game?event=ID` are the same two pages for the NFL, with their own model tables.
- `/game?event=ID` (or `/game/ID`) is the simulator. It opens on a start screen with the matchup, the current situation and
  a choice of which team's win probability to show. Nothing simulates until you tap Go live. After that it pulls the game
  from ESPN every 30 seconds and re-runs 25,000 sims whenever the state changes.

## Files

```
server.mjs        static files (brotli/gzip, cached in memory) + /api/espn + /healthz. No dependencies.
api/espn.mjs      ESPN proxy. Every ESPN call is memoized for a few seconds, so many viewers cost one upstream request.
public/index.html the board
public/game.html  the simulator (engine and model tables are inline, ~1 MB raw, ~160 KB compressed)
render.yaml       Render blueprint
```

## Live sims run on the server

When someone presses Go live, their page opens a Server-Sent Events connection to `/api/live`. The server keeps one
tracker per game (per orientation: a viewer showing the other team's win probability gets a second stream). While at
least one person is connected, that tracker checks ESPN every second; after every play (new down, distance, spot,
possession, score or play text, or 30 seconds of clock, 5 inside the last two minutes of a half) it runs the sims once (3,000 for a quick read, then 25,000, plus 8,000 per option on 4th down) and pushes the
same result to everyone watching. It also fills in the model line for plays nobody was around for, at low priority.

Nobody connected: no polling and no sims. A tab left in the background for a minute disconnects itself, and a game with
no viewers stops after a minute and is forgotten after 20. `/api/live/status` shows what's running.

All games share one pool of simulation threads (`SIM_THREADS`, set in render.yaml), and the current play always goes
ahead of backfill. Compute grows with the number of games being watched, not the number of viewers. On the Starter
plan (half a CPU) a play takes a couple of seconds to simulate; if many games are watched at once on a busy Saturday,
results queue up and a bigger instance with more threads is the fix. Manual entry, the Run button, What if and the
backtest still simulate in the browser, since those are one person's questions. If the live server can't be reached,
the page falls back to simulating in the browser on its own.

The server reads the engine, the model tables and each league's settings straight out of `public/game.html` and
`public/nfl/game.html`, so the browser and server can't drift apart.

## Model bets

`api/picks.mjs` logs paper bets to `$DATA_DIR/picks.json` and grades them at the final.
- Game bets: one per game, every game with a Kalshi or Polymarket market, watched or not. A background scanner reads
  every live game (3,000 sims at most every 2 minutes, lowest priority) and, once a game is between Q3 7:30 and Q4 8:00,
  runs 25,000 sims and logs the biggest gap that clears the bar (5 points on a moneyline, 6 on a spread or total, gaps
  over 20 skipped as stale). No qualifying gap, or no market, counts as a pass.
- The window comes from `tools/timing_nfl.mjs`: replaying 2023-25 NFL snaps against Vegas win probability, the model's
  disagreements were best calibrated and most profitable there (269 bets, 57.5% hit vs 58.2% predicted, +9%). Not
  conclusive; the "When our bets hit" table on the home page tracks whether live results agree.
- Bets taken while someone watches a game are logged too, up to 4 per game, and count in the overall record.
- `/api/picks?league=` returns the record and every bet; `/api/picks/leading?league=` the live gaps behind the
  "Leading bets right now" panel. Each logged bet stores the state and numbers behind it, which the game page turns into
  the "Why the model likes this" explanation.

## NFL model

`public/nfl/game.html` is generated, not edited by hand. After changing `public/game.html`, run
`python3 tools/build_nfl.py`, which copies the app and swaps in the NFL tables (`tools/nfl_data.json`) and settings.

The NFL tables come from nflverse / nflfastR play-by-play, every season from 1999 through 2026 week 4
(1.29M plays; 899,843 runs and passes from 7,322 games). Using all of it as-is would teach 2026 teams to throw
interceptions like 2001 teams (INT rate fell from 2.9% to 1.9%), so older seasons count, but less:
- play results: all seasons, sampled with a 6-season half-life
- play calling: 2006 on with a 3-season half-life, because 4th-down go rates jumped from ~40% to ~75% after 2018
- clock: 2018 on; field goals: 2010 on (5-season half-life); punts and 2-pt rate: 2015 on; extra points: 2023 on
- kickoffs: 2025 on, after the touchback moved to the 35
NFL rules in the engine: two-minute warning, 10-minute overtime where both teams get the ball and then the next
score wins, ties, tied teams playing for a last-second field goal. The clock is scaled so simulated games average
the real 134 snaps, and the spread/total mapping is refit (`tools/calibrate_nfl.mjs`).

Holdout check on 2025 regular-season games (1,785 snaps, 272 games, 800 sims each), against nflfastR's own
Vegas-adjusted win probability: Brier 0.1575 vs 0.1576, log loss 0.4752 vs 0.4750. 2025 plays are also in the
resampling pools, so treat that as a sanity check, not a clean out-of-sample win.

To rebuild from scratch: `tools/load_nflverse.py` (downloads are in the script's comments), then
`tools/build_nfl_data.py`, then refit the clock scale and `cal` with `tools/calibrate_nfl.mjs`.

## Deploy on Render

1. Push this folder to a GitHub repo.
2. In Render: New > Blueprint, pick the repo. `render.yaml` sets up a Node web service with `node server.mjs`
   and a health check on `/healthz`. (Or New > Web Service with build command `npm install` and start command `npm start`.)
3. That's it. Render sets `PORT`; the server reads it.

The free plan sleeps after 15 minutes without traffic, and the first request after that takes 30 to 60 seconds to wake it.
For game days, the cheapest paid instance stays awake.

Run locally with `npm start` and open http://localhost:3000.

## API

`/api/espn` keeps every kind the old Netlify function had (`summary`, `find`, `team`, `list`, and the default
`?event=&date=` scoreboard entry) and adds two:

- `?kind=scoreboard&scope=top|fbs[&date=YYYYMMDD]`: trimmed games for the board
- `?kind=card&event=ID[&date=YYYYMMDD]`: one game in the same shape, for the start screen
- `?kind=box&event=ID`: box score (line score, team stats, player stat lines)
- `?kind=markets&event=ID[&kalshi=TICKER][&poly=SLUG]`: Kalshi (series KXNCAAFGAME) and Polymarket win prices for both teams.
  Add `&debug` to see every market title the server checked, which is how to diagnose a game that didn't match.
- `?kind=team&id=TEAMID` now also returns played games with results and ESPN's FPI win chance for each remaining game

`/.netlify/functions/espn` still answers as an alias, so old bookmarks and cached pages keep working.

## Notes

- Live games are checked every second (`POLL_MS` in api/live.mjs; `LIVE.every` for the browser fallback).
- Finished games leave the home board 6 hours after they end. ESPN's win-probability line and market prices
  refresh every 15 seconds and the box score every 30 (6 while its tab is open). The server caches each ESPN response
  for 2 to 3 seconds, so viewers share requests.
- Sims run in 1,500-sim chunks across up to 8 threads. When a new play arrives mid-run, the old run stops handing out
  chunks, so the update starts within a fraction of a second instead of waiting for 25,000 stale sims.
- The Top 25 filter uses ESPN's poll rank. Weeks with no ranked games fall back to all FBS games.
- Model, data sources and known limits are unchanged from v1.
