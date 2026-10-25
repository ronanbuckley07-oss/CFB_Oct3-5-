# Train the ML win-probability models (tools/ml/states.py makes the inputs).
#   python3 tools/ml/train_wp.py cfb|nfl <states.parquet> <out dir>
# Walk-forward evaluation: fit on every season before the validation season, stop adding trees when the validation
# season stops improving, then score the test season(s), which the model never saw, against the market's win
# probability (ESPN's for college, Vegas-adjusted nflfastR for the NFL). Then refit on everything for the live model.
# Writes: wpml_<lg>.json (live model, compact trees for api/wpml.mjs), wpml_<lg>_eval.json (test results), and
# wpml_<lg>_parity.json (feature rows + Python predictions to check the JavaScript predictor against).
import sys, json, math, numpy as np, pandas as pd, lightgbm as lgb
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
lg, src, outd = sys.argv[1], sys.argv[2], sys.argv[3]
FEATS = ['diff', 'tl', 'posH', 'ytg', 'down', 'dist', 'toH', 'toA', 'spread', 'total', 'h2', 'em', 'z', 'fp']
def feats(d):  # identical to wpFeatures in api/wpml.mjs
    f = d.tl / 3600; em = d['diff'] + d.spread * f
    X = d[['diff', 'tl', 'posH', 'ytg', 'down', 'dist', 'toH', 'toA', 'spread', 'total', 'h2']].astype(float).copy()
    X['em'] = em; X['z'] = em / (14 * np.sqrt(f) + 1); X['fp'] = d.posH * (100 - d.ytg)
    return X[FEATS]
d = pd.read_parquet(src)
SPLIT = {'cfb': dict(first=2014, valid=2024, test=[2025]), 'nfl': dict(first=2006, valid=2024, test=[2025, 2026])}[lg]
d = d[d.season >= SPLIT['first']].reset_index(drop=True); X = feats(d); y = d.y.values
tr, va, te = (d.season < SPLIT['valid']).values, (d.season == SPLIT['valid']).values, d.season.isin(SPLIT['test']).values
# More-ahead and spread-favored can only help the home team: monotone constraints keep the trees sensible at the edges
mono = [1 if f in ('diff', 'spread', 'em', 'z') else 0 for f in FEATS]
P = dict(objective='binary', learning_rate=0.05, num_leaves=31, min_data_in_leaf=400, feature_fraction=0.9, bagging_fraction=0.8, bagging_freq=1,
         lambda_l2=1.0, monotone_constraints=mono, verbose=-1, seed=7)
# Settings chosen on the validation season only (the test seasons stay unseen). Plays within a game share one outcome,
# so a million plays are really a few thousand independent results: small, heavily regularized trees generalize best.
grid = [dict(num_leaves=31, min_data_in_leaf=400), dict(num_leaves=15, min_data_in_leaf=2000), dict(num_leaves=7, min_data_in_leaf=5000, learning_rate=0.03), dict(num_leaves=4, min_data_in_leaf=10000, learning_rate=0.03)]
tried = []
for g in grid:
    Pg = {**P, **g}; mg = lgb.train(Pg, lgb.Dataset(X[tr], y[tr]), 3000, valid_sets=[lgb.Dataset(X[va], y[va])], callbacks=[lgb.early_stopping(80, verbose=False)])
    pv = np.clip(mg.predict(X[va], num_iteration=mg.best_iteration), 0.005, 0.995); vll = float(-np.mean(y[va] * np.log(pv) + (1 - y[va]) * np.log(1 - pv)))
    tried.append(dict(g=g, trees=mg.best_iteration, valid_ll=round(vll, 4), valid_ll_raw=vll)); print(lg, g, mg.best_iteration, round(vll, 4), file=sys.stderr)
    if not any(t['valid_ll_raw'] < vll for t in tried[:-1]): m, P_best = mg, Pg
    tried[-1]['valid_ll_raw'] = vll
P = P_best; best = m.best_iteration; print(lg, 'chose', P, 'trees', best, file=sys.stderr)
# simple-ML baseline: logistic regression on the same features plus a few hand-made interactions
def lr_x(X): Z = X.copy(); Z['em_t'] = X.em * (1 - X.tl / 3600); Z['z2'] = X.z * np.abs(X.z); Z['fp_t'] = X.fp * (1 - X.tl / 3600); return Z
lr = make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, C=1.0)).fit(lr_x(X[tr | va]), y[tr | va])
T = d[te].copy(); T['ml'] = m.predict(X[te], num_iteration=best); T['lr'] = lr.predict_proba(lr_x(X[te]))[:, 1]
T['avg'] = (T.ml + T.lr) / 2
T['pre'] = 1 / (1 + np.exp(-T.spread / (14 * 0.96)))  # pregame line only, never updated (a floor to beat)
def score(p, yv):
    p = np.clip(p, 0.005, 0.995); return dict(ll=round(float(-np.mean(yv * np.log(p) + (1 - yv) * np.log(1 - p))), 4), brier=round(float(np.mean((p - yv) ** 2)), 4), n=int(len(yv)))
Tm = T[T.mkt.notna()]
for t in tried: t.pop('valid_ll_raw', None)
res = {'grid': tried, 'league': lg, 'train': f"{SPLIT['first']}-{SPLIT['valid'] - 1}", 'valid': SPLIT['valid'], 'test': SPLIT['test'], 'trees': int(best), 'plays': int(te.sum()), 'games': int(T.game.nunique()),
       'overall': {k: score(Tm[k].values, Tm.y.values) for k in ['ml', 'lr', 'avg', 'mkt', 'pre']}}
# by phase, and calibration
ph = pd.cut(Tm.tl, [-1, 300, 900, 1800, 2700, 3600], labels=['last 5 min', 'Q4 rest', 'Q3', 'Q2', 'Q1'])
res['phase'] = {str(k): {c: score(g[c].values, g.y.values) for c in ['ml', 'lr', 'avg', 'mkt']} for k, g in Tm.groupby(ph, observed=True)}
bins = np.linspace(0, 1, 11)
res['calib'] = {c: [dict(lo=round(float(bins[i]), 1), n=int(((Tm[c] >= bins[i]) & (Tm[c] < bins[i + 1] + (i == 9))).sum()), said=round(float(Tm[c][(Tm[c] >= bins[i]) & (Tm[c] < bins[i + 1] + (i == 9))].mean()), 3) if (((Tm[c] >= bins[i]) & (Tm[c] < bins[i + 1] + (i == 9))).sum()) else None,
                     won=round(float(Tm.y[(Tm[c] >= bins[i]) & (Tm[c] < bins[i + 1] + (i == 9))].mean()), 3) if (((Tm[c] >= bins[i]) & (Tm[c] < bins[i + 1] + (i == 9))).sum()) else None) for i in range(10)] for c in ['ml', 'lr', 'avg', 'mkt']}
# how much each input is used (gain), for the How it works page
imp = m.feature_importance('gain'); res['importance'] = sorted([dict(f=f, gain=round(float(g / imp.sum()), 4)) for f, g in zip(FEATS, imp)], key=lambda r: -r['gain'])
# blends with the market, fit on the validation season only
V = d[va].copy(); V['ml'] = (m.predict(X[va], num_iteration=best) + lr.predict_proba(lr_x(X[va]))[:, 1]) / 2; V = V[V.mkt.notna()]
best_w = min((w / 20 for w in range(21)), key=lambda w: score(w * V.ml.values + (1 - w) * V.mkt.values, V.y.values)['ll'])
res['blend'] = dict(w_ml=best_w, test=score(best_w * Tm.avg.values + (1 - best_w) * Tm.mkt.values, Tm.y.values))
json.dump(res, open(f'{outd}/wpml_{lg}_eval.json', 'w'), indent=1); print(json.dumps(res['overall']), 'blend', res['blend'], file=sys.stderr)
# live model: refit on every season through the latest, same number of trees (+10% for the extra data)
allm = lgb.train(P, lgb.Dataset(X, y), int(best * 1.1))
def tree_out(t):
    nodes, leaves = [], []
    def walk(n):
        if 'leaf_value' in n: leaves.append(round(n['leaf_value'], 6)); return -len(leaves)
        i = len(nodes); nodes.append(None); l = walk(n['left_child']); r = walk(n['right_child'])
        nodes[i] = [n['split_feature'], float(n['threshold']), l, r]; return i  # full precision: LightGBM splits at ±1e-35 around zero
    root = walk(t['tree_structure'])
    if root < 0: nodes.append([0, 1e300, root, root])  # a single-leaf tree
    return {'n': nodes, 'l': leaves}
def export(booster, lrp, extra):
    sc, cl = lrp.named_steps['standardscaler'], lrp.named_steps['logisticregression']
    return {'lr': {'feats': list(lr_x(X.head(1)).columns), 'mean': [round(v, 6) for v in sc.mean_], 'scale': [round(v, 6) for v in sc.scale_], 'coef': [round(v, 6) for v in cl.coef_[0]], 'b': round(float(cl.intercept_[0]), 6)},
            'feats': FEATS, 'trees': [tree_out(t) for t in booster.dump_model(num_iteration=extra.pop('iters', None))['tree_info']], **extra}
# the test-time models (fit before the validation season), for comparing against the Monte Carlo on the same plays
json.dump(export(m, lr, {'iters': best, 'league': lg, 'mode': 'test', 'trainedThrough': SPLIT['valid']}), open(f'{outd}/wpml_{lg}_test.json', 'w'), separators=(',', ':'))
dump = allm.dump_model()
lr_all = make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, C=1.0)).fit(lr_x(X), y)
sc, cl = lr_all.named_steps['standardscaler'], lr_all.named_steps['logisticregression']
model_lr = {'feats': list(lr_x(X.head(1)).columns), 'mean': [round(v, 6) for v in sc.mean_], 'scale': [round(v, 6) for v in sc.scale_], 'coef': [round(v, 6) for v in cl.coef_[0]], 'b': round(float(cl.intercept_[0]), 6)}
model = {'lr': model_lr, 'league': lg, 'feats': FEATS, 'seasons': f"{int(d.season.min())}-{int(d.season.max())}", 'plays': int(len(d)), 'games': int(d.game.nunique()), 'trees': [tree_out(t) for t in dump['tree_info']]}
json.dump(model, open(f'{outd}/wpml_{lg}.json', 'w'), separators=(',', ':'))
smp = d.sample(2000, random_state=1); json.dump({'rows': smp[['diff', 'tl', 'posH', 'ytg', 'down', 'dist', 'toH', 'toA', 'spread', 'total', 'h2']].to_dict('records'), 'p': allm.predict(feats(smp)).round(6).tolist(), 'plr': lr_all.predict_proba(lr_x(feats(smp)))[:, 1].round(6).tolist()}, open(f'{outd}/wpml_{lg}_parity.json', 'w'))
print('wrote', lg, len(model['trees']), 'trees', file=sys.stderr)
