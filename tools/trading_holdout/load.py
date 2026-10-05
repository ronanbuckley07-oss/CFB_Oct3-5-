import pandas as pd, pyarrow.parquet as pq, glob, re
import os
src=open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','load_nflverse.py')).read()
cols=eval(re.search(r"cols=(\[.*?\])",src,re.S).group(1))
extra=['vegas_home_wp','home_wp','quarter_end','home_timeouts_remaining','away_timeouts_remaining','total_home_score','total_away_score','week']
fr=[]
for f in sorted(glob.glob('raw/pbp_*.parquet')):
    t=pq.read_table(f); use=[c for c in dict.fromkeys(cols+extra) if c in t.column_names]
    fr.append(t.select(use).to_pandas())
df=pd.concat(fr,ignore_index=True); df.to_pickle('pbp.pkl'); print(len(df),df.season.min(),df.season.max())
