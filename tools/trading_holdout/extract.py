# Pulls the production engine and NFL tables out of public/nfl/game.html (the same way api/live.mjs does)
import re, json, os, sys
page = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'public', 'nfl', 'game.html')
h = open(page).read()
i = h.index('<script id="engine-src">') + len('<script id="engine-src">')
open('engine.js', 'w').write(h[i:h.index('</script>', i)])
D = json.loads(re.search(r'const DATA=(\{.*?\});\n', h, re.S).group(1))
json.dump(D, open('prod_nfl_data.json', 'w'))
# out-of-sample tables (built with MAXS=2024) take the production clock scale and rules
if os.path.exists('nfl_data_2024.json'):
    T = json.load(open('nfl_data_2024.json')); T['meta']['clockScale'] = D['meta']['clockScale']; T['rules'] = D['rules']
    json.dump(T, open('nfl_data_2024.json', 'w'), separators=(',', ':'))
print('ok')
