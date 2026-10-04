import pandas as pd, numpy as np, json, math
rng=np.random.default_rng(7)
df=pd.read_pickle('pbp.pkl')
import os
MAXS=int(os.environ.get('MAXS','2026'))
df=df[df.season_type.isin(['REG','POST'])&(df.season<=MAXS)].copy()
NOW=MAXS
YB=[0,5,10,20,35,50,65,80,100]
def distB(x): return 0 if x<=1 else 1 if x<=2 else 2 if x<=4 else 3 if x<=7 else 4 if x<=10 else 5
def ytgB(y):
    y=max(0,min(100,int(y)))
    for i in range(1,len(YB)):
        if y<=YB[i]: return i-1
    return len(YB)-2
def wt(season,half): return 0.5**((NOW-season)/half)

# ---------- scrimmage plays ----------
sc=df[df.play_type.isin(['run','pass','punt','field_goal'])&df.down.between(1,4)&df.yardline_100.between(1,99)&df.ydstogo.notna()].copy()
sc=sc[(sc.penalty!=1)|(sc.play_type.isin(['punt','field_goal']))]
sc=sc[sc.two_point_attempt!=1]
sc['margin']=sc.posteam_score-sc.defteam_score
sc['db']=sc.ydstogo.clip(lower=1).map(distB); sc['yb']=sc.yardline_100.map(ytgB)
def ctx(r_q,r_s,m):
    c=np.zeros(len(m),dtype=int)
    late=(r_q==4)&(r_s<=480)
    c[(late&(m<0)&(m>=-16)).values]=1; c[(late&(m>0)&(m<=16)).values]=2
    c[((r_q==2)&(r_s<=120)).values]=3
    return c
sc['cx']=ctx(sc.qtr,sc.quarter_seconds_remaining,sc.margin)
sc['cls']=np.where(sc.play_type=='punt','punt',np.where(sc.play_type=='field_goal','fg',np.where((sc['pass']==1)|(sc.qb_scramble==1)|(sc.sack==1),'pass','run')))

# ---------- play-calling: counts weighted toward recent seasons (4th-down decisions changed a lot after 2018) ----------
calls=sc[sc.season>=2006].copy(); calls['w']=wt(calls.season,3.0)
def rows(keys,minn):
    out={}
    g=calls.groupby(keys+['cls']).w.sum().unstack(fill_value=0)
    for idx,r in g.iterrows():
        idx=idx if isinstance(idx,tuple) else (idx,)
        n=r.sum()
        raw=calls_n.get(idx,0)
        if raw<minn: continue
        k='_'.join(str(int(v)) for v in idx)
        tot=r.sum(); scale=raw/tot if tot else 0  # report weighted shares, scaled to the real play count
        out[k]=[int(raw)]+[int(round(r.get(c,0)*scale)) for c in ['run','pass','punt','fg']]
    return out
k4={};k3={};k2={}
calls_n=calls.groupby(['down','db','yb','cx']).size().to_dict(); k4=rows(['down','db','yb','cx'],40)
calls_n=calls.groupby(['down','db','yb']).size().to_dict(); k3=rows(['down','db','yb'],20)
calls_n=calls.groupby(['down','db']).size().to_dict(); k2=rows(['down','db'],1)
print('calls',len(k4),len(k3),len(k2), len(calls))

# ---------- play outcome pools: every season since 1999, sampled with recency weights (half-life 6 seasons) ----------
pl=sc[sc.cls.isin(['run','pass'])].copy()
ret_td=(pl.return_touchdown==1)|((pl.touchdown==1)&(pl.td_team!=pl.posteam))
code=np.full(len(pl),'g',dtype=object); y=pl.yards_gained.fillna(0).astype(int).values.copy()
isP=(pl.cls=='pass').values
inc=(pl.incomplete_pass==1).values; sack=(pl.sack==1).values; it=(pl.interception==1).values; fl=(pl.fumble_lost==1).values; rtd=ret_td.values
code[isP&inc]='i'; y[isP&inc]=0
code[isP&sack]='s'
code[it]='x'; code[it&rtd]='X'; y[it]=0
code[fl&~it]='f'; code[fl&~it&rtd]='F'
td=((pl.touchdown==1)&(pl.td_team==pl.posteam)).values
y[td&(code=='g')]=pl.yardline_100.values[td&(code=='g')].astype(int)
y=np.clip(y,-30,99)
pl['code']=code; pl['y']=y; pl['dg']=(pl.down>=3).astype(int); pl['w']=wt(pl.season,6.0)
pools={}
def sample(g,cap):
    n=len(g)
    if n<=cap: idx=np.arange(n)
    else:
        p=g.w.values/g.w.values.sum(); idx=rng.choice(n,size=cap,replace=False,p=p)
    s=g.iloc[idx]; return [int(n)]+[[c,int(v)] for c,v in zip(s.code,s.y)]
for (dg,db,yb,cls),g in pl.groupby(['dg','db','yb','cls']):
    if len(g)>=40: pools[f'{dg}_{db}_{yb}_{cls}']=sample(g,600)
for (yb,cls),g in pl.groupby(['yb','cls']): pools[f'y{yb}_{cls}']=sample(g,800)
print('pools',len(pools),len(pl))

# ---------- clock: game seconds used by each play, 2018 on ----------
c=df.loc[df.season>=2018,['game_id','play_id','qtr','game_seconds_remaining','quarter_seconds_remaining','posteam_score','defteam_score']].sort_values(['game_id','play_id'])
c['next_gs']=c.groupby('game_id').game_seconds_remaining.shift(-1)
c['next_half']=c.groupby('game_id').qtr.shift(-1)
cc=c[c.index.isin(pl.index)].copy()
cc=cc.join(pl[['code','cls']])
cc['run']=cc.game_seconds_remaining-cc.next_gs
same_half=((cc.qtr<=2)&(cc.next_half<=2))|((cc.qtr.between(3,4))&(cc.next_half.between(3,4)))
cc=cc[same_half&cc.run.between(0,60)]
m=cc.posteam_score-cc.defteam_score
cc['h']=(((cc.qtr==4)&(m<0)&(cc.game_seconds_remaining<360))|((cc.qtr==2)&(cc.quarter_seconds_remaining<=120))).astype(int)
clk={}
for cls in ['run','pass']:
    for k in 'gisxXfF':
        for h in [0,1]:
            s=cc[(cc.cls==cls)&(cc.code==k)&(cc.h==h)].run
            if len(s)>=30: clk[f'{cls}_{k}_{h}']=round(float(s.median()),1)
print('clk',clk); del c, cc; import gc; gc.collect()

# ---------- field goals: logistic on kick distance, 2010 on, recency weighted ----------
fg=df[(df.field_goal_attempt==1)&df.kick_distance.notna()&(df.season>=2010)]
X=fg.kick_distance.values.astype(float); Y=(fg.field_goal_result=='made').values.astype(float); W=wt(fg.season.values,5.0)
a,b=4.0,-0.08
for _ in range(60):
    z=a+b*X; p=1/(1+np.exp(-z)); g1=np.sum(W*(Y-p)); g2=np.sum(W*(Y-p)*X)
    h11=-np.sum(W*p*(1-p)); h12=-np.sum(W*p*(1-p)*X); h22=-np.sum(W*p*(1-p)*X*X)
    H=np.array([[h11,h12],[h12,h22]]); step=np.linalg.solve(H,[g1,g2]); a-=step[0]; b-=step[1]
print('fg',a,b,[round(1/(1+math.exp(-(a+b*d))),3) for d in [30,40,50,55,60]])

# ---------- punts: net to the next snap, 2015 on ----------
c=df.loc[(df.season>=2015)&df.play_type.isin(['run','pass','punt','kickoff','field_goal','qb_kneel','qb_spike']),['game_id','play_id','season','yardline_100','posteam','defteam','punt_attempt','kickoff_attempt','penalty','punt_blocked','return_touchdown','play_type']].sort_values(['game_id','play_id'])
c['nyl']=c.groupby('game_id').yardline_100.shift(-1); c['npos']=c.groupby('game_id').posteam.shift(-1)
pu=c[(c.punt_attempt==1)&(c.season>=2015)&(c.penalty!=1)&(c.punt_blocked!=1)&(c.return_touchdown!=1)&c.nyl.notna()&(c.npos==c.defteam)]
net=(pu.nyl-(100-pu.yardline_100)).astype(int)  # landing spot in the kicking team's frame minus the punt spot
net=net[(net>-10)&(net<80)]
punt_net=[int(v) for v in rng.choice(net.values,400,replace=False)]
print('punt net mean',np.mean(punt_net))

# ---------- kickoffs: 2025 on (touchback to the 35 under the new kickoff rule) ----------
# nflfastR lists the receiving team as posteam on kickoff rows
ko=c[(c.kickoff_attempt==1)&(c.season>=min(2025,MAXS))&(c.penalty!=1)&(c.return_touchdown!=1)&c.nyl.notna()&(c.npos==c.posteam)]
kick=ko.nyl.astype(int); kick=kick[(kick>=30)&(kick<=99)]
kick=[int(v) for v in rng.choice(kick.values,400,replace=len(kick)<400)]
print('kick start (own yd line) mean',100-np.mean(kick), 'n',len(ko))

# ---------- conversion rates ----------
xp=df[(df.extra_point_attempt==1)&(df.season>=MAXS-3)]; P_XP=float((xp.extra_point_result=='good').mean())
tp=df[(df.two_point_attempt==1)&(df.season>=2015)]; P_2PT=float((tp.two_point_conv_result=='success').mean())
print('xp',P_XP,'2pt',P_2PT)

# ---------- team-form correlation (as in the CFB build): next-play EPA within the same team-game ----------
e=pl[(pl.season>=2015)&pl.epa.notna()][['game_id','posteam','epa']]
grp=e.groupby(['game_id','posteam']).epa
gm=grp.transform('mean'); n=grp.transform('size')
# intraclass correlation via one-way ANOVA
k=e.groupby(['game_id','posteam']).size(); N=len(e); G=len(k)
msb=((e.groupby(['game_id','posteam']).epa.mean()-e.epa.mean())**2*k).sum()/(G-1)
msw=((e.epa-gm)**2).sum()/(N-G); n0=(N-(k**2).sum()/N)/(G-1)
rho=float((msb-msw)/(msb+(n0-1)*msw)); print('rho',rho)

# ---------- real snaps per game (target for the clock scale) ----------
rs=df[(df.season>=2018)&df.play_type.isin(['run','pass','punt','field_goal','qb_kneel','qb_spike'])&(df.qtr<=4)&(df.penalty!=1)&(df.two_point_attempt!=1)]
snaps=float(rs.groupby('game_id').size().mean()); print('snaps/game',snaps)

# ---------- final margin around the closing spread ----------
gms=df.drop_duplicates('game_id'); gms=gms[gms.spread_line.notna()&(gms.season>=2010)]
resid=(gms.result-gms.spread_line); print('margin SD around spread',resid.std(), 'total SD',(gms.total-gms.total_line).std())

def team(abbr,season=2026):
    t=df[(df.season==season)&(df.posteam==abbr)]
    sc2=t[t.play_type.isin(['run','pass'])&(t.two_point_attempt!=1)]
    qbs=sc2[sc2['pass']==1].passer_player_name.value_counts().head(3)
    ru=sc2[(sc2.rush==1)&sc2.rusher_player_name.notna()]
    rz=ru[ru.yardline_100<=10].rusher_player_name.value_counts()
    rush=[[nm,int(cn),int(ru[ru.rusher_player_name==nm].yards_gained.sum()),int(rz.get(nm,0))] for nm,cn in ru.rusher_player_name.value_counts().head(7).items()]
    rc=sc2[(sc2['pass']==1)&sc2.receiver_player_name.notna()]
    recv=[[nm,int(cn),int(rc[(rc.receiver_player_name==nm)&(rc.complete_pass==1)].shape[0]),int(rc[(rc.receiver_player_name==nm)&(rc.complete_pass==1)].yards_gained.sum())] for nm,cn in rc.receiver_player_name.value_counts().head(10).items()]
    games=t.game_id.nunique()
    opp=sorted(set(t.defteam.dropna()))
    return {'qbs':[[nm,int(v)] for nm,v in qbs.items()],'rush':rush,'recv':recv,'games':int(games),'plays':int(len(sc2)),
            'ypp':round(float(sc2.yards_gained.mean()),2),'passrate':round(float((sc2['pass']==1).mean()),3),'opps':opp}
teams={'ND':team('KC',MAXS),'UNC':team('BUF',MAXS)}
outcome_years=f"{int(pl.season.min())}\u2013{int(pl.season.max())}"
D={'YB':YB,'calls':{'k4':k4,'k3':k3,'k2':k2},'pools':pools,'clk':clk,'fg':[round(a,4),round(b,5)],
   'punt':{'net':punt_net,'gross_land':punt_net},'kick':kick,'teams':teams,
   'rules':{'ot':'nfl','twoMin':True,'xp':round(P_XP,3),'two':round(P_2PT,3),'fgMax':66},
   'meta':{'rho':round(rho,4),'plays':int(len(pl)),'games':int(pl.game_id.nunique()),'years':outcome_years,'callPlays':int(len(calls)),
           'clockScale':1.0,'snaps':round(snaps,1),'sig':round(float(resid.std()),2)}}
json.dump(D,open(os.environ.get('OUT','nfl_data.json'),'w'),separators=(',',':'))
print('size',len(json.dumps(D,separators=(',',':'))))
