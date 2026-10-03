# College football live board + Monte Carlo simulator

Two pages served by one small Node server, built for Render.

- `/` is the board. Every game this week, Top 25 by default or all FBS, with score, clock, down and distance, a field strip
  showing the line of scrimmage and the line to gain, ESPN's win probability and the betting line. It refreshes every
  30 seconds and runs no simulations, so it's cheap to leave open.
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

`/.netlify/functions/espn` still answers as an alias, so old bookmarks and cached pages keep working.

## Notes

- Polling is every 30 seconds (`LIVE.every` in game.html). ESPN's situation only carries the most recent play, so when two
  plays happen inside one 30-second window, the play log and model check see only the second. Drop `every` to 5000 if
  that matters more than request volume.
- The Top 25 filter uses ESPN's poll rank. Weeks with no ranked games fall back to all FBS games.
- Model, data sources and known limits are unchanged from v1.
