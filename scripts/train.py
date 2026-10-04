"""
Builds sim/data.json from nflverse play-by-play.

  python scripts/train.py /path/to/pbp_parquets        (play_by_play_YYYY.parquet files)

Download the files from https://github.com/nflverse/nflverse-data/releases/tag/pbp
Every season present is used. Recent seasons count more (half-life HALF seasons), so old seasons fill out rare
situations while the call mix and play results look like today's league.
"""
import sys, os, glob, json, math
import numpy as np, pandas as pd, pyarrow.parquet as pq

SRC = sys.argv[1] if len(sys.argv) > 1 else 'pbp'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', 'sim', 'data.json')
HALF = 5.0          # seasons for recency weight to halve
POOL_CAP = 2000     # outcomes kept per situation bucket (resampled by weight)
YB = [0, 5, 10, 20, 35, 50, 65, 80, 100]
CODES = 'gisxXfF'
rng = np.random.default_rng(20260930)

COLS = ['game_id', 'season', 'season_type', 'play_type', 'desc', 'posteam', 'defteam', 'home_team', 'away_team',
        'down', 'ydstogo', 'yardline_100', 'qtr', 'half_seconds_remaining', 'game_seconds_remaining', 'score_differential',
        'yards_gained', 'pass', 'rush', 'sack', 'interception', 'fumble_lost', 'incomplete_pass', 'complete_pass',
        'touchdown', 'td_team', 'return_touchdown', 'safety', 'penalty', 'qb_kneel', 'qb_spike', 'field_goal_result',
        'kick_distance', 'extra_point_result', 'two_point_conv_result', 'punt_blocked', 'own_kickoff_recovery',
        'timeout', 'aborted_play', 'result', 'spread_line', 'total_line']

files = sorted(glob.glob(os.path.join(SRC, 'play_by_play_*.parquet')))
frames = []
for f in files:
    t = pq.read_table(f)
    frames.append(t.select([c for c in COLS if c in t.column_names]).to_pandas())
df = pd.concat(frames, ignore_index=True)
del frames
if os.environ.get('MAX_SEASON'): df = df[df.season <= int(os.environ['MAX_SEASON'])].reset_index(drop=True)  # out-of-sample tables for the trading study
df['order'] = np.arange(len(df))
LAST = int(df.season.max())
df['w'] = 0.5 ** ((LAST - df.season) / HALF)
years = sorted(df.season.unique())
print('seasons', years[0], '-', years[-1], 'rows', len(df))

# ---- next scrimmage snap in the same game, for where the ball ends up after kicks and turnovers ----
snap = df.play_type.isin(['run', 'pass', 'punt', 'field_goal', 'qb_kneel', 'qb_spike', 'no_play']) & df.down.notna()
nxt = df[snap][['game_id', 'order', 'posteam', 'yardline_100']].rename(columns={'order': 'n_order', 'posteam': 'n_pos', 'yardline_100': 'n_yl', 'game_id': 'n_game'})
df = df.sort_values('order')
nxt = nxt.sort_values('n_order')
df = pd.merge_asof(df, nxt, left_on='order', right_on='n_order', direction='forward', allow_exact_matches=False)
df.loc[df.n_game != df.game_id, ['n_pos', 'n_yl']] = np.nan

def distB(x): return np.select([x <= 1, x <= 2, x <= 4, x <= 7, x <= 10], [0, 1, 2, 3, 4], 5)
def ytgB(y):
    y = np.clip(y, 0, 100); out = np.full(len(y), len(YB) - 2)
    for i in range(len(YB) - 2, 0, -1): out = np.where(y <= YB[i], i - 1, out)
    return out

# ---------------- call mix ----------------
real = df.down.between(1, 4) & df.yardline_100.between(1, 99) & df.qtr.between(1, 4)
calls = df[real & df.play_type.isin(['run', 'pass', 'punt', 'field_goal'])].copy()
calls['db'] = distB(calls.ydstogo.values); calls['yb'] = ytgB(calls.yardline_100.values)
m = calls.score_differential
late4 = (calls.qtr == 4) & (calls.game_seconds_remaining <= 480)
calls['cx'] = np.select([late4 & (m < 0) & (m >= -16), late4 & (m > 0) & (m <= 16), (calls.qtr == 2) & (calls.half_seconds_remaining <= 120)], [1, 2, 3], 0)
calls['cls'] = calls.play_type.map({'run': 1, 'pass': 2, 'punt': 3, 'field_goal': 4})
calls.loc[(calls['pass'] == 1) & (calls.play_type == 'run'), 'cls'] = 2  # scrambles were called passes
MIN_K = 40
def table(keys):
    g = calls.groupby(keys)
    n = g.size()
    out = {}
    for k, cnt in n.items():
        sub = g.get_group(k)
        ws = [float(sub.w[sub.cls == c].sum()) for c in (1, 2, 3, 4)]
        tw = sum(ws)
        kk = '_'.join(str(int(x)) for x in (k if isinstance(k, tuple) else (k,)))
        out[kk] = [int(cnt)] + [round(cnt * x / tw, 1) for x in ws]
    return out, n
k4, n4 = table(['down', 'db', 'yb', 'cx'])
k3, n3 = table(['down', 'db', 'yb'])
k2, n2 = table(['down', 'db'])
k4 = {k: v for k, v in k4.items() if v[0] >= MIN_K}
k3 = {k: v for k, v in k3.items() if v[0] >= MIN_K}
print('call tables', len(k4), len(k3), len(k2), 'plays', len(calls))

# ---------------- play results ----------------
sc = df[real & df.play_type.isin(['run', 'pass']) & (df.penalty != 1) & (df.qb_kneel != 1) & (df.qb_spike != 1) & (df.aborted_play != 1)].copy()
sc['ci'] = np.where(sc['pass'] == 1, 1, 0)
y = sc.yards_gained.fillna(0).astype(int).values
ytg = sc.yardline_100.astype(int).values
code = np.full(len(sc), 'g', dtype=object)
inc = (sc.incomplete_pass == 1) & (sc.interception != 1)
code[inc.values] = 'i'
sk = (sc.sack == 1).values
code[sk] = 's'
intr = (sc.interception == 1).values
code[intr] = 'x'
fl = (sc.fumble_lost == 1).values
code[fl] = 'f'
rtd = (sc.return_touchdown == 1).values
code[intr & rtd] = 'X'
code[fl & rtd & ~intr] = 'F'
offtd = ((sc.touchdown == 1) & (sc.td_team == sc.posteam)).values
# Turnovers: yards from the line of scrimmage to where the other team takes over, from the next snap
defpos = 100 - sc.n_yl.values
to_y = ytg - defpos
yy = y.copy()
yy[code == 'i'] = 0
gainlike = np.isin(code, ['g', 's'])
yy = np.where(gainlike & offtd, ytg, np.where(gainlike, np.minimum(yy, ytg - 1), yy))
saf = (sc.safety == 1).values & gainlike
yy = np.where(saf, -(100 - ytg), np.where(gainlike, np.maximum(yy, -(100 - ytg) + 1), yy))
turn = np.isin(code, ['x', 'f'])
ok_to = turn & ~np.isnan(to_y) & (sc.n_pos.values == sc.defteam.values)
yy = np.where(ok_to, np.nan_to_num(to_y), yy)
keep = ~turn | ok_to
sc = sc[keep]; code = code[keep]; yy = yy[keep].astype(int)
sc['code'] = code; sc['yy'] = yy
sc['dg'] = np.where(sc.down <= 2, 0, 1); sc['db'] = distB(sc.ydstogo.values); sc['yb'] = ytgB(sc.yardline_100.values)
pools = {}
def pool(sub):
    n = len(sub)
    if n == 0: return None
    p = sub.w.values / sub.w.values.sum()
    k = min(POOL_CAP, n)
    idx = rng.choice(n, size=k, replace=n < POOL_CAP and False or n < k, p=p) if n > k else rng.choice(n, size=k, replace=True, p=p)
    s = sub.iloc[idx]
    return [int(n)] + [[c, int(v)] for c, v in zip(s.code.values, s.yy.values)]
for (dg, db, yb, ci), sub in sc.groupby(['dg', 'db', 'yb', 'ci']):
    if len(sub) >= 30: pools[f'{dg}_{db}_{yb}_{"pass" if ci else "run"}'] = pool(sub)
for (yb, ci), sub in sc.groupby(['yb', 'ci']):
    pools[f'y{yb}_{"pass" if ci else "run"}'] = pool(sub)
print('pools', len(pools), 'plays', len(sc))

# ---------------- clock: median real seconds per play type ----------------
df['n_gsr'] = df.game_seconds_remaining.shift(-1)
df['n_tmo'] = df.timeout.shift(-1)
df['n_g'] = df.game_id.shift(-1)
df['n_q'] = df.qtr.shift(-1)
ck = df.loc[sc.index.intersection(df.index)] if False else None
scc = sc.join(df[['n_gsr', 'n_tmo', 'n_g', 'n_q']], how='left') if False else None
# recompute with aligned frames
tmp = df[['order', 'game_id', 'qtr', 'game_seconds_remaining', 'timeout']].copy()
tmp['n_gsr'] = tmp.game_seconds_remaining.shift(-1); tmp['n_tmo'] = tmp.timeout.shift(-1)
tmp['n_g'] = tmp.game_id.shift(-1); tmp['n_q'] = tmp.qtr.shift(-1)
sc = sc.merge(tmp[['order', 'n_gsr', 'n_tmo', 'n_g', 'n_q']], on='order', how='left')
sc['secs'] = sc.game_seconds_remaining - sc.n_gsr
sc['hurry'] = (((sc.qtr == 4) & (sc.score_differential < 0) & (sc.game_seconds_remaining < 360)) | ((sc.qtr == 2) & (sc.half_seconds_remaining <= 120))).astype(int)
okc = (sc.n_g == sc.game_id) & (sc.n_q == sc.qtr) & (sc.n_tmo != 1) & sc.secs.between(0, 60) & (sc.season >= LAST - 8)
clk = {}
for (ci, c, h), sub in sc[okc].groupby(['ci', 'code', 'hurry']):
    if len(sub) >= 20: clk[f'{"pass" if ci else "run"}_{c}_{h}'] = round(float(sub.secs.median()), 1)
print('clock', clk)

# ---------------- kicking ----------------
fg = df[(df.play_type == 'field_goal') & df.yardline_100.notna() & (df.season >= LAST - 7)].copy()
fg['d'] = fg.yardline_100 + 17; fg['ok'] = (fg.field_goal_result == 'made').astype(float)
a, b = 5.5, -0.1
X = fg.d.values; Y = fg.ok.values; W = fg.w.values
for _ in range(50):  # Newton steps for weighted logistic regression
    z = a + b * X; p = 1 / (1 + np.exp(-z)); g0 = np.sum(W * (Y - p)); g1 = np.sum(W * (Y - p) * X)
    h00 = -np.sum(W * p * (1 - p)); h01 = -np.sum(W * p * (1 - p) * X); h11 = -np.sum(W * p * (1 - p) * X * X)
    det = h00 * h11 - h01 * h01; a -= (h11 * g0 - h01 * g1) / det; b -= (-h01 * g0 + h00 * g1) / det
print('fg', a, b, 'at 50:', 1 / (1 + math.exp(-(a + b * 50))))
xp = df[(df.play_type == 'extra_point') & (df.season >= 2015)]
pxp = float(np.average(xp.extra_point_result == 'good', weights=xp.w))
tp = df[df.two_point_conv_result.notna() & (df.season >= 2015)]
p2 = float(np.average(tp.two_point_conv_result == 'success', weights=tp.w))
print('xp', pxp, '2pt', p2)

# Kickoffs follow the current rules, so only the latest kickoff era counts
ko = df[(df.play_type == 'kickoff')].copy()
ko['onside'] = ko.desc.str.contains('onside', case=False, na=False)
era = ko[ko.season >= max(2025, LAST - 1)]
norm = era[~era.onside & (era.own_kickoff_recovery != 1)]
kick = []
for _, r in norm.iterrows():
    if r.return_touchdown == 1: kick.append(0)
    elif r.n_pos == r.posteam and not np.isnan(r.n_yl): kick.append(int(r.n_yl))
kick = [int(x) for x in rng.choice(kick, size=min(600, len(kick)), replace=False)]
ons = ko[ko.onside & (ko.season >= 2024)]
p_on = float((ons.own_kickoff_recovery == 1).mean()) if len(ons) >= 20 else 0.1
print('kick sample', len(kick), 'median ytg', np.median(kick), 'onside', len(ons), p_on)

# Punts: where the receiving team starts, by distance from the punting team's goal line
pu = df[(df.play_type == 'punt') & (df.punt_blocked != 1) & df.yardline_100.notna()].copy()
pu['rpos'] = np.where(pu.return_touchdown == 1, 100, 100 - pu.n_yl)
pu = pu[(pu.return_touchdown == 1) | (pu.n_pos == pu.defteam)]
punt = {}
for lo in range(30, 100, 10):
    sub = pu[(pu.yardline_100 > lo - 10 if lo > 30 else pu.yardline_100 > 0) & (pu.yardline_100 <= lo if lo < 90 else pu.yardline_100 <= 100)]
    if len(sub) == 0: continue
    idx = rng.choice(len(sub), size=400, replace=True, p=(sub.w / sub.w.sum()).values)
    punt[str(lo)] = [int(x) for x in sub.rpos.values[idx]]
print('punt buckets', {k: float(np.median(v)) for k, v in punt.items()})
# After a safety the scoring team receives a free kick
sf = df[(df.safety == 1)]
sfree = []
for _, r in sf.iterrows():
    rows = df[(df.game_id == r.game_id) & (df.order > r.order) & (df.play_type.isin(['run', 'pass', 'punt', 'field_goal']))].head(1)
    if len(rows): sfree.append(int(100 - rows.yardline_100.iloc[0]))
safety_pos = int(np.median(sfree)) if sfree else 40
print('after safety', safety_pos, len(sfree))

# ---------------- correlation between plays of one team in one game ----------------
r = sc[(sc.code.isin(['g', 's', 'i']))].copy()
grp = r.groupby(['dg', 'db', 'yb', 'ci']).yy
r['mu'] = grp.transform('mean'); r['sd'] = grp.transform('std').fillna(8)
r['res'] = r.yy - r.mu
tg = r.groupby(['game_id', 'posteam'])
S = tg.res.sum(); S2 = tg.res.apply(lambda v: (v * v).sum()); D1 = tg.sd.sum(); D2 = tg.sd.apply(lambda v: (v * v).sum())
rho = float(((S * S - S2).sum()) / ((D1 * D1 - D2).sum()))
print('rho', rho)
gl = df.drop_duplicates('game_id')
gl = gl[gl.spread_line.notna() & (gl.season >= 2010)]
msd = float(np.std(gl.result - gl.spread_line))
print('margin SD around the spread', msd, 'games', len(gl))

lr = sum(v[1] for v in k2.values()); lp = sum(v[2] for v in k2.values())
data = {
    'calls': {'k4': k4, 'k3': k3, 'k2': k2}, 'pools': pools, 'clk': clk, 'fg': [round(a, 4), round(b, 5)],
    'pat': {'xp': round(pxp, 4), 'two': round(p2, 4)}, 'kick': kick, 'onside': {'p': round(p_on, 3), 'n': int(len(ons))},
    'punt': punt, 'safetyPos': safety_pos, 'YB': YB,
    'teams': {'A': {'qbs': [['Starting QB', 1]], 'rush': [['Lead back', 1, 4, 0]], 'recv': [['Top receiver', 2, 1, 10]], 'games': 0, 'plays': 0, 'ypp': 0, 'passrate': round(lp / (lr + lp), 3), 'opps': []}},
    'meta': {'rho': round(rho, 4), 'plays': int(len(sc)), 'callPlays': int(len(calls)), 'games': int(df.game_id.nunique()),
             'years': f'{years[0]}–{years[-1]}', 'first': int(years[0]), 'last': int(years[-1]), 'halfLife': HALF, 'marginSD': round(msd, 2)},
}
data['teams']['B'] = data['teams']['A']
with open(OUT, 'w') as f: json.dump(data, f, separators=(',', ':'))
print('wrote', OUT, os.path.getsize(OUT) // 1024, 'KB')
