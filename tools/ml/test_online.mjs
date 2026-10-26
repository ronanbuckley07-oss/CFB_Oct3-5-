// Live learning layer: learns from finished games, guarded.  node tools/ml/test_online.mjs
import assert from 'node:assert'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createOnline } from '../../api/wponline.mjs';
import { wpProb, loadWp } from '../../api/wpml.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onl-')), O = createOnline({ dataDir: dir }), m = loadWp('cfb');
let r = 1; const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
// 1. Games where the plain model is right: the layer barely moves and stays off
for (let gi = 0; gi < 6; gi++) { const st = [], y = rnd() < 0.5 ? 1 : 0;
  for (let k = 0; k < 40; k++) st.push({ diff: (y ? 1 : -1) * Math.round(k / 4), tl: 3600 - k * 80, posH: 1, ytg: 60, down: 1, dist: 10, toH: 3, toA: 3, spread: 0, total: 52, h2: 0, run: 0, last: 0, ypp: 0, tov: 0 });
  O.learn('cfb', st, y, { event: 'a' + gi }); }
let s = O.summary('cfb'); assert.equal(s.games, 6); assert.ok(Math.abs(s.w[2]) < 0.05, 'no momentum weight without momentum signal');
// 2. A run of games where a big scoring run means the home team came back to win: the run weight grows (positive)
for (let gi = 0; gi < 30; gi++) { const st = [];
  for (let k = 0; k < 40; k++) st.push({ diff: -3, tl: 1800 - k * 30, posH: 1, ytg: 50, down: 1, dist: 10, toH: 3, toA: 3, spread: 0, total: 52, h2: 0, run: 14, last: 1, ypp: 4, tov: 1 });
  O.learn('cfb', st, 1, { event: 'b' + gi }); }
s = O.summary('cfb'); console.log('weights after momentum games:', s.names.map((n, i) => `${n} ${s.w[i]}`).join(', '), '| on:', s.on, '| prequential', JSON.stringify(s.preq));
assert.ok(s.w[2] > 0 || s.history.some(h => !h.accepted), 'learns a positive run weight, or the anchor guard refuses to');
// 3. The guard: anchor log loss never gets worse than the plain model's by more than 0.002 for accepted updates
for (const h of s.history.filter(h => h.accepted && h.anchorBase != null)) assert.ok(h.anchorNew <= h.anchorBase + 0.002 + 1e-9);
// 4. correct() only changes the answer once the layer is on
const st0 = { diff: -3, tl: 900, posH: 1, ytg: 50, down: 1, dist: 10, toH: 3, toA: 3, spread: 0, total: 52, h2: 0, run: 14, last: 1, ypp: 4, tov: 1 }, base = wpProb(m, st0);
assert.equal(O.correct('cfb', st0, base) === base, !s.on, 'correction applies only when on');
// 5. persisted
assert.equal(createOnline({ dataDir: dir }).summary('cfb').games, 36);
console.log('ok: plain model ->', base.toFixed(3), '| with live-learned correction ->', O.raw('cfb', st0, base).toFixed(3), '| accepted', s.history.filter(h => h.accepted).length, 'of', s.history.length);
process.exit(0);
