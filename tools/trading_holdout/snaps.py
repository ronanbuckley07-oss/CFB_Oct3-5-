# Every scrimmage snap of 2025 + 2026 games, as engine states (home team = 'ND' slot), with nflfastR's Vegas WP as the market.
import pandas as pd, numpy as np, json
df=pd.read_pickle('pbp.pkl'); df=df[(df.season>=2025)&df.season_type.isin(['REG','POST'])].copy()
df=df.sort_values(['game_id','play_id'])
df['hs']=df.groupby('game_id').total_home_score.shift(1).fillna(0); df['as_']=df.groupby('game_id').total_away_score.shift(1).fillna(0)
out=[]
for gid,g in df.groupby('game_id'):
    g0=g.iloc[0]
    if pd.isna(g0.home_score) or pd.isna(g0.spread_line): continue
    k=g[g.play_type.isin(['run','pass','punt','field_goal'])&g.down.between(1,4)&g.qtr.between(1,4)&g.vegas_home_wp.notna()&g.yardline_100.between(1,99)&g.posteam.notna()]
    if len(k)<40: continue
    first=k.iloc[0]; h2='UNC' if first.posteam==first.home_team else 'ND'
    for r in k.itertuples():
        poss='ND' if r.posteam==r.home_team else 'UNC'
        out.append(dict(g=gid,season=int(r.season),week=int(r.week),home=r.home_team,away=r.away_team,poss=poss,pos=int(100-r.yardline_100),down=int(r.down),
          dist=int(max(1,min(r.ydstogo,r.yardline_100))),qtr=int(r.qtr),secs=int(r.quarter_seconds_remaining),nd=int(r.hs),unc=int(r.as_),
          toND=int(r.home_timeouts_remaining),toUNC=int(r.away_timeouts_remaining),half2Recv=h2,v=round(float(r.vegas_home_wp),4),
          spread=float(g0.spread_line),totalLine=float(g0.total_line),hf=int(g0.home_score),af=int(g0.away_score)))
json.dump(out,open('holdout_snaps.json','w')); print(len(out), len({o['g'] for o in out}))
