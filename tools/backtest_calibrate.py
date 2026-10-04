import json, numpy as np, sys
def logit(p): p=np.clip(p,0.004,0.996); return np.log(p/(1-p))
def sig(z): return 1/(1+np.exp(-z))
def feats(x,t): return np.stack([x, x*t, x*t*t],1)
def fit(p,y,t):
    m=~np.isnan(y.astype(float)) & ~np.isnan(p)
    p,y,t=p[m],y[m].astype(float),t[m]
    # symmetric: both orientations, so no intercept (the model shouldn't favor slot A)
    X=np.vstack([feats(logit(p),t),feats(-logit(p),t)]); Y=np.concatenate([y,1-y])
    keep=(Y==0)|(Y==1); X,Y=X[keep],Y[keep]
    w=np.array([1.0,0.0,0.0])
    for _ in range(50):
        z=X@w; q=sig(z); g=X.T@(Y-q); H=-(X*(q*(1-q))[:,None]).T@X - 1e-6*np.eye(3); w-=np.linalg.solve(H,g)
    return w
def apply(w,p,t): return sig(feats(logit(p),t)@w)
def brier(p,y): m=~np.isnan(y.astype(float))&~np.isnan(p); y=y[m].astype(float); p=p[m]; k=(y==0)|(y==1); return ((p[k]-y[k])**2).mean(), k.sum()
def arr(R,k): return np.array([np.nan if r[k] is None else r[k] for r in R],dtype=float)
tr=json.load(open(sys.argv[1])); te=json.load(open(sys.argv[2]))
out={}
for kind,pk,yk in [('win','w','yw'),('cover','c','yc'),('over','o','yo')]:
    w=fit(arr(tr,pk),arr(tr,yk),arr(tr,'t')); out[kind]=[round(float(x),4) for x in w]
    p,y,t=arr(te,pk),arr(te,yk),arr(te,'t')
    b0,n=brier(p,y); b1,_=brier(apply(w,p,t),y)
    line=f'{kind}: weights {out[kind]}  2025 Brier raw {b0:.5f} -> calibrated {b1:.5f} (n={n})'
    if kind=='win':
        v=arr(te,'v'); bv,_=brier(v,y); line+=f'  | Vegas WP {bv:.5f}'
        for lo,hi,lab in [(0,0.25,'Q1'),(0.25,0.5,'Q2'),(0.5,0.75,'Q3'),(0.75,1.01,'Q4')]:
            s=(t>=lo)&(t<hi); line+=f'\n    {lab}: raw {brier(p[s],y[s])[0]:.5f} cal {brier(apply(w,p[s],t[s]),y[s])[0]:.5f} vegas {brier(v[s],y[s])[0]:.5f}'
    else: line+=f'  | coin flip 0.25000'
    print(line)
json.dump(out,open(sys.argv[3],'w'))
