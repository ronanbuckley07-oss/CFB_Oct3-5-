# Download first: for y in $(seq 1999 2026); do curl -sL -o raw/pbp_$y.csv.gz https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_$y.csv.gz; done
import pandas as pd, glob, time
cols=['game_id','season','season_type','week','posteam','defteam','home_team','away_team','play_type','down','ydstogo','yardline_100','qtr',
'quarter_seconds_remaining','half_seconds_remaining','game_seconds_remaining','posteam_score','defteam_score','yards_gained','pass','rush','qb_kneel',
'qb_spike','qb_scramble','sack','interception','incomplete_pass','complete_pass','fumble_lost','touchdown','td_team','return_touchdown','kick_distance',
'field_goal_result','extra_point_result','two_point_conv_result','two_point_attempt','extra_point_attempt','field_goal_attempt','punt_attempt',
'kickoff_attempt','own_kickoff_recovery','onside_kick','epa','penalty','play_id','drive','fixed_drive','rusher_player_name','receiver_player_name',
'passer_player_name','home_score','away_score','result','total','spread_line','total_line','aborted_play','timeout','touchback','punt_blocked','safety','play_deleted']
t=time.time(); fr=[]
for f in sorted(glob.glob('raw/pbp_*.csv.gz')):
    h=pd.read_csv(f,nrows=0).columns
    use=[c for c in cols if c in h]
    d=pd.read_csv(f,usecols=use,low_memory=False)
    fr.append(d); print(f,len(d),round(time.time()-t))
df=pd.concat(fr,ignore_index=True)
df.to_pickle('pbp.pkl'); print(len(df), df.season.min(), df.season.max())
