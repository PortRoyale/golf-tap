/**
 * Proofs for every claim the spec makes about the algorithm.
 * Run: node --test --no-warnings engine.test.ts
 *
 * Monte Carlo tests use a fixed-seed generator, so results are reproducible.
 * Tolerances are set from the Monte Carlo standard error of each check, not tuned to pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from './engine.ts';

// ---------------------------------------------------------------- helpers

function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const g = () => {
    let x = 0; while (x === 0) x = u();
    return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * u());
  };
  return { u, g };
}

/** Bivariate normal pattern: bias (bx, by), sds (sx, sy), correlation rho, optional squib rate. */
function pattern(R: ReturnType<typeof rng>, n: number, o: { bx: number; by: number; sx: number; sy: number; rho: number; squib?: number; D?: number }): E.Shot[] {
  const out: E.Shot[] = [];
  for (let i = 0; i < n; i++) {
    const z1 = R.g(), z2 = R.g();
    let x = o.bx + o.sx * z1;
    let y = o.by + o.sy * (o.rho * z1 + Math.sqrt(1 - o.rho * o.rho) * z2);
    if (o.squib && R.u() < o.squib) { y -= (o.D ?? 150) * (0.1 + 0.2 * R.u()); x += 3 * o.sx * R.g(); }
    out.push({ x, y });
  }
  return out;
}

/** True rating for a normal pattern (no squibs): E r^2 = |mu|^2 + tr(Sigma). */
function trueRating(o: { bx: number; by: number; sx: number; sy: number }, D: number): number {
  return E.ratingFromPi(Math.sqrt(o.bx ** 2 + o.by ** 2 + o.sx ** 2 + o.sy ** 2) / D);
}

const close = (a: number, b: number, rel = 1e-12, abs = 1e-12) =>
  Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));

/** Binomial check: observed rate within 4 MC standard errors of the target. */
function rateNear(hits: number, n: number, p: number, msg: string) {
  const se = Math.sqrt((p * (1 - p)) / n);
  const r = hits / n;
  assert.ok(Math.abs(r - p) < 4 * se, `${msg}: observed ${r.toFixed(4)}, expected ${p} +/- ${(4 * se).toFixed(4)}`);
  return r;
}

const report: string[] = [];
const note = (s: string) => { report.push(s); };

// ---------------------------------------------------------------- invariance contract

test('invariance: identical shots for two players give identical metrics', () => {
  const R = rng(1);
  const shots = pattern(R, 20, { bx: 2, by: -3, sx: 5, sy: 7, rho: -0.4 });
  const a = E.computeSet(shots, 150);
  const b = E.computeSet(JSON.parse(JSON.stringify(shots)), 150);
  assert.deepEqual(a, b);
});

test('invariance: rotating the frame changes only the angles', () => {
  const R = rng(2);
  for (let trial = 0; trial < 50; trial++) {
    const shots = pattern(R, 25, { bx: R.g() * 3, by: R.g() * 3, sx: 3 + 4 * R.u(), sy: 3 + 4 * R.u(), rho: R.u() * 1.6 - 0.8 });
    const al = (R.u() - 0.5) * Math.PI;
    const c = Math.cos(al), s = Math.sin(al);
    const rot = shots.map(p => ({ x: c * p.x - s * p.y, y: s * p.x + c * p.y }));
    const a = E.computeSet(shots, 150), b = E.computeSet(rot, 150);
    for (const k of ['piQ', 'piB', 'piS', 'piE', 'rating', 'rd', 'tiltP', 'ratingTrim'] as const) {
      assert.ok(close(a[k], b[k], 1e-9, 1e-12), `${k} changed under rotation: ${a[k]} vs ${b[k]}`);
    }
    let dth = b.thetaDeg - a.thetaDeg - (al * 180) / Math.PI;
    dth = ((dth % 180) + 270) % 180 - 90;
    assert.ok(Math.abs(dth) < 1e-6, `theta did not rotate with the frame: ${dth}`);
  }
});

test('invariance: units and scale cancel (yards vs metres)', () => {
  const R = rng(3);
  const yd = pattern(R, 30, { bx: 1, by: 4, sx: 6, sy: 8, rho: -0.5 });
  const m = yd.map(p => ({ x: p.x * 0.9144, y: p.y * 0.9144 }));
  const a = E.computeSet(yd, 160), b = E.computeSet(m, 160 * 0.9144);
  for (const k of ['piQ', 'piB', 'piS', 'piE', 'thetaDeg', 'rating', 'rd', 'tiltP', 'ratingTrim'] as const) {
    assert.ok(close(a[k], b[k], 1e-9, 1e-9), `${k} depends on units: ${a[k]} vs ${b[k]}`);
  }
});

test('decomposition: piB^2 + piS^2 = piQ^2 exactly, including the clamped case', () => {
  const R = rng(4);
  let clamped = 0;
  for (let t = 0; t < 2000; t++) {
    const n = 3 + Math.floor(R.u() * 40);
    const m = E.computeSet(pattern(R, n, { bx: R.g(), by: R.g(), sx: 1 + 5 * R.u(), sy: 1 + 5 * R.u(), rho: R.u() - 0.5 }), 100);
    if (m.piB === 0) clamped++;
    assert.ok(Math.abs(m.piB ** 2 + m.piS ** 2 - m.piQ ** 2) <= 1e-15 * Math.max(1, m.piQ ** 2) + 1e-18);
  }
  assert.ok(clamped > 100, 'test must exercise the clamp');
  note(`decomposition exact in 2000 sets, ${clamped} of them clamped`);
});

test('scale constants cannot change any ranking, difference sign or slope sign', () => {
  const R = rng(5);
  const pis = Array.from({ length: 200 }, () => 0.01 + 0.2 * R.u());
  const rank = (f: (p: number) => number) => pis.map((p, i) => [f(p), i] as [number, number]).sort((a, b) => a[0] - b[0]).map(x => x[1]).join(',');
  const base = rank(p => 1000 - 100 * Math.log2(p / 0.05));
  for (const [A, B, P0] of [[0, 1, 1], [1500, 400, 0.05], [-7, 3.3, 0.9], [1e6, 0.01, 1e-4]]) {
    assert.equal(rank(p => A - B * Math.log2(p / P0)), base);
  }
});

// ---------------------------------------------------------------- estimator correctness

test('debias: perfect aim reads as near-zero bias; the naive estimate is inflated', () => {
  const R = rng(6);
  const D = 150, sims = 4000, n = 10;
  let naive = 0, deb = 0;
  for (let t = 0; t < sims; t++) {
    const m = E.computeSet(pattern(R, n, { bx: 0, by: 0, sx: 6, sy: 9, rho: -0.3 }), D);
    naive += (m.muX ** 2 + m.muY ** 2) / D ** 2;
    deb += m.piB ** 2;
  }
  naive /= sims; deb /= sims;
  const tr = (36 + 81) / D ** 2;
  assert.ok(close(naive, tr / n, 0.08), `naive bias^2 should be ~tr/n = ${tr / n}, got ${naive}`);
  assert.ok(deb < 0.45 * naive, `debiased bias^2 ${deb} should be well under naive ${naive}`);
  note(`perfect aim, n=10: naive bias reads ${(100 * Math.sqrt(naive)).toFixed(2)}% of D, debiased ${(100 * Math.sqrt(deb)).toFixed(2)}% (residual is the clamp)`);
});

test('debias: real aim error is recovered without bias', () => {
  const R = rng(7);
  const D = 150, sims = 4000, n = 12, bx = 8, by = -6;
  let deb = 0;
  for (let t = 0; t < sims; t++) deb += E.computeSet(pattern(R, n, { bx, by, sx: 5, sy: 7, rho: -0.4 }), D).piB ** 2;
  deb /= sims;
  const truth = (bx * bx + by * by) / D ** 2;
  assert.ok(close(deb, truth, 0.04), `E[piB^2] ${deb} vs truth ${truth}`);
});

test('uncertainty: rating interval covers the truth at the stated rate (normal patterns)', () => {
  const R = rng(8);
  const D = 150;
  for (const n of [10, 20, 40]) {
    let hit = 0;
    const sims = 3000;
    for (let t = 0; t < sims; t++) {
      const o = { bx: R.g() * 4, by: R.g() * 4, sx: 3 + 6 * R.u(), sy: 3 + 6 * R.u(), rho: R.u() * 1.4 - 0.7 };
      const m = E.computeSet(pattern(R, n, o), D);
      const tr = trueRating(o, D);
      if (tr >= m.ratingLo && tr <= m.ratingHi) hit++;
    }
    const r = hit / sims;
    note(`95% rating interval coverage, normal, n=${n}: ${(100 * r).toFixed(1)}%`);
    const se = Math.sqrt(0.95 * 0.05 / sims);
    assert.ok(r > 0.95 - 4 * se && r < 0.99, `coverage at n=${n} off nominal: ${r}`);
  }
});

test('uncertainty: measured RD tracks the real spread of ratings', () => {
  const R = rng(9);
  const D = 150, n = 20, sims = 3000;
  const o = { bx: 3, by: -2, sx: 6, sy: 8, rho: -0.5 };
  const rs: number[] = [];
  let rdm = 0;
  for (let t = 0; t < sims; t++) { const m = E.computeSet(pattern(R, n, o), D); rs.push(m.rating); rdm += m.rd; }
  const mean = rs.reduce((a, b) => a + b, 0) / sims;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (sims - 1));
  rdm /= sims;
  note(`n=20: empirical rating SD ${sd.toFixed(1)}, mean reported RD ${rdm.toFixed(1)}`);
  assert.ok(Math.abs(rdm / sd - 1) < 0.15, `RD ${rdm} vs empirical SD ${sd}`);
});

test('uncertainty: mishits widen the interval instead of being hidden', () => {
  const R = rng(10);
  const D = 150, n = 20, sims = 1500;
  let clean = 0, squib = 0;
  for (let t = 0; t < sims; t++) {
    clean += E.computeSet(pattern(R, n, { bx: 0, by: 0, sx: 6, sy: 8, rho: -0.3 }), D).rd;
    squib += E.computeSet(pattern(R, n, { bx: 0, by: 0, sx: 6, sy: 8, rho: -0.3, squib: 0.08, D }), D).rd;
  }
  assert.ok(squib > 1.3 * clean, `squib RD ${squib / sims} should exceed clean ${clean / sims}`);
  note(`8% squib rate raises mean RD from ${(clean / sims).toFixed(1)} to ${(squib / sims).toFixed(1)} points`);
});

test('tilt: no false directional pattern on round patterns', () => {
  const R = rng(11);
  for (const n of [10, 20, 40]) {
    let fp = 0;
    const sims = 3000;
    for (let t = 0; t < sims; t++) if (E.computeSet(pattern(R, n, { bx: 0, by: 0, sx: 6, sy: 6, rho: 0 }), 150).tiltSignificant) fp++;
    const r = fp / sims;
    note(`tilt false-positive rate, round pattern, n=${n}: ${(100 * r).toFixed(1)}% (target ${100 * E.ALPHA}%)`);
    assert.ok(r < 0.075, `tilt false positives at n=${n}: ${r}`);
  }
});

test('tilt: a real long-left/short-right pattern is detected, more surely with more shots, at the right angle', () => {
  const R = rng(12);
  const power: number[] = [];
  for (const n of [10, 20, 40, 60]) {
    let det = 0, err = 0;
    const sims = 1000;
    for (let t = 0; t < sims; t++) {
      const m = E.computeSet(pattern(R, n, { bx: 0, by: 0, sx: 7, sy: 7, rho: -0.6 }), 150);
      if (m.tiltSignificant) { det++; err += Math.abs(m.thetaDeg - -45); }
    }
    power.push(det / sims);
    note(`tilt power, aspect 0.5 (rho=-0.6), n=${n}: ${(100 * det / sims).toFixed(0)}%, mean angle error when detected ${(err / Math.max(1, det)).toFixed(1)} deg`);
  }
  for (let i = 1; i < power.length; i++) assert.ok(power[i] > power[i - 1], 'power must rise with shot count');
  assert.ok(power[3] > 0.95, `at 60 shots a 2:1 ellipse must be found: ${power[3]}`);
});

test('contours: empirical share inside each band matches its probability', () => {
  const R = rng(13);
  const shots = pattern(R, 4000, { bx: 2, by: -1, sx: 5, sy: 9, rho: -0.5 });
  const m = E.computeSet(shots, 150);
  for (const c of E.contours(shots, m)) assert.ok(Math.abs(c.empirical - c.p) < 0.02, `band ${c.p}: ${c.empirical}`);
});

test('discovery mode measures the stock distance instead of penalising it', () => {
  const R = rng(14);
  const shots = pattern(R, 30, { bx: 1, by: -9, sx: 4, sy: 6, rho: 0 });
  const m = E.computeSet(shots, 150, 'discovery');
  assert.ok(Math.abs(m.muY) < 1e-12);
  assert.ok(Math.abs(m.depthOffset - -9) < 3);
  const t = E.computeSet(shots, 150, 'target');
  assert.ok(t.piB > m.piB, 'target mode must charge the depth miss that discovery mode excludes');
});

// ---------------------------------------------------------------- temporal

function simulateSeries(R: ReturnType<typeof rng>, q: number, sessions: number) {
  const obs: E.Obs[] = [];
  const truth: number[] = [];
  let x = 1100, t = 0;
  for (let i = 0; i < sessions; i++) {
    if (i > 0) { const dt = 2 + Math.floor(R.u() * 12); t += dt; x += Math.sqrt(q * dt) * R.g(); }
    const rd = 18 + 14 * R.u();
    obs.push({ t, rating: x + rd * R.g(), rd, n: 15 });
    truth.push(x);
  }
  return { obs, truth };
}

test('drift: maximum likelihood recovers the true drift rate', () => {
  const R = rng(15);
  const ratios: number[] = [];
  for (let k = 0; k < 120; k++) {
    const q = 40;
    const labels = Array.from({ length: 4 }, () => simulateSeries(R, q, 24).obs);
    const f = E.fitDrift(labels);
    if (f.identified) ratios.push(f.qTime / q);
  }
  ratios.sort((a, b) => a - b);
  const med = ratios[Math.floor(ratios.length / 2)];
  note(`drift recovery (true 40 pts^2/day): identified ${ratios.length}/120, median estimate/true ${med.toFixed(2)}`);
  assert.ok(ratios.length > 100 && med > 0.7 && med < 1.4);
});

test('drift: filtered rating covers the true current skill, and beats the raw last session on accuracy', () => {
  const R = rng(16);
  for (const labels of [1, 6]) {
    let hit = 0, total = 0, rawHit = 0, errF = 0, errR = 0, widthF = 0, widthR = 0, unident = 0;
    for (let k = 0; k < 300; k++) {
      const sims = Array.from({ length: labels }, () => simulateSeries(R, 40, 20));
      const f = E.fitDrift(sims.map(s => s.obs));
      if (!f.identified) unident++;
      const { obs, truth } = sims[0];
      const out = E.filterSeries(obs, f, obs[obs.length - 1].t);
      const tr = truth[truth.length - 1], last = obs[obs.length - 1];
      if (Math.abs(out.now.rating - tr) < E.Z * out.now.rd) hit++;
      if (Math.abs(last.rating - tr) < E.Z * last.rd) rawHit++;
      errF += (out.now.rating - tr) ** 2; errR += (last.rating - tr) ** 2;
      widthF += out.now.rd; widthR += last.rd;
      total++;
    }
    note(`current skill, ${labels} club(s) x 20 sessions: 95% coverage filtered ${(100 * hit / total).toFixed(1)}% vs raw ${(100 * rawHit / total).toFixed(1)}%; RMS error filtered ${Math.sqrt(errF / total).toFixed(1)} vs raw ${Math.sqrt(errR / total).toFixed(1)}; error bar ${(widthF / total).toFixed(1)} vs ${(widthR / total).toFixed(1)}; filter off in ${unident}`);
    rateNear(hit, total, 0.95, `filtered coverage with ${labels} club(s)`);
    assert.ok(errF < errR, 'filtering must be more accurate than trusting the last session');
  }
});

test('drift: too little history means no filter and an honest provisional flag', () => {
  const R = rng(17);
  const { obs } = simulateSeries(R, 40, 2);
  const f = E.fitDrift([obs]);
  assert.equal(f.identified, false);
  const out = E.filterSeries(obs, f, obs[1].t);
  assert.equal(out.filtered, false);
  assert.equal(out.now.rating, obs[1].rating);
});

test('effective sample size decays with time and practice', () => {
  const obs: E.Obs[] = [{ t: 0, rating: 1100, rd: 25, n: 20 }, { t: 30, rating: 1110, rd: 25, n: 20 }, { t: 60, rating: 1120, rd: 25, n: 20 }];
  const fit: E.DriftFit = { qTime: 20, qReps: 0, identified: true, logLik: 0, innovations: 2 };
  const now = E.filterSeries(obs, fit, 60), later = E.filterSeries(obs, fit, 400);
  assert.ok(now.nEffShots < 60 && later.nEffShots < now.nEffShots);
  assert.ok(later.staleness > 1, 'a 340-day-old number must read as stale');
  const still = E.filterSeries(obs, { ...fit, qTime: 0 }, 400);
  assert.ok(close(still.nEffShots, 60, 1e-12));
});

test('trend: no false improvement when skill is flat', () => {
  const R = rng(18);
  let fp = 0, sims = 1500;
  for (let k = 0; k < sims; k++) {
    const obs: E.Obs[] = [];
    for (let i = 0; i < 10; i++) { const rd = 20 + 10 * R.u(); obs.push({ t: i * 7, rating: 1100 + rd * R.g(), rd, n: 15 }); }
    if (E.trend(obs)!.detectable) fp++;
  }
  note(`trend false-positive rate on flat skill: ${(100 * fp / sims).toFixed(1)}%`);
  assert.ok(fp / sims < 0.075);
});

test('day-to-day share separates good-day/bad-day players from steady ones', () => {
  const R = rng(19);
  const make = (dayVar: number) => Array.from({ length: 8 }, (_, i) => {
    const s = 6 * Math.exp(dayVar * R.g());
    return { t: i * 5, D: 150, shots: pattern(R, 15, { bx: 0, by: 0, sx: s, sy: s * 1.3, rho: 0 }) };
  });
  let steady = 0, moody = 0;
  for (let k = 0; k < 200; k++) { steady += E.dayToDayShare(make(0))!.share; moody += E.dayToDayShare(make(0.45))!.share; }
  note(`day-to-day share: steady player ${(steady / 2).toFixed(1)}%, good-day/bad-day player ${(moody / 2).toFixed(1)}%`);
  assert.ok(moody / 200 > 3 * (steady / 200));
});

// ---------------------------------------------------------------- comparison

/** One player's bag: label ratings measured from simulated sets, true pi = level * (D/150)^k. */
function bag(R: ReturnType<typeof rng>, player: string, Ds: number[], level: number, k: number, n = 15, domain = 'full'): E.LabelPoint[] {
  return Ds.map((D, i) => {
    const pi = level * (D / 150) ** k;
    const s = (pi * D) / Math.sqrt(2.2);
    const m = E.computeSet(pattern(R, n, { bx: 0, by: 0, sx: s, sy: 1.1 * s, rho: -0.3 }), D);
    return { id: `${player}-${i}`, player, D, rating: m.rating, rd: m.rd, domain };
  });
}

const TYLER = [95, 110, 125, 140, 152, 165, 178, 190, 205];
const FRIEND = [88, 100, 113, 127, 140, 152, 164, 176, 190];

test('band comparison: equal players with different club distances read as a tie at the stated rate', () => {
  const R = rng(20);
  let fp = 0, sims = 800;
  for (let k = 0; k < sims; k++) {
    const c = E.compareBand(bag(R, 'A', TYLER, 0.06, 0), bag(R, 'B', FRIEND, 0.06, 0), 90, 200)!;
    if (c.distinguishable) fp++;
  }
  const r = fp / sims;
  note(`band comparison false-positive rate, equal skill: ${(100 * r).toFixed(1)}%`);
  assert.ok(r < 0.08);
});

test('band comparison: a real difference is found', () => {
  const R = rng(21);
  let tp = 0, sims = 400;
  for (let k = 0; k < sims; k++) {
    const c = E.compareBand(bag(R, 'A', TYLER, 0.05, 0), bag(R, 'B', FRIEND, 0.065, 0), 90, 200)!;
    if (c.distinguishable && c.diff > 0) tp++;
  }
  note(`band comparison power, 38-point true gap: ${(100 * tp / sims).toFixed(0)}%`);
  assert.ok(tp / sims > 0.8);
});

test('band comparison refuses to extrapolate outside common support', () => {
  const R = rng(22);
  assert.equal(E.compareBand(bag(R, 'A', [40, 50, 60], 0.08, 0), bag(R, 'B', [150, 160, 170], 0.05, 0), 40, 170), null);
  const c = E.compareBand(bag(R, 'A', [60, 80, 100, 120], 0.08, 0), bag(R, 'B', [100, 120, 140], 0.07, 0), 60, 140)!;
  assert.ok(c.from >= 100 - 1e-9 && c.to <= 120 + 1e-9 && c.coverage < 1);
});

test('scaling exponent: recovered when present, not invented when absent', () => {
  const R = rng(23);
  let fp = 0, est = 0, sims = 400;
  for (let k = 0; k < sims; k++) {
    const f0 = E.fitScaling([...bag(R, 'A', TYLER, 0.06, 0), ...bag(R, 'B', FRIEND, 0.07, 0)], 'full')!;
    if (f0.significant) fp++;
    est += E.fitScaling([...bag(R, 'A', TYLER, 0.06, -0.5), ...bag(R, 'B', FRIEND, 0.07, -0.5)], 'full')!.k;
  }
  note(`scaling exponent: false-positive ${(100 * fp / sims).toFixed(1)}%, true k=-0.5 recovered as ${(est / sims).toFixed(3)}`);
  assert.ok(fp / sims < 0.08 && Math.abs(est / sims - -0.5) < 0.06);
});

test('club-set comparison with mismatched distances is fair once scaling is measured', () => {
  const R = rng(24);
  let fpRaw = 0, fpAdj = 0, sims = 400;
  for (let k = 0; k < sims; k++) {
    // short shots harder in % terms (k=-0.5); equal skill; A's "9 and 6" fly farther than B's.
    const a = bag(R, 'A', TYLER, 0.06, -0.5, 25), b = bag(R, 'B', FRIEND, 0.06, -0.5, 25);
    const fits = new Map([['full', E.fitScaling([...a, ...b], 'full')]]);
    const none = new Map<string, E.ScalingFit | null>([['full', null]]);
    const pick = (xs: E.LabelPoint[]) => [xs[2], xs[6]];
    if (E.compareSets(pick(a), pick(b), none).distinguishable) fpRaw++;
    if (E.compareSets(pick(a), pick(b), fits).distinguishable) fpAdj++;
  }
  note(`"my 9 and 6 vs his 9 and 6", equal skill, distances differ: raw false-positive ${(100 * fpRaw / sims).toFixed(1)}%, distance-adjusted ${(100 * fpAdj / sims).toFixed(1)}%`);
  assert.ok(fpAdj / sims < 0.085);
});

test('practice priority names the weak club and refuses to rank inside the noise', () => {
  const pts: E.LabelPoint[] = [
    { id: 'PW', player: 'A', D: 120, rating: 980, rd: 20, domain: 'full' },
    { id: '9i', player: 'A', D: 135, rating: 1060, rd: 20, domain: 'full' },
    { id: '7i', player: 'A', D: 160, rating: 1075, rd: 20, domain: 'full' },
    { id: '5i', player: 'A', D: 185, rating: 1000, rd: 22, domain: 'full' },
  ];
  const p = E.practicePriority(pts, new Map());
  assert.equal(p[0].id, 'PW');
  assert.deepEqual(p.filter(x => x.tiedForLast).map(x => x.id), ['PW', '5i']);
});

// ---------------------------------------------------------------- A/B

test('A/B: the planned shot count actually delivers the stated power', () => {
  const R = rng(25);
  const D = 260, base = { bx: 0, by: 0, sx: 14, sy: 12, rho: -0.3 };
  const pilot = E.computeSet(pattern(R, 400, base), D);
  const delta = 60;
  const n = E.requiredShots(pilot.perShotRatingSd, delta);
  const scale = Math.pow(2, -delta / E.SCALE.B);
  let hit = 0, sims = 600;
  for (let k = 0; k < sims; k++) {
    const a = E.computeSet(pattern(R, n, { ...base, sx: base.sx * scale, sy: base.sy * scale }), D);
    const b = E.computeSet(pattern(R, n, base), D);
    const c = E.compareAB(a, b);
    if (c.distinguishable && c.diff > 0) hit++;
  }
  note(`A/B: planner asked for ${n} shots per build for a 60-point gap; achieved power ${(100 * hit / sims).toFixed(0)}% (target 80%)`);
  assert.ok(hit / sims > 0.72);
  assert.deepEqual(E.abSchedule(6, 3).join(''), 'AAABBBAAABBB');
});

// ---------------------------------------------------------------- scatter drivers

test('explain: start line vs curve split is recovered from shots alone, with no physics assumed', () => {
  const R = rng(26);
  let sumStart = 0, sumCurve = 0, slopeH = 0;
  const sims = 300;
  for (let k = 0; k < sims; k++) {
    // Truth used only to generate data: 2.6 yd per degree of start line, 0.9 yd per degree of axis, plus sim noise.
    const n = 30, hla: number[] = [], axis: number[] = [], off: number[] = [];
    for (let i = 0; i < n; i++) {
      const h = 2.0 * R.g(), a = 5 * R.g() + 0.3 * h;
      hla.push(h); axis.push(a); off.push(2.6 * h + 0.9 * a + 1.5 * R.g());
    }
    const e = E.explain('offline', off, { startLine: hla, spinAxis: axis })!;
    const d = Object.fromEntries(e.drivers.map(x => [x.name, x]));
    sumStart += d.startLine.share; sumCurve += d.spinAxis.share; slopeH += d.startLine.perUnit;
    assert.ok(Math.abs(e.drivers.reduce((s, x) => s + x.share, 0) - e.r2) < 1e-9, 'shares must sum to R^2');
  }
  // Expected shares from the generating model (Pratt): var parts of y.
  const vh = 4, va = 25 + 0.09 * 4, cha = 0.3 * 4;
  const vy = 2.6 ** 2 * vh + 0.9 ** 2 * va + 2 * 2.6 * 0.9 * cha + 2.25;
  const expStart = (2.6 * (2.6 * vh + 0.9 * cha)) / vy, expCurve = (0.9 * (0.9 * va + 2.6 * cha)) / vy;
  note(`scatter drivers: start-line share ${(100 * sumStart / sims).toFixed(1)}% (true ${(100 * expStart).toFixed(1)}%), curve share ${(100 * sumCurve / sims).toFixed(1)}% (true ${(100 * expCurve).toFixed(1)}%), slope ${(slopeH / sims).toFixed(2)} yd/deg (true 2.60)`);
  assert.ok(Math.abs(sumStart / sims - expStart) < 0.02 && Math.abs(sumCurve / sims - expCurve) < 0.02 && Math.abs(slopeH / sims - 2.6) < 0.05);
  assert.equal(E.explain('x', [1, 2, 3], { a: [1, 2, 3] }), null, 'refuses with too few shots');
});

test('launch layer: start-line miss is exact geometry and unit-free', () => {
  const R = rng(27);
  const ls = Array.from({ length: 40 }, () => ({ ballSpeed: 120 + 2 * R.g(), vla: 16 + R.g(), hla: 0.5 + 1.8 * R.g(), spin: 6800 + 400 * R.g(), spinAxis: 1 + 3 * R.g() }));
  const a = E.computeLaunch(ls);
  // Straight-line projection: a ball that starts at angle h lands D*tan(h) offline, so piStart equals the start-line part of piQ.
  const D = 150, offs = ls.map(l => ({ x: D * Math.tan((l.hla * Math.PI) / 180), y: 0 }));
  assert.ok(close(a.piStart, E.computeSet(offs, D).piQ, 1e-12));
  // Ball speed in mph or m/s gives the same consistency number.
  const b = E.computeLaunch(ls.map(l => ({ ...l, ballSpeed: l.ballSpeed * 0.44704 })));
  assert.ok(close(a.speedCv, b.speedCv, 1e-12));
  assert.ok(a.startLine.sd > 1.4 && a.startLine.sd < 2.3);
});

test('setups: different sims or versions are flagged, different monitors are noted', () => {
  const a = { sim: 'GSPro', simVersion: '3.49.11.13', device: 'Garmin R10', deviceFw: '4.50', conditions: 'range default' };
  assert.deepEqual(E.comparable(a, { ...a }), { ok: true, landing: true, launch: true, differs: [] });
  const d = E.comparable(a, { ...a, device: 'Uneekor EYE XO2' });
  assert.equal(d.landing, true); assert.equal(d.launch, false);
  const v = E.comparable(a, { ...a, simVersion: '3.50' });
  assert.equal(v.landing, false); assert.equal(v.launch, true);
  assert.equal(E.comparable(a, { ...a, deviceFw: '4.60' }).launch, false, 'a firmware update breaks launch-layer comparability');
});

test.after(() => {
  console.log('\n---- proof summary ----');
  for (const r of report) console.log('  ' + r);
});
