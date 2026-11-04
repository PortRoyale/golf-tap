/**
 * Proofs for the self-fitting physics learner.
 * The "simulator" here is a hidden set of coefficients the learner never sees;
 * it must recover them from (launch, landing) pairs alone.
 *   node --test --no-warnings physics.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from './physics.ts';

function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const g = () => { let x = 0; while (x === 0) x = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * u()); };
  return { u, g };
}
const MPH = 0.44704;
const HIDDEN = { shape: 'sat5', x: [0.235, 0.21, 0.34, 0.155, 23] };
const sim = (L: P.Launch, h = HIDDEN) => { const sh = P.SHAPES.find(s => s.id === h.shape)!; return P.flyWith(L, sh.coef(h.x), sh.tau(h.x), 0.002); };
const round = (m: number) => Math.round((m / 0.9144) * 10) / 10 * 0.9144; // the simulator reports 0.1 yd

const CLUBS: [string, number, number, number][] = [ // ball mph, launch, spin
  ['DR', 160, 12.5, 2700], ['3W', 150, 11, 3600], ['5I', 128, 13, 5200], ['7I', 118, 16.5, 6800],
  ['9I', 106, 21, 8400], ['PW', 98, 25, 9000], ['SW', 80, 31, 9500], ['half', 60, 32, 7200],
];

function practice(R: ReturnType<typeof rng>, n: number, h = HIDDEN): P.Pair[] {
  const out: P.Pair[] = [];
  for (let i = 0; i < n; i++) {
    const [club, v, la, sp] = CLUBS[i % CLUBS.length];
    const L = { ballSpeed: v * MPH * (1 + 0.03 * R.g()), vla: la + 1.5 * R.g(), hla: 2.5 * R.g(), spin: sp * (1 + 0.1 * R.g()), spinAxis: 7 * R.g() };
    const f = sim(L, h);
    out.push({ L, carry: round(f.carry), offline: round(f.offline), group: `${club}-${Math.floor(i / (CLUBS.length * 10))}`, D: round(sim({ ...L, hla: 0, spinAxis: 0, ballSpeed: v * MPH, vla: la, spin: sp }, h).carry) });
  }
  return out;
}

const report: string[] = [];

test('flight: deterministic, and directions mean what they say', () => {
  const sh = P.SHAPES[0], c = sh.coef(HIDDEN.x), t = sh.tau(HIDDEN.x);
  const L = { ballSpeed: 50, vla: 16, hla: 0, spin: 6500, spinAxis: 0 };
  assert.deepEqual(P.flyWith(L, c, t), P.flyWith(L, c, t));
  assert.ok(Math.abs(P.flyWith(L, c, t).offline) < 1e-9, 'straight in, straight out');
  assert.ok(P.flyWith({ ...L, hla: 3 }, c, t).offline > 0, 'HLA + starts right');
  assert.ok(P.flyWith({ ...L, spinAxis: 10 }, c, t).offline > 0, 'axis + curves right');
  assert.ok(P.flyWith({ ...L, spinAxis: -10 }, c, t).offline < 0, 'axis - curves left');
  const fine = P.flyWith(L, c, t, 0.0005), coarse = P.flyWith(L, c, t, 0.002);
  assert.ok(Math.abs(fine.carry - coarse.carry) < 0.02, 'integration step does not matter at 2 ms');
});

test('learner: recovers hidden coefficients from 240 practice shots, including curve and spin decay', () => {
  const R = rng(31);
  const train = practice(R, 240);
  const fit = P.learn(train, 'hidden-sim');
  const errs = fit.names.map((n, i) => `${n} ${(100 * (fit.x[i] / HIDDEN.x[i] - 1)).toFixed(1)}%`);
  report.push(`learned shape ${fit.shape} (hidden: sat5); coefficient error vs hidden: ${errs.join(', ')}`);
  report.push(`held-out error: carry ${(fit.cvCarryRms / 0.9144).toFixed(2)} yd, offline ${(fit.cvOfflineRms / 0.9144).toFixed(2)} yd; most tangled pair ${fit.maxCorrPair} r=${fit.maxCorr.toFixed(2)}; all identified: ${fit.identified.every(Boolean)}`);
  report.push(`other shapes held-out carry/offline (yd): ${fit.shapes.map(s => `${s.shape} ${(s.cvCarryRms / 0.9144).toFixed(2)}/${(s.cvOfflineRms / 0.9144).toFixed(2)}`).join(', ')}`);
  assert.equal(fit.shape, 'sat5');
  fit.x.forEach((v, i) => assert.ok(Math.abs(v / HIDDEN.x[i] - 1) < 0.05, `${fit.names[i]} off by ${(100 * (v / HIDDEN.x[i] - 1)).toFixed(1)}%`));
  assert.ok(fit.identified.every(Boolean));
  assert.ok(fit.cvCarryRms < 0.5 && fit.cvOfflineRms < 0.3);
  // Unseen shots, unseen clubs-in-between.
  const test2 = practice(rng(32), 80);
  let worst = 0;
  for (const p of test2) worst = Math.max(worst, Math.abs(P.flyFit(p.L, fit).offline - p.offline), Math.abs(P.flyFit(p.L, fit).carry - p.carry));
  report.push(`worst miss on 80 fresh shots: ${(worst / 0.9144).toFixed(2)} yd`);
  assert.ok(worst < 1.5);

  const g = P.gate(train, fit);
  report.push(`promotion gate: ${g.sets} sets, ${(100 * g.passRate).toFixed(0)}% within a quarter of their own error bar, median rating shift ${g.medianShift.toFixed(2)} pts, worst ${g.worstShift.toFixed(2)} pts -> ${g.promotable ? 'PROMOTE' : 'stay in shadow'}`);
  assert.ok(g.promotable);

  const same = P.detectChange(practice(rng(33), 40), fit);
  const changed = P.detectChange(practice(rng(34), 40, { shape: 'sat5', x: [0.235 * 1.06, 0.21, 0.34, 0.155, 23] }), fit);
  report.push(`change detector: same sim z=${same.z.toFixed(1)} (${same.changed ? 'FLAGGED' : 'quiet'}); sim with 6% more drag z=${changed.z.toFixed(1)}, mean carry shift ${(changed.meanCarryErr / 0.9144).toFixed(1)} yd (${changed.changed ? 'FLAGGED' : 'missed'})`);
  assert.equal(same.changed, false);
  assert.equal(changed.changed, true);
});

test('learner: a different hidden shape is found or matched, never forced into the wrong one', () => {
  const H = { shape: 'pow5', x: [0.24, 0.18, 0.62, 0.55, 26] };
  const train = practice(rng(35), 200, H);
  const fit = P.learn(train, 'hidden-sim-2');
  report.push(`hidden pow5: learner chose ${fit.shape}, held-out carry ${(fit.cvCarryRms / 0.9144).toFixed(2)} yd, offline ${(fit.cvOfflineRms / 0.9144).toFixed(2)} yd`);
  assert.ok(fit.cvCarryRms < 0.5 && fit.cvOfflineRms < 0.3);
});

test('learner: too few shots is refused, and few shots are flagged as unidentified', () => {
  assert.throws(() => P.learn(practice(rng(36), 10), 'x'));
  // 20 shots of one club only: speed/spin range too narrow to separate drag terms.
  const R = rng(37);
  const narrow: P.Pair[] = Array.from({ length: 20 }, () => {
    const L = { ballSpeed: 118 * MPH * (1 + 0.005 * R.g()), vla: 16.5, hla: 0.3 * R.g(), spin: 6800, spinAxis: 0.5 * R.g() };
    const f = sim(L); return { L, carry: round(f.carry), offline: round(f.offline) };
  });
  const f = P.fitShape(P.SHAPES[0], narrow);
  report.push(`one club, 20 shots: identified ${f.names.map((n, i) => `${n}:${f.identified[i] ? 'yes' : 'NO'}`).join(' ')}`);
  assert.ok(f.identified.some(x => !x), 'must admit what one club cannot pin down');
});

test.after(() => { console.log('\n---- physics proof summary ----'); for (const r of report) console.log('  ' + r); });
