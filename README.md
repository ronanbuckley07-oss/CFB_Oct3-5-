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
- Every other bet found is logged too, in every live game whether or not anyone is watching: each distinct contract once
  per game, the first time it qualifies at an order-book-checked price. These count in the overall record; ladder rungs
  of the same opinion now all count, so that record is less independent than its bet count suggests. Game bets and
  steady picks keep their own records.
- `/api/picks?league=` returns the record and every bet; `/api/picks/leading?league=` the live gaps behind the
  "Leading bets right now" panel. Each logged bet stores the state and numbers behind it, which the game page turns into
  the "Why the model likes this" explanation.

## Accuracy study (October 2026)

Built NFL tables from 1999-2024 only (`MAXS=2024 tools/build_nfl_data.py`), ran the model on every 6th play of 2024
and 2025 (`tools/backtest_raw.mjs`, 5,442 and 5,353 snaps, 600 sims each), and scored win, cover and over
probabilities against outcomes and nflfastR's Vegas win probability.
- Out of sample on 2025 the raw model matched Vegas: Brier 0.15829 vs 0.15816 (Q4: 0.10967 vs 0.10977).
- Reweighting fit on 2024 made 2025 worse in every form tried (`tools/backtest_calibrate.py`: win 0.15829 to 0.16004;
  `tools/backtest_blend.py`: fitted model+Vegas blends 0.1595). How predictable a season is moves from year to year.
- Strength uncertainty 4 vs 5.5 points: within sim noise; left at 5.5.
- A plain 50/50 average of model and market beat both: 0.15785, better than Vegas in 74% of game resamples.
  That is now the "fair" probability every bet is judged on.
- Raw calibration on 2025: underdogs the model priced at 3% won 7%, at 15% won 20%. The fair price pulls those toward
  the market, and contracts under 10¢ are no longer bet.
College could not be replayed offline (no 2025 college play-by-play reachable from the build machine).

## Risk tiers

Bets are sorted by price: low risk 60¢ and up (fair edge 2.5+ points), medium 35-60¢ (3+), high risk 10-35¢ (4+).
Each game gets up to one game bet per tier between Q3 7:30 and Q4 8:00. The home page and the trading desk have a tab
per tier with its own record.

**High risk is paused** (`paused: true` in `TIERS`, `api/picks.mjs`): no new bets are logged, listed on the desk, or bought by
the autopilot. Its past record stays on the page. See the holdout test below for why.

## Holdout test (October 2026)

`tools/trading_holdout/` replays the bet rules on 343 NFL games the model never saw (tables from 1999-2024, tested on
2025 and 2026 weeks 1-4), against nflfastR's Vegas win probability as the price, plus 1 cent and the taker fee.
- With the price and the game state in sync, the tier rules almost never fire on moneylines: 4 bets in 343 games.
- With the quote one play stale (the scanner used to refresh prices every 3 minutes), they fire in about half of all
  games: 174 bets, +18% at the logged price, but -4.6% at the price an order placed then would pay. A paper record built
  on stale quotes looks profitable and isn't.
- With ESPN's feed one play behind the exchange, underdog bets hit 20% at 24-cent prices (-18%). Fit to results, the
  best weight on the model for underdog moneylines is 0% in both 2025 and 2026: the model adds nothing there.
- Spread-ladder results against a modeled market looked good but depend on that model of the market; they can't be
  trusted without real historical ladder prices.

Fixes: inside the betting window (and while a steady pick is possible) the scanner refreshes prices every 20 seconds
instead of every 3 minutes, and no bet is logged against a quote older than 45 seconds (`QUOTE_MAX_AGE_MS`). Each
pick records its quote age, and each tier's realistic record shows the average gap between the logged price and what
the Polymarket US order book really charged (`slip`).

## Steady picks

A separate section at the top of the home page, written for people who don't want the model details. One rule:
moneyline, Q2 through Q4, a team priced 65-85¢ (fees in) that already leads by 4+, and the fair price is at least what
you pay. Then **cash out at 90¢**: once that team's price reaches 90¢ the pick is sold at the bid (fees out) and listed
under "Cash out now"; the steady record counts the cash-out.

Replay (`tools/trading_holdout/strat.mjs`): 64 bets at 76¢ on average, +12.9% (90% range +3% to +21%), +13% in 2025
and +12% in 2026, 61% reached 90¢, and a third less swing per bet than holding every bet to the final. Variations that
did worse: a second or third bet per game, stop-losses, selling at the two-minute warning, a 7-point lead minimum,
only betting right after scores. The same spots without the model's agreement lost 5%. The band and cash-out were
picked on this same replay, so the real edge is probably smaller; college was not tested.

The rule failed (-4 to -6%) when the model and the price were a play apart, so a steady pick is logged only after a
play has been settled on ESPN for 40 seconds, against a quote fetched after that. One per game, own record, not
counted in the tier records. `/api/picks/steady?league=` lists what qualifies now and the open picks (with any
cash-out). The replayed bets are in `public/replay_bets.json`; "Past bets" can show them, tagged, without counting
them in any record.

## Only buyable bets

Every bet the site shows or logs is a Polymarket US or Kalshi contract checked on that venue's live order book: the
price is the average a `PAPER_STAKE` ($10) order fills at, fee included (Polymarket US 6.95%, Kalshi 7%, x p x (1-p)),
and a book too thin to fill it means no bet. Kalshi's book is read from its public `/markets/{ticker}/orderbook`
(it lists bids only; a NO bid at x is a YES offer at 1 - x). Every bet on the site carries a "How to buy" line: the exchange (linked), the game and the market exactly as that
exchange titles them, whether to buy Yes or No (and the side's label), a limit price (the worst level a $10 order
touches on the book) and what has to happen for a share to pay $1. Steady cash-outs get a matching "How to sell".

To check the Kalshi import on the live server, open `/api/nfl?kind=kalshicheck&event=ID` (or `/api/espn?...` for
college): every Kalshi contract for the game with its ticker, quote, best book prices and what $10 fills at right now.
International Polymarket stays in the market table for
comparison but is never a bet: it can't be traded from the US. The trade desk and autopilot still trade Polymarket US
only (the keys are for that exchange); Kalshi bets are paper picks you can place yourself.

Shown bets are re-checked every 10 seconds. On a new play they stay on screen tagged red "OLD · previous play" until
that play is simulated. Every price shows how long ago it was checked and turns into a red OLD tag after 30 seconds.
Logged bets show the current buy price ("Now"): green while you can still get the logged price, red OLD once the
market has moved past it or the bet is on a venue that can't be traded. With nothing qualifying, the page says
"No live bets right now". Only order-book-checked bets count toward the one-bet-per-type limit for a watched game,
so bets logged earlier on other venues no longer block new ones.

## Market-anchored strength (why a whole ladder can't light up any more)

The model knows each team's pregame strength; a live exchange also prices what it has watched. When they disagree on
who wins, every spread rung on one side looks like value at once (seen live: DET +6.5 through +9.5 all logged at Q3
6:21, model ~9 points above the market on each, then Carolina scored). For tier and small-edge bets the simulated final
margins are now shifted by however many points make the model's win probability equal the market's moneyline
(averaged across venues), and spreads are priced off the shifted distribution. A spread bet then only qualifies when
the model disagrees about the shape of the outcome (blowout vs close), not about which team is better; moneyline tier
bets effectively stop (the replay found no honest moneyline edge anyway). Steady picks keep the raw model, which the
replay validated. Tier and small-edge bets also skip any model-minus-price gap over 10 points (`MAX_GAP`): in the
replay, 95% of honest disagreements were under 6 points and 99% under 10 (`tools/trading_holdout/gaps.mjs`). The
replay also shows the model's spread probabilities themselves are calibrated (`tails.mjs`: at 90%+ it says 91.1%,
wins 90.2%), so the problem was the inputs, not the math.

Logged bets whose price fell (the bet is losing so far) show "now 40¢ · was 86¢" in neutral grey, not green, and
"Still a bet now: how to buy it" only appears when that exact contract qualifies on the current play.

## Small edges (more lines)

Bets where the model and the market agree on the side but the fair price beats what you'd pay by only 1+ point (under
the 2.5/3-point main bar), priced 35-95 cents, checked on the order book like every other bet (`LEAN` in
`api/picks.mjs`). Up to 8 per game per run. They show in their own "Small edges" list on the game page and the home
page, are logged once per contract per game with `lean: true`, and have their own record, kept out of every other
record. Untested on the replay: treat them as unproven and bet smaller.

## Bet cards (phone first)

Every bet is a card: the bet in large type, then numbered steps (open the exchange, find the game, tap the market,
buy Yes or No at this price or less), what has to happen for it to pay, what $10 buys and returns, the model's numbers
and a live "checked Xs ago". Stale cards get a red "OLD · don't buy" banner. Kalshi spread and total cards link to
that market's own event page. Logged bets are compact rows (newest first) with a "How to buy it now" card while the
logged price is still available.

Open bets logged before order-book checks (international Polymarket, or nothing to check) are voided on startup:
removed from game lists and every record; they were never buyable at their logged price.

## Update speed

- Scanner: every 10 seconds (was 30), re-simulating a game on every new play (was at most every 2 minutes). Prices for a game in the betting window, or with a steady pick possible or
  open, refresh every 10 seconds (was 3 minutes, then 20 seconds).
- Watched games: prices every 10 seconds (was 20). Game page: prices every 8 seconds, ESPN win probability every 10
  (both were 15). Home page bet sections: every 10 seconds (was 30).
- Upstream caches for live prices (Kalshi event lists, Polymarket US events): 8 seconds (were 20 and 15).
- No bet is logged against a quote older than 30 seconds (`QUOTE_MAX_AGE_MS`, was 45).

## Trading (Polymarket US)

Two layers, both built on Polymarket US, the CFTC-regulated exchange US residents can legally trade
(docs.polymarket.us). The international Polymarket blocks US trading, so the site only reads its prices.

Realistic paper record. Polymarket US is now a third venue next to Kalshi and Polymarket. Its edges use the real ask
plus the taker fee (0.0695 x p x (1 - p) per contract, schedule effective Oct 1, 2026), and game bets prefer a
Polymarket US bet when one qualifies. When a Polymarket US bet is logged, the server walks that market's order book
and records what `PAPER_STAKE` dollars (default 10) would really have bought: contracts, average price, fee. Graded at
the final, that is the "Realistic" line on the home page.

One-tap trading, private, at `/trade`.
1. Make a Polymarket US account in their app and finish identity verification.
2. At polymarket.us/developer, create an API key. The secret is shown once.
3. In Render > Environment set `TRADE_PASSWORD` (long and unique), `POLYMARKET_US_KEY_ID`, `POLYMARKET_US_SECRET_KEY`.
   Leave `TRADING_ENABLED=false` at first: the desk previews orders with Polymarket US but cannot place them.
4. When you're ready, set `TRADING_ENABLED=true`. Limits: `MAX_ORDER_USD`, `MAX_DAILY_USD`, `MAX_OPEN_BETS`,
   `MAX_SLIPPAGE_CENTS`, `MIN_FAIR_EDGE`.
Every order is previewed first and needs a confirm within 30 seconds. Orders are limit orders, immediate-or-cancel,
sized so the worst-case cost fits the per-order limit. The server re-checks every limit at placement, refuses a second
position in the same market, and has a kill switch (persisted on the disk). Trades are logged to `$DATA_DIR/trades.json`
and graded at the final. Keys never leave the server and are never sent to the browser.

## Autopilot

On `/trade`, type instructions ("spend up to $100 on NFL games today, low risk, max $10 a bet, stop if I'm down $30").
The server turns them into settings (Claude reads them if `ANTHROPIC_API_KEY` is set, otherwise a built-in reader),
shows them as an editable form, and nothing starts until you press Start. Then every 30 seconds inside the window it:
- learns how much to trust the model vs. the market per risk tier, by maximum likelihood on every settled bet the
  site has logged, with a prior at 50% worth about 40 results, so it moves only when the record is clear;
- prices each Polymarket US candidate at that learned blend, walks the real order book, and needs 2+ points of value
  per contract after fees;
- sizes with fractional Kelly ((p - c) / (1 - c)): 15% of Kelly on low risk (favorites only), 25% on medium
  (favorites and coin flips), 40% on high (all tiers), capped by your max per bet and remaining budget;
- places at most one bet per 30 seconds, two per game, never twice in one market.
It stops at the end of the window, when the budget is spent, when settled losses reach your limit, on the kill switch,
or after 3 order errors in a row. Paper mode records fills against the real order book without ordering. Live mode
needs `TRADING_ENABLED=true` and `AUTOPILOT_LIVE=true`, and every live order still passes the manual-trading caps.

Copying the model (October 2026). The autopilot mirrors every pick the model logs: steady picks and tier bets, plus
small edges on the High setting. Each is copied once, within 2 minutes of being logged, on Polymarket US, at no more
than the logged price plus 1 cent (it never chases a price that ran away), after re-walking the order book. Checks run
every 15 seconds with up to 3 buys per check. Guard rails:
- never the other side of a bet it holds in that game (no CAR +1.5 with CAR −1.5's opposite, no Over with Under);
  same-side bets are fine;
- at most a quarter of the budget in any one game;
- model-minus-market gaps over 10 points are skipped, like the logged bets;
- steady picks: only at 65-85¢, flat stake of a tenth of the budget, cashed out at 90¢ (paper: sold at the bid; live:
  the log says "CASH OUT NOW" and the sale is left to you, since the sell path hasn't been tested against the exchange);
- every other copied pick gets at least $1 (quarter Kelly on a small budget otherwise rounds most to zero).
It copies the model's picks; nothing here can promise the paper record's return, much of which came from prices that
weren't actually available (see the holdout test above).

The Portfolio chart records account value (cash plus open positions, from Polymarket US) every 5 minutes, and the
autopilot's paper profit with open bets marked to the order book midpoint.

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
