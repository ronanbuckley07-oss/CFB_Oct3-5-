# Trading holdout (October 2026)

Replays the live bet rules (`api/picks.mjs`) on NFL games the model never saw: tables built from 1999-2024 only,
tested on every 2025 game and 2026 weeks 1-4 (343 games, 24,456 snaps, 8,000 sims each). The "market" is nflfastR's
Vegas win probability plus 1 cent and the Polymarket US taker fee. Spread ladders are priced with a normal model
anchored to it (`calib.mjs` shows it's calibrated); the same proxy for totals was not, so totals are left out.

Run from an empty work folder:

```
for y in $(seq 1999 2026); do curl -sL -o raw/pbp_$y.parquet https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_$y.parquet; done
python3 $T/load.py                                   # -> pbp.pkl
MAXS=2024 OUT=nfl_data_2024.json python3 $T/../build_nfl_data.py
python3 $T/extract.py                                # -> engine.js, prod_nfl_data.json, patches nfl_data_2024.json
python3 $T/snaps.py                                  # -> holdout_snaps.json
node $T/run.mjs nfl_data_2024.json holdout_snaps.json holdout_out.json 8000 study   # ~1 hour on 4 cores
node $T/analyze.mjs      # tier records under different costs
node $T/analyze2.mjs     # season split, team concentration, which probability predicted best, learned trust
node $T/analyze3.mjs     # model and price a play apart (stale quote / late ESPN feed)
node $T/steady.mjs       # search for the steady-picks rule (fit 2025, check 2026)
node $T/steady_lag.mjs   # steady rule when model and price are a play apart
OUT=../public/replay_bets.json node $T/dump_replay.mjs
```
(`T` is this folder; copy the .mjs files next to the data or run them from the work folder.)
