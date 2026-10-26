# Game states for the ML win-probability models, home-team perspective, one row per scrimmage play.
#   python3 tools/ml/states.py cfb <dir with play_by_play_YYYY / pYYYY.parquet>  -> cfb_states.parquet
#   python3 tools/ml/states.py nfl <pbp.pkl from tools/trading_holdout/load.py>    -> nfl_states.parquet
# Columns: season, week, game, diff (home - away before the play), tl (seconds left in regulation), posH (+1 home ball,
# -1 away), ytg (yards to the end zone), down, dist, toH, toA (timeouts), spread (pregame expected home margin),
# total (pregame over/under), h2 (+1 home gets the 2nd-half kickoff, -1 away, 0 in the 2nd half), mkt (ESPN or Vegas
# home win probability before the play, for comparison only), y (home won).
import sys, glob, re, numpy as np, pandas as pd, pyarrow.parquet as pq
from collections import deque
lg, src = sys.argv[1], sys.argv[2]

# Momentum, from plays strictly before each play (the live server computes the same from ESPN's play list,
# api/wpml.mjs momentumFrom): run = home minus away points over the last 600 game-seconds; last = +1 home scored last,
# -1 away, 0 nobody yet; ypp = home offense minus away offense yards per play over the last 16 scrimmage snaps
# (capped at +-15); tov = away minus home turnovers over the last 600 game-seconds.
def momentum(game, t, hs, as_, homeoff, yards, scrim, tov):
    n = len(game); run = np.zeros(n); last = np.zeros(n); ypp = np.zeros(n); tv = np.zeros(n)
    start = 0
    while start < n:
        end = start
        while end < n and game[end] == game[start]: end += 1
        hist = []; snaps = deque(maxlen=16); tovs = deque(); lst = 0; ph, pa = 0, 0
        for i in range(start, end):
            ti = t[i]
            # scores before this play
            while hist and hist[0][0] < ti - 600: hist.pop(0)
            run[i] = sum(h[1] for h in hist); last[i] = lst
            hy = [y for (o, y) in snaps if o == 1]; ay = [y for (o, y) in snaps if o == -1]
            if hy and ay: ypp[i] = max(-15, min(15, np.mean(hy) - np.mean(ay)))
            while tovs and tovs[0][0] < ti - 600: tovs.popleft()
            tv[i] = sum(x[1] for x in tovs)
            # then this play happens: score change seen on the next play's start score
            nh, na = hs[i + 1] if i + 1 < end else hs[i], as_[i + 1] if i + 1 < end else as_[i]
            dh, da = max(0, nh - hs[i]), max(0, na - as_[i])
            if dh or da: hist.append((ti, dh - da)); lst = 1 if dh > da else -1
            if scrim[i] and not np.isnan(yards[i]): snaps.append((homeoff[i], max(-20, min(60, yards[i]))))
            if tov[i]: tovs.append((ti, -homeoff[i]))  # the offense lost it: home turnover counts against home
        start = end
    return run, last, ypp, tv
if lg == 'cfb':
    cols = ['game_id', 'week', 'period', 'start.adj_TimeSecsRem', 'start.down', 'start.distance', 'start.yardsToEndzone', 'start.homeScore', 'start.awayScore',
            'start.is_home', 'start.homeTeamTimeouts', 'start.awayTeamTimeouts', 'homeTeamSpread', 'overUnder', 'homeFinalScore', 'awayFinalScore', 'home_wp_before',
            'start.pos_team_receives_2H_kickoff', 'statYardage', 'isTurnover', 'start.homeScore', 'start.awayScore']
    fr = []
    for f in sorted(glob.glob(f'{src}/p*.parquet')):
        season = int(re.search(r'(\d{4})', f).group(1)); t = pq.read_table(f); use = [c for c in dict.fromkeys(cols) if c in t.column_names]
        d = t.select(use).to_pandas(); d['season'] = season; fr.append(d); print(season, len(d), file=sys.stderr)
    d = pd.concat(fr, ignore_index=True)
    # game clock elapsed, carried forward over rows without one and never running backwards
    el = (3600 - d.groupby('game_id')['start.adj_TimeSecsRem'].ffill().fillna(3600).clip(0, 3600)).groupby(d.game_id).cummax()
    homeoff = np.where(d['start.is_home'].astype(bool), 1, -1)
    scrim = d['start.down'].between(1, 4).values
    tov = d['isTurnover'].fillna(False).astype(bool).values if 'isTurnover' in d else np.zeros(len(d), bool)
    r, l, y_, t_ = momentum(d.game_id.astype(str).values, el.values, d['start.homeScore'].fillna(0).values, d['start.awayScore'].fillna(0).values, homeoff, d['statYardage'].astype(float).values, scrim, tov)
    d['m_run'], d['m_last'], d['m_ypp'], d['m_tov'] = r, l, y_, t_
    d = d[d['start.down'].between(1, 4) & d['start.yardsToEndzone'].between(1, 99) & d.period.between(1, 4) & d.homeTeamSpread.notna() & d.homeFinalScore.notna() & (d.homeFinalScore != d.awayFinalScore)]
    home_ball = d['start.is_home'].astype(bool); recv = d['start.pos_team_receives_2H_kickoff'].astype(bool)
    out = pd.DataFrame({'season': d.season, 'week': d.week.fillna(0).astype(int), 'game': d.game_id.astype(str),
        'diff': d['start.homeScore'] - d['start.awayScore'], 'tl': d['start.adj_TimeSecsRem'].clip(0, 3600), 'posH': np.where(home_ball, 1, -1),
        'ytg': d['start.yardsToEndzone'], 'down': d['start.down'], 'dist': d['start.distance'].clip(1, 99), 'toH': d['start.homeTeamTimeouts'].clip(0, 3), 'toA': d['start.awayTeamTimeouts'].clip(0, 3),
        'spread': d.homeTeamSpread, 'total': d.overUnder.fillna(55.5), 'h2': np.where(d.period <= 2, np.where(home_ball == recv, 1, -1), 0),
        'mkt': d.home_wp_before, 'y': (d.homeFinalScore > d.awayFinalScore).astype(int), 'run': d.m_run, 'last': d.m_last, 'ypp': d.m_ypp.round(2), 'tov': d.m_tov})
else:
    d = pd.read_pickle(src); d = d[d.season_type.isin(['REG', 'POST'])].sort_values(['game_id', 'play_id']).copy()
    d['hs'] = d.groupby('game_id').total_home_score.shift(1).fillna(0); d['as_'] = d.groupby('game_id').total_away_score.shift(1).fillna(0)
    first = d[d.posteam.notna() & d.down.between(1, 4)].groupby('game_id').posteam.first()
    d['open_recv'] = d.game_id.map(first)
    el = (3600 - d.groupby('game_id').game_seconds_remaining.ffill().fillna(3600)).clip(0, 3600).groupby(d.game_id).cummax()
    homeoff = np.where(d.posteam == d.home_team, 1, -1)
    scrim = (d.play_type.isin(['run', 'pass']) & d.down.between(1, 4)).values
    tov = ((d.interception.fillna(0) == 1) | (d.fumble_lost.fillna(0) == 1)).values if 'interception' in d and 'fumble_lost' in d else np.zeros(len(d), bool)
    r, l, y_, t_ = momentum(d.game_id.values, el.values, d.hs.values, d.as_.values, homeoff, d.yards_gained.astype(float).values if 'yards_gained' in d else np.full(len(d), np.nan), scrim, tov)
    d['m_run'], d['m_last'], d['m_ypp'], d['m_tov'] = r, l, y_, t_
    d = d[d.play_type.isin(['run', 'pass', 'punt', 'field_goal']) & d.down.between(1, 4) & d.qtr.between(1, 4) & d.yardline_100.between(1, 99) & d.posteam.notna() & d.spread_line.notna() & d.home_score.notna() & (d.home_score != d.away_score)]
    home_ball = d.posteam == d.home_team; home_open = d.open_recv == d.home_team
    out = pd.DataFrame({'season': d.season, 'week': d.week.astype(int), 'game': d.game_id, 'diff': d.hs - d.as_, 'tl': ((4 - d.qtr) * 900 + d.quarter_seconds_remaining).clip(0, 3600),
        'posH': np.where(home_ball, 1, -1), 'ytg': d.yardline_100, 'down': d.down, 'dist': np.maximum(1, np.minimum(d.ydstogo, d.yardline_100)),
        'toH': d.home_timeouts_remaining.clip(0, 3), 'toA': d.away_timeouts_remaining.clip(0, 3), 'spread': d.spread_line, 'total': d.total_line.fillna(44.5),
        'h2': np.where(d.qtr <= 2, np.where(home_open, -1, 1), 0), 'mkt': d.vegas_home_wp, 'y': (d.home_score > d.away_score).astype(int),
        'run': d.m_run, 'last': d.m_last, 'ypp': d.m_ypp.round(2), 'tov': d.m_tov})
out = out.dropna(subset=['diff', 'tl', 'ytg', 'down', 'dist', 'spread']).reset_index(drop=True)
# a few games have plays out of order (scores jump back and forth): drop any game with an impossible 10-minute run
bad = out.loc[out.run.abs() > 42, 'game'].unique(); out = out[~out.game.isin(bad)].reset_index(drop=True); print('dropped', len(bad), 'games with plays out of order', file=sys.stderr)
for c in ['diff', 'tl', 'ytg', 'down', 'dist', 'toH', 'toA', 'posH', 'h2', 'run', 'last', 'tov']: out[c] = out[c].astype(int)
out.to_parquet(f'{lg}_states.parquet'); print(lg, len(out), 'rows', out.game.nunique(), 'games', out.season.min(), '-', out.season.max(), 'home win rate', round(out.y.mean(), 3), file=sys.stderr)
