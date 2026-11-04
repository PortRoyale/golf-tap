/**
 * Learned ball flight: a frozen, inspectable copy of the simulator's physics.
 *
 * Nothing here is hand-set. The coefficients are learned from pairs of
 * (raw launch data from the monitor) -> (landing point the simulator computed),
 * collected automatically during normal practice. Hundreds of real shots,
 * including curved ones, pin down what 23 straight tour averages could not.
 * The result reproduces the simulator's physics, not reality, and that is the
 * point: once frozen and versioned it can never change under you, and history
 * can be re-scored with it.
 *
 * Flight: point mass, RK4, fixed step (deterministic).
 *   drag  -1/2 rho A CD |v| v
 *   lift  +1/2 rho A CL |v| (w_hat x v)   (Magnus; spin axis fixed in space)
 *   spin  omega(t) = omega0 exp(-t / tau)
 *   CD, CL as functions of spin ratio S = r omega / |v|, in one of several
 *   candidate shapes; the shape is chosen by held-out error, not by taste.
 *
 * Frame: x toward target, y LEFT, z up. Outputs: offline + right.
 * Inputs: HLA + = starts right; spinAxis + = curves right.
 */

/** USGA/R&A limits for the ball: max mass, min diameter. Physical constants of the rules, not fitted. */
export const BALL = { mass: 0.04593, diameter: 0.04267 } as const;
export const G = 9.80665;

export interface Air { tempC: number; pressurePa: number; rh: number }
/** The air every learned flight is evaluated in. It only needs to be fixed; the coefficients absorb the simulator's own air. */
export const MODEL_AIR: Air = { tempC: 25, pressurePa: 101325, rh: 0.5 };

export function airDensity(a: Air): number {
  const T = a.tempC + 273.15;
  const es = 611.21 * Math.exp((18.678 - a.tempC / 234.5) * (a.tempC / (257.14 + a.tempC)));
  const pv = Math.max(0, Math.min(1, a.rh)) * es;
  return (a.pressurePa - pv) / (287.058 * T) + pv / (461.495 * T);
}

export interface Launch { ballSpeed: number; vla: number; hla: number; spin: number; spinAxis: number } // m/s, deg, deg, rpm, deg
export interface Landing { carry: number; offline: number; apex: number; landAngle: number; time: number }

export type Coef = (S: number) => { cd: number; cl: number };

export interface Shape {
  id: string;
  names: string[];
  x0: number[];
  coef: (x: number[]) => Coef;
  tau: (x: number[]) => number;
}

/** Candidate shapes. Parameters are positive and fitted in log space. */
export const SHAPES: Shape[] = [
  {
    id: 'sat5', names: ['cd0', 'cd1', 'clMax', 's0', 'tau'], x0: [0.22, 0.2, 0.3, 0.15, 25],
    coef: x => S => ({ cd: x[0] + x[1] * S, cl: x[2] * (1 - Math.exp(-S / x[3])) }),
    tau: x => x[4],
  },
  {
    id: 'pow5', names: ['cd0', 'cd1', 'cl1', 'p', 'tau'], x0: [0.22, 0.2, 0.6, 0.5, 25],
    coef: x => S => ({ cd: x[0] + x[1] * S, cl: x[2] * Math.pow(Math.max(S, 1e-9), x[3]) }),
    tau: x => x[4],
  },
  {
    id: 'lin4', names: ['cd0', 'cd2', 'cl1', 'tau'], x0: [0.22, 0.5, 1.0, 25],
    coef: x => S => ({ cd: x[0] + x[1] * S * S, cl: x[2] * S }),
    tau: x => x[3],
  },
];

/** trace, when given, collects [downrange, right, height, t] in metres every ~50 ms, for drawing the flight. */
export function flyWith(L: Launch, coef: Coef, tau: number, dt = 0.005, air: Air = MODEL_AIR, trace?: number[][]): Landing {
  const every = Math.max(1, Math.round(0.05 / dt));
  const rho = airDensity(air), r = BALL.diameter / 2, A = Math.PI * r * r, k = (0.5 * rho * A) / BALL.mass;
  const d2r = Math.PI / 180, v0 = L.ballSpeed, el = L.vla * d2r, az = -L.hla * d2r;
  let px = 0, py = 0, pz = 0;
  let vx = v0 * Math.cos(el) * Math.cos(az), vy = v0 * Math.cos(el) * Math.sin(az), vz = v0 * Math.sin(el);
  const tilt = L.spinAxis * d2r, wyl = -Math.cos(tilt), wzl = -Math.sin(tilt);
  const wx = -wyl * Math.sin(az), wy = wyl * Math.cos(az), wz = wzl;
  const om0 = (L.spin * 2 * Math.PI) / 60;
  const acc = (t: number, ux: number, uy: number, uz: number, o: number[]) => {
    const V = Math.hypot(ux, uy, uz);
    if (V < 1e-9) { o[0] = 0; o[1] = 0; o[2] = -G; return; }
    const S = (r * om0 * Math.exp(-t / tau)) / V;
    const c = coef(S);
    const cx = wy * uz - wz * uy, cy = wz * ux - wx * uz, cz = wx * uy - wy * ux;
    o[0] = -k * c.cd * V * ux + k * c.cl * V * cx;
    o[1] = -k * c.cd * V * uy + k * c.cl * V * cy;
    o[2] = -k * c.cd * V * uz + k * c.cl * V * cz - G;
  };
  const a1 = [0, 0, 0], a2 = [0, 0, 0], a3 = [0, 0, 0], a4 = [0, 0, 0];
  let t = 0, apex = 0;
  for (let i = 0; i < 100000; i++) {
    acc(t, vx, vy, vz, a1);
    acc(t + dt / 2, vx + (a1[0] * dt) / 2, vy + (a1[1] * dt) / 2, vz + (a1[2] * dt) / 2, a2);
    acc(t + dt / 2, vx + (a2[0] * dt) / 2, vy + (a2[1] * dt) / 2, vz + (a2[2] * dt) / 2, a3);
    acc(t + dt, vx + a3[0] * dt, vy + a3[1] * dt, vz + a3[2] * dt, a4);
    const nvx = vx + (dt / 6) * (a1[0] + 2 * a2[0] + 2 * a3[0] + a4[0]);
    const nvy = vy + (dt / 6) * (a1[1] + 2 * a2[1] + 2 * a3[1] + a4[1]);
    const nvz = vz + (dt / 6) * (a1[2] + 2 * a2[2] + 2 * a3[2] + a4[2]);
    const npx = px + dt * (vx + (dt / 6) * (a1[0] + a2[0] + a3[0]));
    const npy = py + dt * (vy + (dt / 6) * (a1[1] + a2[1] + a3[1]));
    const npz = pz + dt * (vz + (dt / 6) * (a1[2] + a2[2] + a3[2]));
    if (npz < 0 && nvz < 0 && t > 0.05) {
      const f = pz / (pz - npz);
      const lvx = vx + f * (nvx - vx), lvy = vy + f * (nvy - vy), lvz = vz + f * (nvz - vz);
      if (trace) trace.push([px + f * (npx - px), -(py + f * (npy - py)), 0, t + f * dt]);
      return { carry: px + f * (npx - px), offline: -(py + f * (npy - py)), apex, landAngle: Math.atan2(-lvz, Math.hypot(lvx, lvy)) / d2r, time: t + f * dt };
    }
    if (trace && i % every === 0) trace.push([px, -py, pz, t]);
    px = npx; py = npy; pz = npz; vx = nvx; vy = nvy; vz = nvz; t += dt;
    if (pz > apex) apex = pz;
    if (t > 30) break;
  }
  return { carry: px, offline: -py, apex, landAngle: 90, time: t };
}

// ---------------------------------------------------------------- learning

/** One training example: the monitor's launch numbers and what the simulator said happened. Metres. */
export interface Pair { L: Launch; carry: number; offline: number; apex?: number; landAngle?: number; group?: string; D?: number }

function residuals(sh: Shape, x: number[], ps: Pair[], dt: number): number[] {
  const c = sh.coef(x), tau = sh.tau(x), out: number[] = [];
  for (const p of ps) {
    const f = flyWith(p.L, c, tau, dt);
    out.push(f.carry - p.carry, f.offline - p.offline);
    if (p.apex !== undefined) out.push(f.apex - p.apex);
    if (p.landAngle !== undefined) out.push((f.landAngle - p.landAngle) * 0.5); // 1 deg of descent weighed like 0.5 m
  }
  return out;
}

const ssq = (r: number[]) => r.reduce((s, v) => s + v * v, 0);

function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i]; }
  return x;
}

export interface ShapeFit { shape: string; x: number[]; names: string[]; rmsTrain: number; iters: number; se: number[]; maxCorr: number; maxCorrPair: string; identified: boolean[] }

/** Levenberg-Marquardt in log-parameters. Deterministic. */
export function fitShape(sh: Shape, ps: Pair[], x0 = sh.x0, dt = 0.01, maxIter = 40): ShapeFit {
  let th = x0.map(Math.log);
  const X = (t: number[]) => t.map(Math.exp);
  let r = residuals(sh, X(th), ps, dt), f = ssq(r), lam = 1e-2, it = 0;
  const n = th.length;
  let J: number[][] = [];
  const jac = () => {
    J = Array.from({ length: r.length }, () => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const h = 1e-4, t2 = th.slice(); t2[j] += h;
      const r2 = residuals(sh, X(t2), ps, dt);
      for (let i = 0; i < r.length; i++) J[i][j] = (r2[i] - r[i]) / h;
    }
  };
  for (; it < maxIter; it++) {
    jac();
    const JtJ = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J.reduce((s, row) => s + row[a] * row[b], 0)));
    const Jtr = Array.from({ length: n }, (_, a) => J.reduce((s, row, i) => s + row[a] * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const A = JtJ.map((row, i) => row.map((v, j) => v + (i === j ? lam * (JtJ[i][i] + 1e-9) : 0)));
      const d = solve(A, Jtr.map(v => -v));
      if (!d) { lam *= 10; continue; }
      const t2 = th.map((v, i) => v + Math.max(-1, Math.min(1, d[i])));
      const r2 = residuals(sh, X(t2), ps, dt), f2 = ssq(r2);
      if (Number.isFinite(f2) && f2 < f) { const rel = (f - f2) / f; th = t2; r = r2; f = f2; lam = Math.max(1e-7, lam / 3); improved = true; if (rel < 1e-9) it = maxIter; break; }
      lam *= 8;
    }
    if (!improved) break;
  }
  jac();
  const JtJ = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J.reduce((s, row) => s + row[a] * row[b], 0)));
  const s2 = f / Math.max(1, r.length - n);
  const cov: number[][] = [];
  for (let j = 0; j < n; j++) { const e = new Array(n).fill(0); e[j] = 1; cov.push(solve(JtJ, e) ?? new Array(n).fill(Infinity)); }
  const se = cov.map((row, i) => Math.sqrt(Math.max(0, row[i] * s2))); // SE of log-parameter = relative SE
  let maxCorr = 0, pair = '';
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const c = cov[i][j] / Math.sqrt(cov[i][i] * cov[j][j]);
    if (Math.abs(c) > Math.abs(maxCorr)) { maxCorr = c; pair = `${sh.names[i]}/${sh.names[j]}`; }
  }
  return { shape: sh.id, x: X(th), names: sh.names, rmsTrain: Math.sqrt(f / r.length), iters: it, se, maxCorr, maxCorrPair: pair, identified: se.map(v => Number.isFinite(v) && v < 0.5) };
}

export interface PhysicsFit {
  version: string;
  shape: string;
  names: string[];
  x: number[];
  relSe: number[];
  identified: boolean[];
  maxCorr: number;
  maxCorrPair: string;
  nTrain: number;
  sim: string;
  /** Held-out error (5-fold, folds by shot order), metres. */
  cvCarryRms: number;
  cvOfflineRms: number;
  shapes: { shape: string; cvCarryRms: number; cvOfflineRms: number }[];
  dataHash: string;
  /** The launch conditions the fit has actually seen. Outside this box it is extrapolating. */
  domain: Record<keyof Launch, [number, number]>;
}

const LKEYS: (keyof Launch)[] = ['ballSpeed', 'vla', 'hla', 'spin', 'spinAxis'];
function domainOf(ps: Pair[]): Record<keyof Launch, [number, number]> {
  const d: any = {};
  for (const k of LKEYS) { let lo = Infinity, hi = -Infinity; for (const p of ps) { lo = Math.min(lo, p.L[k]); hi = Math.max(hi, p.L[k]); } d[k] = [lo, hi]; }
  return d;
}
export function inDomain(L: Launch, fit: PhysicsFit): boolean {
  return !fit.domain || LKEYS.every(k => L[k] >= fit.domain[k][0] && L[k] <= fit.domain[k][1]);
}

function hashPairs(ps: Pair[]): string {
  let h = 0x811c9dc5;
  for (const p of ps) for (const v of [p.L.ballSpeed, p.L.vla, p.L.hla, p.L.spin, p.L.spinAxis, p.carry, p.offline]) {
    const s = String(Math.round(v * 1e6));
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function cvError(sh: Shape, ps: Pair[], x0: number[]) {
  const K = 5;
  let sc = 0, so = 0, n = 0;
  for (let k = 0; k < K; k++) {
    const train = ps.filter((_, i) => i % K !== k), test = ps.filter((_, i) => i % K === k);
    if (!test.length || train.length < sh.x0.length + 3) continue;
    const f = fitShape(sh, train, x0, 0.01, 20);
    const c = sh.coef(f.x), tau = sh.tau(f.x);
    for (const p of test) { const l = flyWith(p.L, c, tau, 0.005); sc += (l.carry - p.carry) ** 2; so += (l.offline - p.offline) ** 2; n++; }
  }
  return { carry: Math.sqrt(sc / Math.max(1, n)), offline: Math.sqrt(so / Math.max(1, n)) };
}

/**
 * Learns the simulator's physics from paired shots. Tries every candidate shape,
 * keeps the one with the lowest held-out error, and reports which coefficients
 * the data actually pin down. Same data in, same fit out.
 */
export function learn(ps: Pair[], sim: string, previous?: PhysicsFit | null): PhysicsFit {
  if (ps.length < 20) throw new RangeError('learn: need at least 20 paired shots');
  const scored = SHAPES.map(sh => {
    const start = previous && previous.shape === sh.id ? previous.x : sh.x0;
    const full = fitShape(sh, ps, start);
    const cv = cvError(sh, ps, full.x);
    return { sh, full, cv };
  });
  scored.sort((a, b) => (a.cv.carry ** 2 + a.cv.offline ** 2) - (b.cv.carry ** 2 + b.cv.offline ** 2));
  const best = scored[0];
  const dataHash = hashPairs(ps);
  return {
    version: `${best.sh.id}-${ps.length}-${dataHash}`,
    shape: best.sh.id, names: best.full.names, x: best.full.x, relSe: best.full.se, identified: best.full.identified,
    maxCorr: best.full.maxCorr, maxCorrPair: best.full.maxCorrPair,
    nTrain: ps.length, sim, cvCarryRms: best.cv.carry, cvOfflineRms: best.cv.offline,
    shapes: scored.map(s => ({ shape: s.sh.id, cvCarryRms: s.cv.carry, cvOfflineRms: s.cv.offline })),
    dataHash,
    domain: domainOf(ps),
  };
}

export function flyFit(L: Launch, fit: PhysicsFit): Landing {
  const sh = SHAPES.find(s => s.id === fit.shape);
  if (!sh) throw new Error(`unknown shape ${fit.shape}`);
  return flyWith(L, sh.coef(fit.x), sh.tau(fit.x), 0.002);
}

// ---------------------------------------------------------------- promotion gate and change detection

import { computeSet, ratingFromPi } from './engine.ts';

/**
 * The learned model may replace the simulator only when swapping it in would not
 * move any score by more than a quarter of that score's own measurement error,
 * on at least 95% of sets. The yardstick is the data's own uncertainty, not a
 * tolerance picked by hand.
 */
export function gate(ps: Pair[], fit: PhysicsFit): { sets: number; passRate: number; worstShift: number; medianShift: number; promotable: boolean } {
  const groups = new Map<string, Pair[]>();
  for (const p of ps) if (p.group && p.D) { const g = groups.get(p.group) ?? []; g.push(p); groups.set(p.group, g); }
  let pass = 0, n = 0;
  const shifts: number[] = [];
  for (const g of groups.values()) {
    if (g.length < 5) continue;
    const D = g[0].D!;
    const sim = computeSet(g.map(p => ({ x: p.offline, y: p.carry - D })), D);
    const mod = computeSet(g.map(p => { const l = flyFit(p.L, fit); return { x: l.offline, y: l.carry - D }; }), D);
    const shift = Math.abs(mod.rating - sim.rating);
    shifts.push(shift);
    if (shift < 0.25 * sim.rd) pass++;
    n++;
  }
  shifts.sort((a, b) => a - b);
  const passRate = n ? pass / n : 0;
  return { sets: n, passRate, worstShift: shifts.length ? shifts[shifts.length - 1] : NaN, medianShift: shifts.length ? shifts[Math.floor(shifts.length / 2)] : NaN, promotable: n >= 5 && passRate >= 0.95 };
}

/**
 * Has the simulator changed? Compares the learned model's error on recent shots
 * with its error on the shots it learned from. A real physics change shows up as
 * a shift far outside that noise. This check re-runs after every batch of shots,
 * so it uses a 0.1% two-sided test (z > 3.29); a 5% test would false-alarm about
 * once every 20 batches.
 *
 * Two guards against false alarms, both found in testing:
 *  - Only shots inside the launch conditions the model was trained on are judged.
 *    A new club in the bag is new territory for the model, not a change in the simulator.
 *  - The shift must matter: at least a quarter of the player's own shot-to-shot carry
 *    scatter (the same yardstick as the promotion gate), not just statistically detectable.
 */
export function detectChange(recent: Pair[], fit: PhysicsFit): { n: number; outside: number; meanCarryErr: number; z: number; changed: boolean } {
  const inside = recent.filter(p => inDomain(p.L, fit));
  const outside = recent.length - inside.length;
  if (inside.length < 10) return { n: inside.length, outside, meanCarryErr: NaN, z: 0, changed: false };
  const e = inside.map(p => flyFit(p.L, fit).carry - p.carry);
  const m = e.reduce((a, b) => a + b, 0) / e.length;
  const sd = Math.sqrt(e.reduce((a, b) => a + (b - m) ** 2, 0) / (e.length - 1));
  const noise = Math.max(fit.cvCarryRms, 1e-6);
  const se = Math.sqrt((sd * sd) / e.length + (noise * noise) / fit.nTrain);
  const z = m / se;
  // Pooled within-set carry scatter of the player, when sets are known.
  const groups = new Map<string, number[]>();
  for (const p of inside) if (p.group) { const g = groups.get(p.group) ?? []; g.push(p.carry); groups.set(p.group, g); }
  let ss = 0, df = 0;
  for (const g of groups.values()) if (g.length >= 2) { const gm = g.reduce((a, b) => a + b, 0) / g.length; ss += g.reduce((a, b) => a + (b - gm) ** 2, 0); df += g.length - 1; }
  const matters = df > 0 ? 0.25 * Math.sqrt(ss / df) : 2 * noise;
  return { n: inside.length, outside, meanCarryErr: m, z, changed: Math.abs(z) > 3.29 && Math.abs(m) > Math.max(matters, 2 * noise) };
}

export { ratingFromPi };
