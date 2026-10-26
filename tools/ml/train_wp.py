# Train the ML win-probability models (tools/ml/states.py makes the inputs).
#   python3 tools/ml/train_wp.py cfb|nfl <states.parquet> <out dir>
# Three models, each trained on every season before the validation season, tuned on the validation season only, and
# scored on the test season(s) it never saw, against the market's win probability (ESPN for college, Vegas-adjusted
# nflfastR for the NFL):
#   trees   LightGBM gradient-boosted trees, monotone in score and spread
#   lr      logistic regression on the same inputs plus three interactions
#   nn      a small neural network (inputs -> 16 -> 8 -> 1, ReLU), sklearn MLPClassifier
# The live "ML" number is the average of the three. Two input sets are compared: the 14 game-state inputs, and those
# plus four momentum inputs (scoring run, who scored last, recent yards per play, recent turnovers). The set is chosen
# on the validation season. Then everything is refit on every season for the live model.
# Writes: wpml_<lg>.json (live model for api/wpml.mjs), wpml_<lg>_test.json (test-time model, for comparing with the
# Monte Carlo), wpml_<lg>_eval.json (results), wpml_<lg>_parity.json (Python predictions to check the JavaScript),
# wpml_<lg>_anchor.json (a fixed sample of held-out plays the server uses to guard its online learning).
import sys, json, numpy as np, pandas as pd, lightgbm as lgb
from sklearn.linear_model import LogisticRegression
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
lg, src, outd = sys.argv[1], sys.argv[2], sys.argv[3]
BASE = ['diff', 'tl', 'posH', 'ytg', 'down', 'dist', 'toH', 'toA', 'spread', 'total', 'h2', 'em', 'z', 'fp']
MOM = BASE + ['run', 'last', 'ypp', 'tov']
def feats(d, F):  # identical to wpFeatures in api/wpml.mjs
    f = d.tl / 3600; em = d['diff'] + d.spread * f
    X = d[['diff', 'tl', 'posH', 'ytg', 'down', 'dist', 'toH', 'toA', 'spread', 'total', 'h2']].astype(float).copy()
    X['em'] = em; X['z'] = em / (14 * np.sqrt(f) + 1); X['fp'] = d.posH * (100 - d.ytg)
    for c in ['run', 'last', 'ypp', 'tov']: X[c] = d[c].astype(float)
    return X[F]
def lr_x(X): Z = X.copy(); Z['em_t'] = X.em * (1 - X.tl / 3600); Z['z2'] = X.z * np.abs(X.z); Z['fp_t'] = X.fp * (1 - X.tl / 3600); return Z
d = pd.read_parquet(src)
SPLIT = {'cfb': dict(first=2014, valid=2024, test=[2025]), 'nfl': dict(first=2006, valid=2024, test=[2025, 2026])}[lg]
d = d[d.season >= SPLIT['first']].reset_index(drop=True); y = d.y.values
tr, va, te = (d.season < SPLIT['valid']).values, (d.season == SPLIT['valid']).values, d.season.isin(SPLIT['test']).values
P0 = dict(objective='binary', feature_fraction=0.9, bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0, verbose=-1, seed=7)
GRID = [dict(num_leaves=15, min_data_in_leaf=2000, learning_rate=0.05), dict(num_leaves=4, min_data_in_leaf=10000, learning_rate=0.03)]
cl = lambda p: np.clip(p, 0.005, 0.995)
def LL(p, yv): p = cl(p); return float(-np.mean(yv * np.log(p) + (1 - yv) * np.log(1 - p)))
def BR(p, yv): return float(np.mean((p - yv) ** 2))
rng = np.random.default_rng(5)
def fit_all(F, mask_tr, mask_va):
    X = feats(d, F); mono = [1 if f in ('diff', 'spread', 'em', 'z') else 0 for f in F]
    best = None
    for g in GRID:
        P = {**P0, **g, 'monotone_constraints': mono}
        m = lgb.train(P, lgb.Dataset(X[mask_tr], y[mask_tr]), 3000, valid_sets=[lgb.Dataset(X[mask_va], y[mask_va])], callbacks=[lgb.early_stopping(80, verbose=False)])
        v = LL(m.predict(X[mask_va], num_iteration=m.best_iteration), y[mask_va])
        if best is None or v < best[0]: best = (v, m, P, m.best_iteration)
    trees = best[1]
    lr = make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, C=1.0)).fit(lr_x(X[mask_tr]), y[mask_tr])
    # the network trains on a sample of up to 600k plays (sklearn's MLP is slow), early-stopped on a slice of it
    idx = np.flatnonzero(mask_tr); idx = rng.choice(idx, min(600000, len(idx)), replace=False)
    nn = make_pipeline(StandardScaler(), MLPClassifier(hidden_layer_sizes=(16, 8), activation='relu', alpha=1e-3, batch_size=2048, learning_rate_init=1e-3,
                                                         max_iter=40, early_stopping=True, validation_fraction=0.1, n_iter_no_change=4, random_state=3)).fit(X.iloc[idx], y[idx])
    return dict(F=F, X=X, trees=trees, iters=best[3], P=best[2], lr=lr, nn=nn)
def predict(M, mask):
    X = M['X'][mask]; t = M['trees'].predict(X, num_iteration=M['iters']); l = M['lr'].predict_proba(lr_x(X))[:, 1]; n = M['nn'].predict_proba(X)[:, 1]
    return dict(trees=t, lr=l, nn=n, ml=(t + l + n) / 3, tl2=(t + l) / 2)
res = {'league': lg, 'train': f"{SPLIT['first']}-{SPLIT['valid'] - 1}", 'valid': SPLIT['valid'], 'test': SPLIT['test'], 'sets': {}}
models = {}
for name, F in [('base', BASE), ('momentum', MOM)]:
    M = fit_all(F, tr, va); models[name] = M
    pv, pt = predict(M, va), predict(M, te); mt = d[te].mkt.notna().values
    res['sets'][name] = {'feats': F, 'trees': int(M['iters']), 'valid': {k: round(LL(v, y[va]), 4) for k, v in pv.items()},
                         'test': {k: {'ll': round(LL(v[mt], y[te][mt]), 4), 'brier': round(BR(v[mt], y[te][mt]), 4)} for k, v in pt.items()}}
    print(lg, name, 'valid', res['sets'][name]['valid'], 'test', {k: v['ll'] for k, v in res['sets'][name]['test'].items()}, file=sys.stderr)
chosen = min(res['sets'], key=lambda k: res['sets'][k]['valid']['ml']); res['chosen'] = chosen; M = models[chosen]
print(lg, 'chose', chosen, file=sys.stderr)
T = d[te].copy(); p = predict(M, te)
for k, v in p.items(): T[k] = v
T['pre'] = 1 / (1 + np.exp(-T.spread / (14 * 0.96))); Tm = T[T.mkt.notna()]
sc = lambda c: dict(ll=round(LL(Tm[c].values, Tm.y.values), 4), brier=round(BR(Tm[c].values, Tm.y.values), 4), n=int(len(Tm)))
res.update({'trees': int(M['iters']), 'plays': int(te.sum()), 'games': int(T.game.nunique()), 'overall': {k: sc(k) for k in ['ml', 'trees', 'lr', 'nn', 'tl2', 'mkt', 'pre']}})
ph = pd.cut(Tm.tl, [-1, 300, 900, 1800, 2700, 3600], labels=['last 5 min', 'Q4 rest', 'Q3', 'Q2', 'Q1'])
res['phase'] = {str(k): {c: dict(ll=round(LL(g[c].values, g.y.values), 4)) for c in ['ml', 'trees', 'lr', 'nn', 'mkt']} for k, g in Tm.groupby(ph, observed=True)}
bins = np.linspace(0, 1, 11)
def calib(c):
    out = []
    for i in range(10):
        m_ = (Tm[c] >= bins[i]) & (Tm[c] < bins[i + 1] + (i == 9)); n = int(m_.sum())
        out.append(dict(lo=round(float(bins[i]), 1), n=n, said=round(float(Tm[c][m_].mean()), 3) if n else None, won=round(float(Tm.y[m_].mean()), 3) if n else None))
    return out
res['calib'] = {c: calib(c) for c in ['ml', 'trees', 'lr', 'nn', 'mkt']}
imp = M['trees'].feature_importance('gain'); res['importance'] = sorted([dict(f=f, gain=round(float(g / imp.sum()), 4)) for f, g in zip(M['F'], imp)], key=lambda r: -r['gain'])
V = d[va].copy(); V['ml'] = predict(M, va)['ml']; V = V[V.mkt.notna()]
best_w = min((w / 20 for w in range(21)), key=lambda w: LL(w * V.ml.values + (1 - w) * V.mkt.values, V.y.values))
res['blend'] = dict(w_ml=best_w, test=dict(ll=round(LL(best_w * Tm.ml.values + (1 - best_w) * Tm.mkt.values, Tm.y.values), 4)))
res['grid'] = {'chosen': {k: v for k, v in M['P'].items() if k in ('num_leaves', 'min_data_in_leaf', 'learning_rate')}}
json.dump(res, open(f'{outd}/wpml_{lg}_eval.json', 'w'), indent=1); print(json.dumps(res['overall']), file=sys.stderr)

# ---------- export ----------
def tree_out(t):
    nodes, leaves = [], []
    def walk(n):
        if 'leaf_value' in n: leaves.append(round(n['leaf_value'], 6)); return -len(leaves)
        i = len(nodes); nodes.append(None); l = walk(n['left_child']); r = walk(n['right_child'])
        # [feature, threshold (full precision: LightGBM splits at +-1e-35 around zero), left, right, this node's average]
        nodes[i] = [n['split_feature'], float(n['threshold']), l, r, round(n.get('internal_value', 0.0), 6)]; return i
    root = walk(t['tree_structure'])
    if root < 0: nodes.append([0, 1e300, root, root, leaves[-root - 1]])
    return {'n': nodes, 'l': leaves}
def export(Mx, booster, iters, extra):
    s1, c1 = Mx['lr'].named_steps['standardscaler'], Mx['lr'].named_steps['logisticregression']
    s2, c2 = Mx['nn'].named_steps['standardscaler'], Mx['nn'].named_steps['mlpclassifier']
    r = lambda a: np.round(np.asarray(a, dtype=float), 6).tolist()
    return {'feats': Mx['F'], 'momentum': 'run' in Mx['F'],
            'lr': {'feats': list(lr_x(Mx['X'].head(1)).columns), 'mean': r(s1.mean_), 'scale': r(s1.scale_), 'coef': r(c1.coef_[0]), 'b': round(float(c1.intercept_[0]), 6)},
            'nn': {'mean': r(s2.mean_), 'scale': r(s2.scale_), 'W': [r(w) for w in c2.coefs_], 'b': [r(b) for b in c2.intercepts_], 'act': 'relu'},
            'means': r(Mx['X'].mean().values),
            'trees': [tree_out(t) for t in booster.dump_model(num_iteration=iters)['tree_info']], **extra}
json.dump(export(M, M['trees'], M['iters'], {'league': lg, 'mode': 'test', 'trainedThrough': SPLIT['valid']}), open(f'{outd}/wpml_{lg}_test.json', 'w'), separators=(',', ':'))
# live model: every season, same settings, ~10% more trees for the extra data
allm = fit_all(M['F'], np.ones(len(d), bool), va)  # (the validation slice only steers early stopping of the refit)
allt = lgb.train(M['P'], lgb.Dataset(allm['X'], y), int(M['iters'] * 1.1))
model = export(allm, allt, None, {'league': lg, 'seasons': f"{int(d.season.min())}-{int(d.season.max())}", 'plays': int(len(d)), 'games': int(d.game.nunique()), 'chosen': chosen})
json.dump(model, open(f'{outd}/wpml_{lg}.json', 'w'), separators=(',', ':'))
smp = d.sample(2000, random_state=1); Xs = feats(smp, M['F'])
json.dump({'rows': smp[['diff', 'tl', 'posH', 'ytg', 'down', 'dist', 'toH', 'toA', 'spread', 'total', 'h2', 'run', 'last', 'ypp', 'tov']].to_dict('records'),
           'trees': allt.predict(Xs).round(6).tolist(), 'lr': allm['lr'].predict_proba(lr_x(Xs))[:, 1].round(6).tolist(), 'nn': allm['nn'].predict_proba(Xs)[:, 1].round(6).tolist()},
          open(f'{outd}/wpml_{lg}_parity.json', 'w'))
# anchor set for the server's online-learning guard: plays from the newest test season, never used for learning
anc = d[te].sample(min(4000, int(te.sum())), random_state=11)
json.dump({'rows': anc[['diff', 'tl', 'posH', 'ytg', 'down', 'dist', 'toH', 'toA', 'spread', 'total', 'h2', 'run', 'last', 'ypp', 'tov', 'y']].to_dict('records')}, open(f'{outd}/wpml_{lg}_anchor.json', 'w'), separators=(',', ':'))
print('wrote', lg, len(model['trees']), 'trees', file=sys.stderr)
