# NFL live board, server-side Monte Carlo simulator, and trading signals

One small Node server (no dependencies) serves three things:

- `/` is the board: every game this week with score, down and distance, a field strip and win probability, plus the
  running record of every bet the trading menu has flagged.
- `/game?event=ID` is the simulator for one game. It draws what the server sends; nothing simulates in the browser.
- The server itself, which runs one shared simulation per game, only while someone is watching.

## How the shared simulation works

Each game has one simulator on the server. A game wakes up when the first viewer opens its page (an open event stream
counts as watching, and a hidden tab disconnects after 30 seconds). While anyone is watching, the server checks ESPN every
8 seconds and, whenever the game state changes, runs 25,000 simulations once and pushes the same result to every viewer.
Ten viewers cost the same as one. When the last viewer leaves, polling and simulating stop after 30 seconds, and the
game's history stays in memory for six hours so the next viewer gets the full chart. Plays that happened while nobody
was watching are filled into the chart later at lower priority.

Work is split into chunks on a worker-thread pool with a priority queue: the live play first, then 4th-down options,
then manual and what-if runs, then chart backfill, then backtests. A run whose game state has moved on is cancelled.
Manual and what-if runs are rate limited per visitor and cached, and finished-game backtests are simulated once and kept.

## The model

`scripts/train.py` builds `sim/data.json` from nflverse play-by-play, every season available (1999 through the current
season, about 890,000 scrimmage plays from 7,300 games). Recent seasons count more (five-season half-life), so old
seasons fill in rare situations while the call mix looks like today's league. Kickoffs use the current kickoff era only,
field goals a logistic fit on the last eight seasons, punts are bucketed by field position, and turnovers place the
ball where the other team really took over. The engine (`sim/engine.mjs`) plays NFL rules: 2025 overtime (both teams
possess unless the defense scores on the first possession, ties in the regular season, playoff periods until a winner),
the two-minute warning, onside kicks when trailing late, and timeouts used by both sides late in halves.

`scripts/calibrate.mjs` fits how a spread and total become engine settings, so kickoff sims average the line and total and
final margins scatter about 13 points around the spread, as real games since 2010 do. Simulated games reach overtime about
6% of the time and end tied about 0.35%, close to the real rates.

## Trading signals and the record

For every Kalshi and Polymarket contract on a game (winner, spread ladder, total ladder) the server computes the edge:
the model's probability minus the cost to buy, which is the ask plus about 1 cent of fees. A contract is flagged when the
edge reaches 5 points and its cost is between 10 and 90 cents. The first flag on each market type in each game goes into
the ledger, is graded when the game ends (a slow background check settles games that ended with nobody watching), and
feeds the record on the home page: won-lost, current streak, longest winning run, units at one unit per bet, and hit rate
next to what the model expected.

The 5-point bar comes from `scripts/trading_study.mjs`. It replayed 12,641 snaps from 903 games (2023 through 2026) with
play tables trained only on seasons through 2022, and priced each bet off nflfastR's spread-adjusted win probability,
because historical in-game exchange prices aren't public. The threshold was picked on 2023-24 only (the one whose
5th-percentile bootstrap return was best) and then checked on 2025-26:

| Seasons | Bets | Won | Avg. cost | Return on money staked | 90% range |
|---|---|---|---|---|---|
| 2023-24 (used to pick) | 217 | 61% | 55 cents | +11.6% | +1% to +21% |
| 2025-26 (held out) | 126 | 59% | 53 cents | +10.3% | -4% to +24% |

Treat that as a ceiling. Real exchanges are likely sharper than the stand-in price, the held-out range still includes
losing money, and only watched games can produce signals. The live record is the real test.

Regenerate everything with:

```
python scripts/train.py /path/to/pbp sim/data.json          # nflverse play_by_play_YYYY.parquet files
node scripts/calibrate.mjs
MAX_SEASON=2022 python scripts/train.py /path/to/pbp /tmp/oos.json   # out-of-sample tables for the study
python scripts/trading_snaps.py /path/to/pbp 2021
node scripts/trading_study.mjs run /tmp/oos.json 2023 && node scripts/trading_study.mjs fit
```

## Deploy on Render

Push to GitHub, then New > Blueprint. `render.yaml` sets up a Starter web service with a 1 GB disk at `/var/data` for the
ledger. Without a disk the record resets on every deploy. The free plan works for a quiet game, but it has a fraction of
a CPU, and a Sunday slate with several watched games will lag. `SIM_THREADS` sets worker threads (default: cores minus one,
max 4), `SIM_N` the sims per play (25,000).

Run locally with `npm start` and open http://localhost:3000.

## Files

```
server.mjs          static files, ESPN proxy, event streams, sim and ledger endpoints
api/espn.mjs        ESPN, Kalshi and Polymarket proxy, memoized
sim/engine.mjs      the NFL play engine          sim/pool.mjs, worker.mjs   worker-thread pool
sim/live.mjs        per-game shared simulator    sim/trading.mjs            signals, ledger, settlement
sim/data.json       trained tables               sim/trading.json           study results and threshold
public/             index.html (board + record), game.html (simulator + trading menu)
scripts/            train.py, calibrate.mjs, trading_snaps.py, trading_study.mjs
```
