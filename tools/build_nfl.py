"""Generate public/nfl/game.html from public/game.html: same app, NFL model tables and settings.
Run after any change to game.html:  python3 tools/build_nfl.py
"""
import json, re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
src = (root / 'public' / 'game.html').read_text()
data = json.loads((root / 'tools' / 'nfl_data.json').read_text())
m = data['meta']

NFL_LG = ("const LG={id:'nfl',api:'/api/nfl',home:'/nfl',game:'/nfl/game',level:'NFL',gamesLabel:'NFL games',"
          "sig:13.0,cal:{a:42.2,b:0,k:1.345,d:36.2}};")
out, n = re.subn(r"const LG=\{id:'cfb'.*?\};", lambda _: NFL_LG, src, count=1); assert n == 1
out, n = re.subn(r"const DATA=\{.*?\};\n", lambda _: 'const DATA=' + json.dumps(data, separators=(',', ':')) + ';\n', out, count=1, flags=re.S); assert n == 1
swaps = [
  ('converted with a 15.5-point standard deviation around the spread)', 'converted with a 13-point standard deviation around the spread)'),
  ('At 5.5, pregame margins scatter about 15.5 points around the spread, in line with the 15 to 16 points seen in real college games.',
   'At 5.5, pregame margins scatter about 13 points around the spread, matching the 13.0 seen in NFL games since 2010.'),
  ('Source: SportsDataverse / cfbfastR play-by-play (collegefootballdata.com).',
   f"Source: nflverse / nflfastR play-by-play, {m['years']} ({m['plays']:,} plays, {m['games']:,} games). Play results weight recent seasons more; play calling leans hardest on recent seasons since 4th-down aggressiveness jumped after 2018; kickoffs use 2025 on, after the touchback moved to the 35."),
  ('15.5 points around the spread. ${', '13 points around the spread. ${'),
  ('CFB Live Sim', 'NFL Live Sim'),
]
for a, b in swaps:
    assert a in out, a[:60]
    out = out.replace(a, b)
(root / 'public' / 'nfl').mkdir(exist_ok=True)
(root / 'public' / 'nfl' / 'game.html').write_text(out)
print('wrote public/nfl/game.html', len(out))
