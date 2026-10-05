import fs from 'node:fs';
const P = (o) => ({ league: 'nfl', venue: 'Polymarket US', trade: { slug: 'x', outcome: 'YES' }, tier: 'low', phase: 'Q3 late', type: 'spread', price: 0.6, model: 0.65, why: { mid: 0.6 }, clock: 'Q3 1:00', ...o });
const picks = [
  P({ key: 'a', event: '1', sel: 'Sunday 1pm bet (won)', at: '2026-10-04T18:30:00Z', status: 'won', pl: 0.4 }),
  P({ key: 'b', event: '2', sel: 'Sunday 4pm bet voided by cleanup (lost)', at: '2026-10-04T21:30:00Z', status: 'void', voidedStatus: 'lost', voidReason: 'model was more than 10 points off', pl: -0.6 }),
  P({ key: 'c', event: '9', sel: 'DET +9.5 (last night)', at: '2026-10-05T01:21:00Z', status: 'lost', pl: -0.86 }),
  P({ key: 'd', event: '9', sel: 'Under 44.5 small edge (last night)', lean: true, at: '2026-10-05T02:10:00Z', status: 'won', pl: 0.5 }),
  P({ key: 'e', event: '9', sel: 'CAR to win steady (last night)', steady: true, at: '2026-10-05T02:30:00Z', status: 'won', pl: 0.25 }),
  P({ key: 'f', event: '9', sel: 'CAR −6.5 (last night, already voided)', at: '2026-10-05T01:47:00Z', status: 'void', voidedStatus: 'lost', voidReason: 'model was more than 10 points off' }),
];
fs.writeFileSync('data12/picks.json', JSON.stringify({ picks, auto: { 'nfl:9:low': { status: 'bet', at: '2026-10-05T02:00:00Z' }, 'nfl:2:low': { status: 'bet', at: '2026-10-04T21:00:00Z' } }, steady: { 'nfl:9': { at: '2026-10-05T02:30:00Z' } }, cleanupV: 2 }));
const { createPicks } = await import('/home/user/cfb_oct3-5-/api/picks.mjs');
const Pk = createPicks({ api: {}, dir: '/home/user/work/data12' });
for (const p of Pk.all()) console.log(p.sel.padEnd(42), p.status.padEnd(5), p.voidReason || '');
const r = Pk.report('nfl'); console.log('record now:', JSON.stringify(r.record), '| lean', JSON.stringify(r.lean.paper), '| steady', JSON.stringify(r.steady.paper.w + '-' + r.steady.paper.l));
console.log('removed list:', Pk.removed().map(x => `${x.sel} (${x.kind}, ${x.result}, gap ${x.gap})`));
process.exit(0);
