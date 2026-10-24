# Downloads the sportsdataverse cfb_schedules releases (ESPN data: every FBS game with both teams' poll rank at kickoff)
# and writes the compact games.json that tools/ap/build.mjs reads.  python3 tools/ap/fetch.py [first_season] [last_season]
import sys, json, math, urllib.request, io
import pyarrow.parquet as pq
a, b = (int(sys.argv[1]) if len(sys.argv) > 1 else 2010), (int(sys.argv[2]) if len(sys.argv) > 2 else 2026)
out = []
nz = lambda v: None if v is None or (isinstance(v, float) and math.isnan(v)) else v
for y in range(a, b + 1):
    raw = urllib.request.urlopen(f'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/cfb_schedules/cfb_schedules_{y}.parquet', timeout=60).read()
    d = pq.read_table(io.BytesIO(raw)).to_pandas()
    d = d[(d.season_type == 'regular') & ((d.home_division == 'fbs') | (d.away_division == 'fbs'))]
    for r in d.itertuples():
        done = bool(r.completed) and nz(r.home_points) is not None
        out.append([int(r.season), int(r.week), str(r.start_date)[:10], int(r.home_id), r.home_team, nz(r.home_conference), nz(r.home_division), int(r.away_id), r.away_team, nz(r.away_conference), nz(r.away_division),
                    int(r.home_points) if done else None, int(r.away_points) if done else None, 1 if r.neutral_site else 0,
                    None if nz(r.home_rank) is None else int(r.home_rank), None if nz(r.away_rank) is None else int(r.away_rank), str(r.game_id)])
    print(y, len(d), file=sys.stderr)
json.dump(out, open('games.json', 'w'), separators=(',', ':'))
