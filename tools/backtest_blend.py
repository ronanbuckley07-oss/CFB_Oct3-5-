import json, numpy as np
def logit(p): p=np.clip(p,0.004,0.996); return np.log(p/(1-p))
def sig(z): return 1/(1+np.exp(-z))
def L(path):
    R=json.load(open(path)); a=lambda k: np.array([r[k] for r in R],dtype=float)
    return a('w'),a('v'),a('yw'),a('t'),np.array([r['g'] for r in R])
def X_of(m,v,t,kind):
    lm,lv=logit(m),logit(v)
    if kind=='const': return np.stack([lm,lv],1)
    return np.stack([lm,lv,lm*t,lv*t],1)
def fit(X,y):
    k=(y==0)|(y==1); X=np.vstack([X[k],-X[k]]); Y=np.concatenate([y[k],1-y[k]]); w=np.zeros(X.shape[1]); w[0]=0.5; w[1]=0.5
    for _ in range(60):
        q=sig(X@w); g=X.T@(Y-q); H=-(X*(q*(1-q))[:,None]).T@X-1e-6*np.eye(len(w)); w-=np.linalg.solve(H,g)
    return w
def br(p,y): k=(y==0)|(y==1); return ((p[k]-y[k])**2).mean()
m4,v4,y4,t4,g4=L('/tmp/raw24_e4.json'); m5,v5,y5,t5,g5=L('/tmp/raw25_e4.json')
print('2025 Brier: model',round(br(m5,y5),5),'vegas',round(br(v5,y5),5),'simple 50/50 average',round(br((m5+v5)/2,y5),5))
for kind in ['const','time']:
    w=fit(X_of(m4,v4,t4,kind),y4); p=sig(X_of(m5,v5,t5,kind)@w)
    print(kind,'weights',np.round(w,3),'-> 2025 Brier',round(br(p,y5),5))
# bootstrap by game: is the 50/50 blend reliably better than Vegas alone?
games=np.unique(g5); rng=np.random.default_rng(1); diffs=[]
idx={g:np.where(g5==g)[0] for g in games}
for _ in range(400):
    s=np.concatenate([idx[g] for g in rng.choice(games,len(games))])
    diffs.append(br(v5[s],y5[s])-br(((m5+v5)/2)[s],y5[s]))
diffs=np.array(diffs); print('blend better than Vegas in',round((diffs>0).mean()*100),'% of resamples; mean gain',round(diffs.mean(),5))
# calibration table of the raw model on 2025
bins=np.linspace(0,1,11); k=(y5==0)|(y5==1)
print('raw model calibration 2025 (predicted -> actual, n):',[(round(m5[k][(m5[k]>=lo)&(m5[k]<hi)].mean(),2),round(y5[k][(m5[k]>=lo)&(m5[k]<hi)].mean(),2),int(((m5[k]>=lo)&(m5[k]<hi)).sum())) for lo,hi in zip(bins[:-1],bins[1:])])
