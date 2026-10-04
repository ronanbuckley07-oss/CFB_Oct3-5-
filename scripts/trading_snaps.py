"""
Samples pre-snap states from past NFL games for the trading backtest (scripts/trading_study.mjs).
For each sampled snap it keeps the game state, the closing spread and total, the final result, and nflfastR's
spread-adjusted win probability (vegas_home_wp), which stands in for the in-game market price because historical
in-game prices from sportsbooks and exchanges aren't public.
  python scripts/trading_snaps.py /path/to/pbp_parquets  [first_season]
"""
import sys, os, glob, json
import numpy as np, pandas as pd, pyarrow.parquet as pq
SRC = sys.argv[1] if len(sys.argv) > 1 else 'pbp'
FIRST = int(sys.argv[2]) if len(sys.argv) > 2 else 2021
OUT = os.path.join(os.path.dirname(__file__), '..', 'sim', 'snaps.json')
cols = ['game_id', 'season', 'season_type', 'home_team', 'away_team', 'posteam', 'qtr', 'game_seconds_remaining', 'quarter_seconds_remaining',
        'down', 'ydstogo', 'yardline_100', 'total_home_score', 'total_away_score', 'home_timeouts_remaining', 'away_timeouts_remaining',
        'play_type', 'vegas_home_wp', 'spread_line', 'total_line', 'result', 'total', 'home_score', 'away_score']
rng = np.random.default_rng(7)
out = []
for f in sorted(glob.glob(os.path.join(SRC, 'play_by_play_*.parquet'))):
    yr = int(f[-12:-8])
    if yr < FIRST: continue
    df = pq.read_table(f, columns=cols).to_pandas()
    # scores at the snap = scores after the previous play
    df['hs'] = df.groupby('game_id').total_home_score.shift(1).fillna(0)
    df['as'] = df.groupby('game_id').total_away_score.shift(1).fillna(0)
    ok = df.play_type.isin(['run', 'pass', 'punt', 'field_goal']) & df.down.between(1, 4) & df.qtr.between(1, 4) & df.vegas_home_wp.between(0.03, 0.97) & df.spread_line.notna()
    for gid, g in df[ok].groupby('game_id'):
        g0 = g.iloc[0]
        if g0.home_score == g0.away_score: continue  # ties settle as pushes; leave them out of the study
        idx = np.sort(rng.choice(len(g), size=min(14, len(g)), replace=False))
        first = g.iloc[0]
        for r in g.iloc[idx].itertuples():
            out.append([gid, int(r.season), int(r.season_type == 'POST'), 'A' if r.posteam == r.home_team else 'B', int(100 - r.yardline_100), int(r.down), int(min(r.ydstogo, r.yardline_100)),
                        int(r.qtr), int(r.quarter_seconds_remaining), int(r.hs), int(getattr(r, '_' + str(list(df.columns).index('as') + 1))), int(r.home_timeouts_remaining), int(r.away_timeouts_remaining),
                        'B' if first.posteam == first.home_team else 'A', round(float(r.vegas_home_wp), 4), float(r.spread_line), float(r.total_line), int(r.home_score > r.away_score)])
    print(yr, len(out))
json.dump(out, open(OUT, 'w'))
print('wrote', OUT, len(out))
