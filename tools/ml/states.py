# Game states for the ML win-probability models, home-team perspective, one row per scrimmage play.
#   python3 tools/ml/states.py cfb <dir with play_by_play_YYYY / pYYYY.parquet>  -> cfb_states.parquet
#   python3 tools/ml/states.py nfl <pbp.pkl from tools/trading_holdout/load.py>    -> nfl_states.parquet
# Columns: season, week, game, diff (home - away before the play), tl (seconds left in regulation), posH (+1 home ball,
# -1 away), ytg (yards to the end zone), down, dist, toH, toA (timeouts), spread (pregame expected home margin),
# total (pregame over/under), h2 (+1 home gets the 2nd-half kickoff, -1 away, 0 in the 2nd half), mkt (ESPN or Vegas
# home win probability before the play, for comparison only), y (home won).
import sys, glob, re, numpy as np, pandas as pd, pyarrow.parquet as pq
lg, src = sys.argv[1], sys.argv[2]
if lg == 'cfb':
    cols = ['game_id', 'week', 'period', 'start.adj_TimeSecsRem', 'start.down', 'start.distance', 'start.yardsToEndzone', 'start.homeScore', 'start.awayScore',
            'start.is_home', 'start.homeTeamTimeouts', 'start.awayTeamTimeouts', 'homeTeamSpread', 'overUnder', 'homeFinalScore', 'awayFinalScore', 'home_wp_before',
            'start.pos_team_receives_2H_kickoff']
    fr = []
    for f in sorted(glob.glob(f'{src}/p*.parquet')):
        season = int(re.search(r'(\d{4})', f).group(1)); t = pq.read_table(f); use = [c for c in cols if c in t.column_names]
        d = t.select(use).to_pandas(); d['season'] = season; fr.append(d); print(season, len(d), file=sys.stderr)
    d = pd.concat(fr, ignore_index=True)
    d = d[d['start.down'].between(1, 4) & d['start.yardsToEndzone'].between(1, 99) & d.period.between(1, 4) & d.homeTeamSpread.notna() & d.homeFinalScore.notna() & (d.homeFinalScore != d.awayFinalScore)]
    home_ball = d['start.is_home'].astype(bool); recv = d['start.pos_team_receives_2H_kickoff'].astype(bool)
    out = pd.DataFrame({'season': d.season, 'week': d.week.fillna(0).astype(int), 'game': d.game_id.astype(str),
        'diff': d['start.homeScore'] - d['start.awayScore'], 'tl': d['start.adj_TimeSecsRem'].clip(0, 3600), 'posH': np.where(home_ball, 1, -1),
        'ytg': d['start.yardsToEndzone'], 'down': d['start.down'], 'dist': d['start.distance'].clip(1, 99), 'toH': d['start.homeTeamTimeouts'].clip(0, 3), 'toA': d['start.awayTeamTimeouts'].clip(0, 3),
        'spread': d.homeTeamSpread, 'total': d.overUnder.fillna(55.5), 'h2': np.where(d.period <= 2, np.where(home_ball == recv, 1, -1), 0),
        'mkt': d.home_wp_before, 'y': (d.homeFinalScore > d.awayFinalScore).astype(int)})
else:
    d = pd.read_pickle(src); d = d[d.season_type.isin(['REG', 'POST'])].sort_values(['game_id', 'play_id']).copy()
    d['hs'] = d.groupby('game_id').total_home_score.shift(1).fillna(0); d['as_'] = d.groupby('game_id').total_away_score.shift(1).fillna(0)
    first = d[d.posteam.notna() & d.down.between(1, 4)].groupby('game_id').posteam.first()
    d['open_recv'] = d.game_id.map(first)
    d = d[d.play_type.isin(['run', 'pass', 'punt', 'field_goal']) & d.down.between(1, 4) & d.qtr.between(1, 4) & d.yardline_100.between(1, 99) & d.posteam.notna() & d.spread_line.notna() & d.home_score.notna() & (d.home_score != d.away_score)]
    home_ball = d.posteam == d.home_team; home_open = d.open_recv == d.home_team
    out = pd.DataFrame({'season': d.season, 'week': d.week.astype(int), 'game': d.game_id, 'diff': d.hs - d.as_, 'tl': ((4 - d.qtr) * 900 + d.quarter_seconds_remaining).clip(0, 3600),
        'posH': np.where(home_ball, 1, -1), 'ytg': d.yardline_100, 'down': d.down, 'dist': np.maximum(1, np.minimum(d.ydstogo, d.yardline_100)),
        'toH': d.home_timeouts_remaining.clip(0, 3), 'toA': d.away_timeouts_remaining.clip(0, 3), 'spread': d.spread_line, 'total': d.total_line.fillna(44.5),
        'h2': np.where(d.qtr <= 2, np.where(home_open, -1, 1), 0), 'mkt': d.vegas_home_wp, 'y': (d.home_score > d.away_score).astype(int)})
out = out.dropna(subset=['diff', 'tl', 'ytg', 'down', 'dist', 'spread']).reset_index(drop=True)
for c in ['diff', 'tl', 'ytg', 'down', 'dist', 'toH', 'toA', 'posH', 'h2']: out[c] = out[c].astype(int)
out.to_parquet(f'{lg}_states.parquet'); print(lg, len(out), 'rows', out.game.nunique(), 'games', out.season.min(), '-', out.season.max(), 'home win rate', round(out.y.mean(), 3), file=sys.stderr)
