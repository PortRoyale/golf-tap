/**
 * Fits the ball's aerodynamic coefficients to Trackman's measured tour flights,
 * then tests whether the result can be trusted:
 *
 *   1. Out-of-sample: fit on PGA only, score on the LPGA table it never saw.
 *   2. Leave-one-club-out: refit 12 times, each time predicting the club left out.
 *   3. Shape sensitivity: fit two different coefficient shapes; where they agree,
 *      the shape choice does not matter; where they disagree, the model is guessing.
 *   4. Identifiability: parameter standard errors and correlations from the
 *      Jacobian. Correlations near +/-1 mean coefficients are tangled (underdefined).
 *
 *   node --no-warnings calibrate.ts
 *
 * Source: Trackman 2023 PGA and LPGA Tour averages (metre tables),
 * support.trackmangolf.com article attachment 7349801987483.
 */
import { flyWith, REFERENCE_AIR, type Coef, type Launch } from './physics.ts';

const MPH = 0.44704;
type Row = [string, number, number, number, number, number, number]; // club, ball mph, launch, spin, apex m, land deg, carry m
export const PGA: Row[] = [
  ['Driver', 167, 10.9, 2686, 29, 38, 251], ['3-wood', 158, 9.2, 3655, 27, 43, 222],
  ['5-wood', 152, 9.4, 4350, 28, 47, 210], ['Hybrid', 146, 10.2, 4437, 27, 47, 206],
  ['3 Iron', 142, 10.4, 4630, 25, 46, 194], ['4 Iron', 137, 11.0, 4836, 26, 48, 186],
  ['5 Iron', 132, 12.1, 5361, 28, 49, 177], ['6 Iron', 127, 14.1, 6231, 27, 50, 167],
  ['7 Iron', 120, 16.3, 7097, 29, 50, 157], ['8 Iron', 115, 18.1, 7998, 28, 50, 146],
  ['9 Iron', 109, 20.4, 8647, 27, 51, 135], ['PW', 102, 24.2, 9304, 27, 52, 124],
];
export const LPGA: Row[] = [
  ['Driver', 140, 13.2, 2611, 23, 37, 199], ['3-wood', 132, 11.2, 2704, 21, 39, 178],
  ['5-wood', 128, 12.1, 4501, 24, 43, 169], ['7-wood', 123, 12.7, 4693, 23, 46, 159],
  ['4 Iron', 116, 14.3, 4801, 22, 43, 155], ['5 Iron', 112, 14.8, 5081, 21, 45, 147],
  ['6 Iron', 109, 17.1, 5943, 23, 46, 139], ['7 Iron', 104, 19.0, 6699, 24, 47, 129],
  ['8 Iron', 100, 20.8, 7494, 23, 47, 119], ['9 Iron', 93, 23.9, 7589, 24, 47, 109],
  ['PW', 86, 25.7, 8403, 21, 48, 98],
];

interface Shape { name: string; names: string[]; x0: number[]; steps: number[]; valid: (x: number[]) => boolean; coef: (x: number[]) => Coef; tau: (x: number[]) => number }

/** A: production shape. Drag linear in spin ratio; lift rises and saturates. 5 coefficients. */
const SAT: Shape = {
  name: 'A  saturating lift', names: ['cd0', 'cd1', 'clMax', 's0', 'tauSpin'],
  x0: [0.22, 0.2, 0.3, 0.15, 25], steps: [0.02, 0.05, 0.05, 0.03, 5],
  valid: x => x[0] > 0 && x[1] >= 0 && x[2] > 0 && x[3] > 0.01 && x[4] > 1,
  coef: x => S => ({ cd: x[0] + x[1] * S, cl: x[2] * (1 - Math.exp(-S / x[3])) }),
  tau: x => x[4],
};
/** B: a different shape entirely. Lift linear in spin ratio, drag quadratic. 4 coefficients. */
const LIN: Shape = {
  name: 'B  linear lift', names: ['cd0', 'cd2', 'cl1', 'tauSpin'],
  x0: [0.22, 0.5, 1.0, 25], steps: [0.02, 0.2, 0.2, 5],
  valid: x => x[0] > 0 && x[1] >= 0 && x[2] > 0 && x[3] > 1,
  coef: x => S => ({ cd: x[0] + x[1] * S * S, cl: x[2] * S }),
  tau: x => x[3],
};

const launch = (r: Row): Launch => ({ ballSpeed: r[1] * MPH, vla: r[2], hla: 0, spin: r[3], spinAxis: 0 });
const DT = 0.005;

/** Scaled residuals: carry by 1% (Trackman rounds to 1 m and averages real shots), apex and land angle by their rounding. */
function resid(sh: Shape, x: number[], tab: Row[]): number[] {
  const out: number[] = [];
  for (const r of tab) {
    const f = flyWith(launch(r), REFERENCE_AIR, sh.coef(x), sh.tau(x), DT);
    out.push((f.carry - r[6]) / (0.01 * r[6]), (f.apex - r[4]) / 1.0, (f.landAngle - r[5]) / 1.0);
  }
  return out;
}
const loss = (sh: Shape, x: number[], tab: Row[]) => (sh.valid(x) ? resid(sh, x, tab).reduce((s, v) => s + v * v, 0) : 1e12);

function nelderMead(f: (x: number[]) => number, x0: number[], steps: number[], iters: number): number[] {
  const n = x0.length;
  let S = [x0.slice()];
  for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += steps[i]; S.push(x); }
  let V = S.map(f);
  for (let it = 0; it < iters; it++) {
    const ix = V.map((_, i) => i).sort((a, b) => V[a] - V[b]);
    S = ix.map(i => S[i]); V = ix.map(i => V[i]);
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += S[i][j] / n;
    const w = S[n], xr = c.map((v, j) => 2 * v - w[j]), fr = f(xr);
    if (fr < V[0]) { const xe = c.map((v, j) => 3 * v - 2 * w[j]), fe = f(xe); if (fe < fr) { S[n] = xe; V[n] = fe; } else { S[n] = xr; V[n] = fr; } }
    else if (fr < V[n - 1]) { S[n] = xr; V[n] = fr; }
    else { const xc = c.map((v, j) => 0.5 * (v + w[j])), fc = f(xc); if (fc < V[n]) { S[n] = xc; V[n] = fc; } else for (let i = 1; i <= n; i++) { S[i] = S[i].map((v, j) => 0.5 * (v + S[0][j])); V[i] = f(S[i]); } }
  }
  return S[V.indexOf(Math.min(...V))];
}

function fit(sh: Shape, tab: Row[], x0 = sh.x0, rounds = 3, iters = 700): number[] {
  let x = x0;
  for (let k = 0; k < rounds; k++) x = nelderMead(v => loss(sh, v, tab), x, sh.steps.map(s => s / (k + 1)), iters);
  return x;
}

/** Standard errors and correlations from J^T J at the optimum. */
function identifiability(sh: Shape, x: number[], tab: Row[]) {
  const r0 = resid(sh, x, tab), m = r0.length, n = x.length;
  const J: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
  for (let j = 0; j < n; j++) {
    const h = Math.max(1e-6, Math.abs(x[j]) * 1e-4);
    const up = x.slice(), dn = x.slice(); up[j] += h; dn[j] -= h;
    const ru = resid(sh, up, tab), rd = resid(sh, dn, tab);
    for (let i = 0; i < m; i++) J[i][j] = (ru[i] - rd[i]) / (2 * h);
  }
  const JtJ = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J.reduce((s, row) => s + row[a] * row[b], 0)));
  const inv = invert(JtJ);
  const s2 = r0.reduce((s, v) => s + v * v, 0) / Math.max(1, m - n);
  const se = inv.map((row, i) => Math.sqrt(Math.max(0, row[i] * s2)));
  const corr = inv.map((row, i) => row.map((v, j) => v / Math.sqrt(inv[i][i] * inv[j][j])));
  const ev = eigSym(JtJ);
  return { se, corr, cond: Math.max(...ev) / Math.max(1e-300, Math.min(...ev)) };
}

function invert(A: number[][]): number[][] {
  const n = A.length, M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c]; for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map(r => r.slice(n));
}

function eigSym(A: number[][]): number[] {
  // Jacobi rotations; fine for 5x5.
  const n = A.length, M = A.map(r => r.slice());
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += M[i][j] ** 2;
    if (off < 1e-24) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(M[p][q]) < 1e-300) continue;
      const th = 0.5 * Math.atan2(2 * M[p][q], M[q][q] - M[p][p]), c = Math.cos(th), s = Math.sin(th);
      for (let k = 0; k < n; k++) { const a = M[k][p], b = M[k][q]; M[k][p] = c * a - s * b; M[k][q] = s * a + c * b; }
      for (let k = 0; k < n; k++) { const a = M[p][k], b = M[q][k]; M[p][k] = c * a - s * b; M[q][k] = s * a + c * b; }
    }
  }
  return M.map((r, i) => r[i]);
}

function errors(sh: Shape, x: number[], tab: Row[]) {
  const rows = tab.map(r => { const f = flyWith(launch(r), REFERENCE_AIR, sh.coef(x), sh.tau(x), 0.002); return { club: r[0], carryPct: (100 * (f.carry - r[6])) / r[6], apex: f.apex - r[4], land: f.landAngle - r[5], carry: f.carry, carryT: r[6] }; });
  const rms = (k: 'carryPct' | 'apex' | 'land') => Math.sqrt(rows.reduce((s, e) => s + e[k] ** 2, 0) / rows.length);
  return { rows, carryRmsPct: rms('carryPct'), apexRms: rms('apex'), landRms: rms('land'), worstCarryPct: Math.max(...rows.map(e => Math.abs(e.carryPct))) };
}

const fmt = (v: number, d = 2) => (v >= 0 ? '+' : '') + v.toFixed(d);

function report(sh: Shape) {
  console.log(`\n================ shape ${sh.name} ================`);
  const x = fit(sh, PGA);
  console.log('fitted:', sh.names.map((n, i) => `${n}=${x[i].toPrecision(5)}`).join('  '));
  const id = identifiability(sh, x, PGA);
  console.log('standard error:', sh.names.map((n, i) => `${n} ±${(100 * id.se[i] / Math.abs(x[i])).toFixed(1)}%`).join('  '));
  let worst = 0, pair = '';
  for (let i = 0; i < x.length; i++) for (let j = i + 1; j < x.length; j++) if (Math.abs(id.corr[i][j]) > Math.abs(worst)) { worst = id.corr[i][j]; pair = `${sh.names[i]}/${sh.names[j]}`; }
  console.log(`most tangled pair: ${pair} correlation ${worst.toFixed(3)}   condition number ${id.cond.toExponential(2)}`);
  const pga = errors(sh, x, PGA), lpga = errors(sh, x, LPGA);
  console.log(`PGA  (fitted):   carry RMS ${pga.carryRmsPct.toFixed(2)}%  worst ${pga.worstCarryPct.toFixed(2)}%  apex RMS ${pga.apexRms.toFixed(2)} m  land RMS ${pga.landRms.toFixed(2)} deg`);
  console.log(`LPGA (unseen):   carry RMS ${lpga.carryRmsPct.toFixed(2)}%  worst ${lpga.worstCarryPct.toFixed(2)}%  apex RMS ${lpga.apexRms.toFixed(2)} m  land RMS ${lpga.landRms.toFixed(2)} deg`);
  for (const e of lpga.rows) console.log(`   LPGA ${e.club.padEnd(7)} carry ${e.carry.toFixed(1).padStart(6)} m vs ${e.carryT}  (${fmt(e.carryPct)}%)   apex ${fmt(e.apex, 1)} m   land ${fmt(e.land, 1)} deg`);
  // Leave one club out
  const loo: number[] = [];
  for (let k = 0; k < PGA.length; k++) {
    const train = PGA.filter((_, i) => i !== k);
    const xk = fit(sh, train, x, 1, 300);
    const f = flyWith(launch(PGA[k]), REFERENCE_AIR, sh.coef(xk), sh.tau(xk), 0.002);
    loo.push((100 * (f.carry - PGA[k][6])) / PGA[k][6]);
  }
  console.log(`leave-one-club-out carry: RMS ${Math.sqrt(loo.reduce((s, v) => s + v * v, 0) / loo.length).toFixed(2)}%  worst ${Math.max(...loo.map(Math.abs)).toFixed(2)}%`);
  return { x, pga, lpga, id, loo };
}

function shapeDisagreement(a: { sh: Shape; x: number[] }, b: { sh: Shape; x: number[] }) {
  console.log('\n================ do the two shapes agree? ================');
  const cases: [string, Launch][] = [
    ['driver 150 mph', { ballSpeed: 150 * MPH, vla: 12, hla: 0, spin: 2800, spinAxis: 0 }],
    ['driver 175 mph', { ballSpeed: 175 * MPH, vla: 11, hla: 0, spin: 2400, spinAxis: 0 }],
    ['7 iron 115 mph', { ballSpeed: 115 * MPH, vla: 17, hla: 0, spin: 6800, spinAxis: 0 }],
    ['PW 95 mph', { ballSpeed: 95 * MPH, vla: 25, hla: 0, spin: 9000, spinAxis: 0 }],
    ['7 iron 15 deg fade axis', { ballSpeed: 115 * MPH, vla: 17, hla: 0, spin: 6800, spinAxis: 15 }],
    ['driver 20 deg slice axis', { ballSpeed: 150 * MPH, vla: 12, hla: 2, spin: 3000, spinAxis: 20 }],
    ['--- outside the data ---', { ballSpeed: 0, vla: 0, hla: 0, spin: 0, spinAxis: 0 }],
    ['half wedge 60 mph', { ballSpeed: 60 * MPH, vla: 30, hla: 0, spin: 7000, spinAxis: 0 }],
    ['quarter wedge 45 mph', { ballSpeed: 45 * MPH, vla: 34, hla: 0, spin: 5500, spinAxis: 0 }],
    ['low-spin bomb 185 mph', { ballSpeed: 185 * MPH, vla: 14, hla: 0, spin: 1800, spinAxis: 0 }],
  ];
  for (const [name, L] of cases) {
    if (L.ballSpeed === 0) { console.log(name); continue; }
    const fa = flyWith(L, REFERENCE_AIR, a.sh.coef(a.x), a.sh.tau(a.x)), fb = flyWith(L, REFERENCE_AIR, b.sh.coef(b.x), b.sh.tau(b.x));
    console.log(`  ${name.padEnd(26)} A ${fa.carry.toFixed(1).padStart(6)} m / ${fa.offline.toFixed(1).padStart(5)} off    B ${fb.carry.toFixed(1).padStart(6)} m / ${fb.offline.toFixed(1).padStart(5)} off    carry diff ${fmt((100 * (fa.carry - fb.carry)) / fa.carry)}%`);
  }
}

const ra = report(SAT);
const rb = report(LIN);
shapeDisagreement({ sh: SAT, x: ra.x }, { sh: LIN, x: rb.x });
console.log('\nFROZEN (shape A):', JSON.stringify({ cd0: +ra.x[0].toFixed(5), cd1: +ra.x[1].toFixed(5), clMax: +ra.x[2].toFixed(5), s0: +ra.x[3].toFixed(5), tauSpin: +ra.x[4].toFixed(3) }));
