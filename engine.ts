/**
 * Shot Quality Engine — the frozen algorithm.
 *
 * Pure functions only: no clocks, no Math.random, no I/O. Same input gives the
 * same output. Summation order is the input order, so callers must pass shots
 * in strike order (ascending seq) to get identical results everywhere.
 *
 * Coordinates are in the target frame:
 *   x = offline, + right of the target line
 *   y = depth,   + long of the target
 * Any length unit works as long as shots and the target distance D share it.
 * Every output named pi* is dimensionless.
 */

export const ALGO_VERSION = '1.0.0';

/**
 * Scale definition: R = A - B*log2(piQ / PI0).
 * A and PI0 cancel out of every difference, ranking and slope. B is a unit
 * (points per halving of your miss). PI0 is the one frozen anchor any absolute
 * scale needs, the way 0 degC is pinned to freezing water.
 */
export const SCALE = { A: 1000, B: 100, PI0: 0.05 } as const;

/** The single statistical convention behind every "distinguishable" decision. */
export const ALPHA = 0.05;

/** Default probability bands for the dispersion map. */
export const BANDS = [0.1, 0.25, 0.5, 0.75, 0.9] as const;

// ---------------------------------------------------------------- types

export interface Shot { x: number; y: number }

export type Mode = 'target' | 'discovery';

export interface SetMetrics {
  algo: string;
  mode: Mode;
  n: number;
  D: number;
  /** Mean offline / depth (same unit as input). In discovery mode depth mean is 0 by construction. */
  muX: number;
  muY: number;
  /** Discovery mode only: how far the pattern center sat from the seed target. Add to the seed to get the measured stock distance. */
  depthOffset: number;
  /** Unbiased covariance (n-1). */
  sxx: number; syy: number; sxy: number;

  piQ: number;   // overall miss as a fraction of D (RMS)
  piB: number;   // debiased aim error
  piS: number;   // strike scatter; piB^2 + piS^2 = piQ^2 exactly
  piE: number;   // ellipse aspect b/a, 0 = line, 1 = circle
  phiDeg: number | null;   // bias direction, deg from +right toward +long; null if no detectable bias
  thetaDeg: number;        // major axis angle, deg from +right toward +long, in (-90, 90]
  thetaHalfWidthDeg: number; // bootstrap half-width of the (1-ALPHA) interval on theta
  tiltSignificant: boolean;  // sphericity rejected at ALPHA
  tiltP: number;
  semiA: number; semiB: number; // 1-sigma semi-axes, input units

  rating: number;
  rd: number;               // standard error of rating, measured from this set's own spread
  ratingLo: number;         // (1-ALPHA) interval, t with n-1 df
  ratingHi: number;
  ratingTrim: number;       // rating after dropping the ceil(0.1n) largest misses
  perShotRatingSd: number;  // rd * sqrt(n), the per-shot noise used for sample-size planning
}

// ---------------------------------------------------------------- numerics

const LN2 = Math.LN2;

/** Inverse standard normal CDF (Acklam). */
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError('normInv: p must be in (0,1)');
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q: number, r: number, x: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pl) {
    q = p - 0.5; r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  return x; // Acklam: |rel err| < 1.15e-9, better than any refinement erfc() here could add
}

/** Complementary error function, |rel err| < 1.2e-7 (Numerical Recipes erfcc). */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

function lgamma(x: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp0 = x + 5.5;
  const tmp = tmp0 - (x + 0.5) * Math.log(tmp0);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300;
  let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-16) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b). */
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Student t CDF. */
export function tCdf(t: number, df: number): number {
  const x = df / (df + t * t);
  const tail = 0.5 * betai(df / 2, 0.5, x);
  return t >= 0 ? 1 - tail : tail;
}

/** Student t quantile by bisection (deterministic, 200 steps). */
export function tInv(p: number, df: number): number {
  if (df > 1e6) return normInv(p);
  let lo = -1e3, hi = 1e3;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (tCdf(mid, df) < p) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export const Z = normInv(1 - ALPHA / 2);

/** Deterministic PRNG (mulberry32). Seeded from the data so bootstrap results are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(xs: number[]): number {
  // FNV-1a over values quantized to 1e-9 of the unit; stable across engines.
  let h = 0x811c9dc5;
  for (const v of xs) {
    const q = Math.round(v * 1e9);
    const s = String(q);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

// ---------------------------------------------------------------- core

export function ratingFromPi(piQ: number): number {
  return SCALE.A - SCALE.B * Math.log2(piQ / SCALE.PI0);
}

export function piFromRating(r: number): number {
  return SCALE.PI0 * Math.pow(2, (SCALE.A - r) / SCALE.B);
}

function moments(xs: number[], ys: number[]) {
  const n = xs.length;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let cxx = 0, cyy = 0, cxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
  }
  const k = n - 1;
  return { mx, my, sxx: cxx / k, syy: cyy / k, sxy: cxy / k };
}

function axisAngle(sxx: number, syy: number, sxy: number): number {
  // major-axis angle in radians, (-pi/2, pi/2]
  return 0.5 * Math.atan2(2 * sxy, sxx - syy);
}

function wrapPi(a: number): number {
  while (a <= -Math.PI) a += 2 * Math.PI;
  while (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

/**
 * Metrics for one set of shots at one target.
 *
 * target mode:    depth is measured against the target. This is the scored test.
 * discovery mode: depth is measured against the set's own mean. Use it to find
 *                 your real stock distance; the result is not comparable with
 *                 target-mode ratings and is flagged as such.
 */
export function computeSet(shots: Shot[], D: number, mode: Mode = 'target'): SetMetrics {
  const n = shots.length;
  if (n < 3) throw new RangeError('computeSet: need at least 3 shots');
  if (!(D > 0)) throw new RangeError('computeSet: target distance must be > 0');

  const xs = shots.map(s => s.x);
  let ys = shots.map(s => s.y);
  let depthOffset = 0;
  if (mode === 'discovery') {
    let s = 0; for (const v of ys) s += v;
    depthOffset = s / n;
    ys = ys.map(v => v - depthOffset);
  }

  const { mx, my, sxx, syy, sxy } = moments(xs, ys);

  // Overall miss. m2 is the mean squared miss distance, the definition of piQ.
  const u: number[] = new Array(n);
  let m2 = 0;
  for (let i = 0; i < n; i++) { u[i] = xs[i] * xs[i] + ys[i] * ys[i]; m2 += u[i]; }
  m2 /= n;
  const piQ2 = m2 / (D * D);
  const piQ = Math.sqrt(piQ2);

  // Debiased split. E|mean|^2 = |mu|^2 + tr(Sigma)/n, so subtract the noise floor.
  const trU = sxx + syy;
  const mu2 = mx * mx + my * my;
  const piB2 = Math.max(0, mu2 - trU / n) / (D * D);
  const piB = Math.sqrt(piB2);
  const piS = Math.sqrt(Math.max(0, piQ2 - piB2)); // exact closure, clamped or not

  // Ellipse.
  const half = 0.5 * trU;
  const disc = Math.sqrt(0.25 * (sxx - syy) * (sxx - syy) + sxy * sxy);
  const l1 = half + disc, l2 = Math.max(0, half - disc);
  const semiA = Math.sqrt(l1), semiB = Math.sqrt(l2);
  const piE = semiA > 0 ? semiB / semiA : 1;
  const thetaRad = axisAngle(sxx, syy, sxy);

  // Sphericity (Mauchly, p=2): is there a real directional pattern?
  const det = sxx * syy - sxy * sxy;
  let tiltP: number;
  if (!(det > 0) || !(half > 0)) tiltP = 0;
  else {
    const W = det / (half * half);
    const stat = -(n - 2) * Math.log(W);
    tiltP = Math.exp(-stat / 2); // chi-square, 2 df, survival function
  }
  const tiltSignificant = tiltP < ALPHA;

  // Bootstrap half-width of theta, on doubled (axial) angles.
  const rnd = mulberry32(seedFrom(xs.concat(ys, [D, n])));
  const NB = 400;
  const d2: number[] = new Array(NB);
  const bx: number[] = new Array(n), by: number[] = new Array(n);
  for (let b = 0; b < NB; b++) {
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rnd() * n);
      bx[i] = xs[j]; by[i] = ys[j];
    }
    const m = moments(bx, by);
    d2[b] = wrapPi(2 * axisAngle(m.sxx, m.syy, m.sxy) - 2 * thetaRad);
  }
  d2.sort((a, b) => a - b);
  const lo = d2[Math.floor((ALPHA / 2) * NB)];
  const hi = d2[Math.min(NB - 1, Math.ceil((1 - ALPHA / 2) * NB) - 1)];
  const thetaHalfWidthDeg = ((hi - lo) / 2 / 2) * (180 / Math.PI);

  // Rating and its uncertainty, measured from this set's own spread of squared misses.
  const rating = ratingFromPi(piQ);
  // Variance of a squared miss: the empirical value catches fat tails (mishits);
  // the Gaussian value 2tr(S^2) + 4 mu'S mu is steadier at small n. Take the larger,
  // so neither a lucky small sample nor a squib can make the interval overconfident.
  let vEmp = 0;
  for (let i = 0; i < n; i++) vEmp += (u[i] - m2) * (u[i] - m2);
  vEmp /= n - 1;
  const vGauss = 2 * (sxx * sxx + syy * syy + 2 * sxy * sxy) + 4 * (mx * mx * sxx + 2 * mx * my * sxy + my * my * syy);
  const vu = Math.max(vEmp, vGauss);
  const seM2 = Math.sqrt(vu / n);
  const rd = m2 > 0 ? (SCALE.B / (2 * LN2)) * (seM2 / m2) : Infinity;
  const tq = tInv(1 - ALPHA / 2, n - 1);

  // Trimmed: drop the ceil(0.1 n) largest misses; ties drop the later shot first.
  const k = Math.ceil(0.1 * n);
  const order = u.map((v, i) => [v, i] as [number, number]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  let mt = 0;
  for (let i = k; i < n; i++) mt += order[i][0];
  mt /= n - k;
  const ratingTrim = ratingFromPi(Math.sqrt(mt) / D);

  return {
    algo: ALGO_VERSION, mode, n, D,
    muX: mx, muY: my, depthOffset,
    sxx, syy, sxy,
    piQ, piB, piS, piE,
    phiDeg: piB > 0 ? Math.atan2(my, mx) * (180 / Math.PI) : null,
    thetaDeg: thetaRad * (180 / Math.PI),
    thetaHalfWidthDeg, tiltSignificant, tiltP,
    semiA, semiB,
    rating, rd,
    ratingLo: rating - tq * rd,
    ratingHi: rating + tq * rd,
    ratingTrim,
    perShotRatingSd: rd * Math.sqrt(n),
  };
}

// ---------------------------------------------------------------- contours

export interface Contour { p: number; m: number; cx: number; cy: number; ra: number; rb: number; thetaDeg: number; empirical: number }

/**
 * Probability contours of the fitted Gaussian. The band at p contains a share p
 * of shots if the pattern is normal; `empirical` is the share of this set's
 * shots that actually fell inside, so fat tails show up instead of hiding.
 */
export function contours(shots: Shot[], m: SetMetrics, ps: readonly number[] = BANDS): Contour[] {
  const det = m.sxx * m.syy - m.sxy * m.sxy;
  const ys = m.mode === 'discovery' ? shots.map(s => s.y - m.depthOffset) : shots.map(s => s.y);
  return ps.map(p => {
    const mp = Math.sqrt(-2 * Math.log(1 - p));
    let inside = 0;
    if (det > 0) {
      for (let i = 0; i < shots.length; i++) {
        const dx = shots[i].x - m.muX, dy = ys[i] - m.muY;
        const q = (m.syy * dx * dx - 2 * m.sxy * dx * dy + m.sxx * dy * dy) / det;
        if (q <= mp * mp) inside++;
      }
    }
    return { p, m: mp, cx: m.muX, cy: m.muY, ra: mp * m.semiA, rb: mp * m.semiB, thetaDeg: m.thetaDeg, empirical: inside / shots.length };
  });
}

// ---------------------------------------------------------------- efficiency

export const G = 9.80665;

/** Distance efficiency, dimensionless: distance * g / ballSpeed^2. SI units in. */
export function efficiency(rows: { dist: number; ballSpeed: number }[]): { mean: number; se: number; n: number } {
  const v = rows.filter(r => r.ballSpeed > 0).map(r => (r.dist * G) / (r.ballSpeed * r.ballSpeed));
  const n = v.length;
  if (n < 2) return { mean: n ? v[0] : NaN, se: NaN, n };
  let s = 0; for (const x of v) s += x;
  const mean = s / n;
  let q = 0; for (const x of v) q += (x - mean) * (x - mean);
  return { mean, se: Math.sqrt(q / (n - 1) / n), n };
}

// ---------------------------------------------------------------- temporal

export interface Obs { t: number; rating: number; rd: number; n: number; reps?: number }

export interface DriftFit {
  /** rating^2 per day of random-walk drift (rust). */
  qTime: number;
  /** rating^2 per practice rep (change from practice). 0 when no rep counts were given. */
  qReps: number;
  /** True when the data bound the drift from above; otherwise the filter stays off and raw ratings are shown. */
  identified: boolean;
  logLik: number;
  innovations: number;
  /** Likelihood over log qTime (qReps held at its estimate), used to average over drift uncertainty. */
  grid: { lq: number; ll: number }[];
}

function kalmanLL(series: Obs[][], qt: number, qr: number): { ll: number; k: number } {
  let ll = 0, k = 0;
  for (const s of series) {
    if (s.length === 0) continue;
    let x = s[0].rating, P = s[0].rd * s[0].rd;
    for (let i = 1; i < s.length; i++) {
      const dt = Math.max(0, s[i].t - s[i - 1].t);
      const Pp = P + qt * dt + qr * (s[i].reps ?? 0);
      const R = s[i].rd * s[i].rd;
      const S = Pp + R;
      const v = s[i].rating - x;
      ll += -0.5 * (Math.log(2 * Math.PI * S) + (v * v) / S);
      k++;
      const K = Pp / S;
      x = x + K * v;
      P = (1 - K) * Pp;
    }
  }
  return { ll, k };
}

function golden(f: (x: number) => number, a: number, b: number, iters = 120): number {
  // maximize f on [a,b]
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a), d = a + g * (b - a);
  let fc = f(c), fd = f(d);
  for (let i = 0; i < iters; i++) {
    if (fc > fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
  }
  return 0.5 * (a + b);
}

const LQ_LO = Math.log(1e-8), LQ_HI = Math.log(1e6);

function maxOnGrid(f: (x: number) => number): number {
  let best = LQ_LO, bv = -Infinity;
  const N = 57;
  for (let i = 0; i < N; i++) {
    const x = LQ_LO + ((LQ_HI - LQ_LO) * i) / (N - 1);
    const v = f(x);
    if (v > bv) { bv = v; best = x; }
  }
  const step = (LQ_HI - LQ_LO) / (N - 1);
  return golden(f, Math.max(LQ_LO, best - step), Math.min(LQ_HI, best + step));
}

/**
 * Maximum-likelihood drift, shared across one player's labels.
 * Nothing is assumed: if the data cannot bound the drift, `identified` is false
 * and callers must show raw per-session ratings instead of filtered ones.
 */
export function fitDrift(series: Obs[][]): DriftFit {
  const hasReps = series.some(s => s.some(o => (o.reps ?? 0) > 0));
  let lqt = Math.log(1), lqr = hasReps ? Math.log(1) : -Infinity;
  const ll = (a: number, b: number) => kalmanLL(series, Math.exp(a), b === -Infinity ? 0 : Math.exp(b)).ll;
  for (let round = 0; round < (hasReps ? 8 : 1); round++) {
    lqt = maxOnGrid(x => ll(x, lqr));
    if (hasReps) lqr = maxOnGrid(x => ll(lqt, x));
  }
  const { ll: best, k } = kalmanLL(series, Math.exp(lqt), lqr === -Infinity ? 0 : Math.exp(lqr));
  const crit = 0.5 * 3.841458820694124; // chi-square(1) at 1-ALPHA, halved for log-lik
  const upperBounded = best - ll(LQ_HI, lqr) > crit;
  const repsBounded = !hasReps || best - ll(lqt, LQ_HI) > crit;
  const grid: { lq: number; ll: number }[] = [];
  const NG = 81;
  for (let i = 0; i < NG; i++) {
    const lq = LQ_LO + ((LQ_HI - LQ_LO) * i) / (NG - 1);
    grid.push({ lq, ll: ll(lq, lqr) });
  }
  // The posterior (likelihood x uniform-on-SD prior) must have died off before the
  // top of the grid, otherwise the data have not bounded the drift.
  let peak = -Infinity;
  for (const g of grid) peak = Math.max(peak, g.ll + g.lq / 2);
  const top = grid[grid.length - 1];
  const posteriorBounded = top.ll + top.lq / 2 < peak + Math.log(ALPHA);
  return {
    qTime: Math.exp(lqt),
    qReps: lqr === -Infinity ? 0 : Math.exp(lqr),
    identified: k >= 3 && upperBounded && repsBounded && posteriorBounded,
    logLik: best,
    innovations: k,
    grid,
  };
}

export interface FilterPoint { t: number; raw: number; rawRd: number; est: number; estRd: number }
export interface FilterResult {
  points: FilterPoint[];
  now: { t: number; rating: number; rd: number };
  /** Shot-equivalents of information still relevant at tNow. */
  nEffShots: number;
  totalShots: number;
  /** Drift since the last session divided by that session's own measurement variance. >1 means the last number is stale. */
  staleness: number;
  filtered: boolean;
}

/**
 * Random-walk Kalman filter for one label. Falls back to raw values when drift is
 * not identified. The current estimate averages over the drift rate's own
 * uncertainty (likelihood-weighted, prior uniform on drift SD), so a short
 * history cannot produce overconfident error bars.
 */
export function filterSeries(s: Obs[], fit: DriftFit, tNow: number): FilterResult {
  const single = filterAt(s, fit, tNow, fit.qTime);
  if (!fit.identified || !fit.grid?.length) return single;
  let W = 0, m = 0, m2v = 0;
  // Prior uniform on the drift SD sqrt(q) (Gelman 2006); on a log-q grid that is a weight of sqrt(q).
  // A flat prior on log q would pile weight onto "no drift" and make the error bars overconfident.
  let mw = -Infinity;
  for (const g of fit.grid) mw = Math.max(mw, g.ll + g.lq / 2);
  const runs = fit.grid.map(g => ({ w: Math.exp(g.ll + g.lq / 2 - mw), r: filterAt(s, fit, tNow, Math.exp(g.lq)) }));
  for (const { w, r } of runs) { W += w; m += w * r.now.rating; }
  m /= W;
  for (const { w, r } of runs) m2v += w * (r.now.rd * r.now.rd + (r.now.rating - m) ** 2);
  m2v /= W;
  return { ...single, now: { t: tNow, rating: m, rd: Math.sqrt(m2v) } };
}

function filterAt(s: Obs[], fit: DriftFit, tNow: number, qTime: number): FilterResult {
  if (s.length === 0) throw new RangeError('filterSeries: empty');
  const on = fit.identified;
  const qt = on ? qTime : 0, qr = on ? fit.qReps : 0;
  const pts: FilterPoint[] = [];
  let x = s[0].rating, P = s[0].rd * s[0].rd;
  pts.push({ t: s[0].t, raw: s[0].rating, rawRd: s[0].rd, est: x, estRd: Math.sqrt(P) });
  for (let i = 1; i < s.length; i++) {
    const dt = Math.max(0, s[i].t - s[i - 1].t);
    const Pp = P + qt * dt + qr * (s[i].reps ?? 0);
    const R = s[i].rd * s[i].rd;
    if (on) {
      const K = Pp / (Pp + R);
      x = x + K * (s[i].rating - x);
      P = (1 - K) * Pp;
    } else { x = s[i].rating; P = R; }
    pts.push({ t: s[i].t, raw: s[i].rating, rawRd: s[i].rd, est: x, estRd: Math.sqrt(P) });
  }
  const last = s[s.length - 1];
  const dtNow = Math.max(0, tNow - last.t);
  const Pnow = P + qt * dtNow;
  let nEff = 0, total = 0, repsAfter = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const drift = qt * Math.max(0, tNow - s[i].t) + qr * repsAfter;
    const R = s[i].rd * s[i].rd;
    nEff += s[i].n * (R / (R + drift));
    total += s[i].n;
    repsAfter += s[i].reps ?? 0;
  }
  return {
    points: pts,
    now: { t: tNow, rating: x, rd: Math.sqrt(Pnow) },
    nEffShots: nEff,
    totalShots: total,
    staleness: (qt * dtNow) / (last.rd * last.rd),
    filtered: on,
  };
}

export interface Trend { perMonth: number; se: number; lo: number; hi: number; detectable: boolean; overdispersion: number }

/** Weighted least-squares trend in rating points per 30 days, SE inflated for overdispersion. */
export function trend(s: Obs[]): Trend | null {
  if (s.length < 3) return null;
  let sw = 0, st = 0, sr = 0;
  for (const o of s) { const w = 1 / (o.rd * o.rd); sw += w; st += w * o.t; sr += w * o.rating; }
  const tb = st / sw, rb = sr / sw;
  let stt = 0, str = 0;
  for (const o of s) { const w = 1 / (o.rd * o.rd); stt += w * (o.t - tb) ** 2; str += w * (o.t - tb) * (o.rating - rb); }
  if (!(stt > 0)) return null;
  const slope = str / stt;
  let chi2 = 0;
  for (const o of s) { const e = o.rating - (rb + slope * (o.t - tb)); chi2 += (e * e) / (o.rd * o.rd); }
  const dof = s.length - 2;
  const od = Math.max(1, chi2 / dof);
  const se = Math.sqrt(od / stt);
  const tq = tInv(1 - ALPHA / 2, dof);
  const k = 30;
  return { perMonth: slope * k, se: se * k, lo: (slope - tq * se) * k, hi: (slope + tq * se) * k, detectable: Math.abs(slope / se) > tq, overdispersion: od };
}

/**
 * Share of miss-size variability that is day-to-day rather than shot-to-shot.
 * One-way random effects on squared normalized miss, session means detrended.
 */
export function dayToDayShare(sessions: { t: number; shots: Shot[]; D: number }[]): { share: number; sessions: number } | null {
  const groups = sessions.filter(s => s.shots.length >= 2).map(s => ({ t: s.t, u: s.shots.map(p => (p.x * p.x + p.y * p.y) / (s.D * s.D)) }));
  const K = groups.length;
  if (K < 2) return null;
  const means = groups.map(g => g.u.reduce((a, b) => a + b, 0) / g.u.length);
  let adj = means.slice();
  if (K >= 3) {
    const tb = groups.reduce((a, g) => a + g.t, 0) / K, mb = means.reduce((a, b) => a + b, 0) / K;
    let stt = 0, stm = 0;
    for (let i = 0; i < K; i++) { stt += (groups[i].t - tb) ** 2; stm += (groups[i].t - tb) * (means[i] - mb); }
    const sl = stt > 0 ? stm / stt : 0;
    adj = means.map((m, i) => m - sl * (groups[i].t - tb));
  }
  let N = 0, ssw = 0, sumN2 = 0;
  for (let i = 0; i < K; i++) {
    const g = groups[i];
    N += g.u.length; sumN2 += g.u.length ** 2;
    for (const v of g.u) ssw += (v - means[i]) ** 2;
  }
  const grand = adj.reduce((a, m, i) => a + m * groups[i].u.length, 0) / N;
  let ssb = 0;
  for (let i = 0; i < K; i++) ssb += groups[i].u.length * (adj[i] - grand) ** 2;
  const msb = ssb / (K - 1), msw = ssw / (N - K);
  const n0 = (N - sumN2 / N) / (K - 1);
  const sb2 = Math.max(0, (msb - msw) / n0);
  return { share: sb2 / (sb2 + msw), sessions: K };
}

// ---------------------------------------------------------------- comparison

export interface LabelPoint { id: string; player: string; D: number; rating: number; rd: number; domain: string; cls?: string }

export interface ScalingFit {
  domain: string;
  k: number;          // measured exponent: piQ ~ D^k at equal skill
  se: number;
  significant: boolean;
  Dref: number;
  lackOfFitP: number; // small means the power law itself does not fit
  dof: number;
}

/**
 * Measures how miss-as-a-fraction scales with distance, from everyone's data in
 * one domain, with a separate level per player. k = 0 means dividing by distance
 * already makes short and long shots comparable. Requires two or more distinct
 * distances for at least one player.
 */
export function fitScaling(points: LabelPoint[], domain: string): ScalingFit | null {
  const pts = points.filter(p => p.domain === domain && p.rd > 0 && Number.isFinite(p.rating));
  if (pts.length < 3) return null;
  let swl = 0, sw = 0;
  for (const p of pts) { const w = 1 / (p.rd * p.rd); sw += w; swl += w * Math.log(p.D); }
  const Dref = Math.exp(swl / sw);
  const players = [...new Set(pts.map(p => p.player))].sort();
  const L = (D: number) => Math.log2(D / Dref);
  let sxx = 0, sxy = 0;
  const pm = new Map<string, { w: number; l: number; r: number }>();
  for (const id of players) {
    const ps = pts.filter(p => p.player === id);
    let w = 0, l = 0, r = 0;
    for (const p of ps) { const wi = 1 / (p.rd * p.rd); w += wi; l += wi * L(p.D); r += wi * p.rating; }
    pm.set(id, { w, l: l / w, r: r / w });
    for (const p of ps) {
      const wi = 1 / (p.rd * p.rd);
      const dl = L(p.D) - l / w, dr = p.rating - r / w;
      sxx += wi * dl * dl; sxy += wi * dl * dr;
    }
  }
  if (!(sxx > 1e-12)) return null;
  const slopeR = sxy / sxx;          // rating points per doubling of distance
  const k = -slopeR / SCALE.B;
  let chi2 = 0;
  for (const p of pts) {
    const g = pm.get(p.player)!;
    const e = p.rating - (g.r + slopeR * (L(p.D) - g.l));
    chi2 += (e * e) / (p.rd * p.rd);
  }
  const dof = pts.length - players.length - 1;
  const od = dof > 0 ? Math.max(1, chi2 / dof) : 1;
  const se = Math.sqrt(od / sxx) / SCALE.B;
  const lackOfFitP = dof > 0 ? chiSqSurvival(chi2, dof) : 1;
  const tq = dof > 0 ? tInv(1 - ALPHA / 2, dof) : Infinity;
  return { domain, k, se, significant: Math.abs(k / se) > tq, Dref, lackOfFitP, dof };
}

function chiSqSurvival(x: number, k: number): number {
  // upper regularized gamma Q(k/2, x/2)
  return 1 - gammaP(k / 2, x / 2);
}

function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 500; n++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-15) break; }
    return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}

/** Difficulty-adjusted rating at the pooled reference distance. Only differs from raw when the measured k is significant. */
export function adjust(p: LabelPoint, fit: ScalingFit | null): { rating: number; rd: number; adjusted: boolean } {
  if (!fit || !fit.significant || fit.domain !== p.domain) return { rating: p.rating, rd: p.rd, adjusted: false };
  const L = Math.log2(p.D / fit.Dref);
  const shift = SCALE.B * fit.k * L;
  return { rating: p.rating + shift, rd: Math.sqrt(p.rd * p.rd + (SCALE.B * L * fit.se) ** 2), adjusted: true };
}

export interface Comparison {
  diff: number;       // A minus B, rating points; positive means A is better
  se: number;
  z: number;
  distinguishable: boolean;
  note: string;
}

function decide(diff: number, se: number, note: string): Comparison {
  const z = se > 0 ? diff / se : 0;
  return { diff, se, z, distinguishable: Math.abs(z) > Z, note };
}

/**
 * Club-set comparison: "my 9 and 6 vs his 9 and 6", "my wedges vs his wedges",
 * "my wedges vs my irons". Precision-weighted mean of difficulty-adjusted ratings.
 */
export function compareSets(a: LabelPoint[], b: LabelPoint[], fits: Map<string, ScalingFit | null>): Comparison & { meanDA: number; meanDB: number } {
  const agg = (xs: LabelPoint[]) => {
    let w = 0, r = 0, ld = 0;
    for (const p of xs) {
      const adj = adjust(p, fits.get(p.domain) ?? null);
      const wi = 1 / (adj.rd * adj.rd);
      w += wi; r += wi * adj.rating; ld += wi * Math.log(p.D);
    }
    return { r: r / w, se: Math.sqrt(1 / w), D: Math.exp(ld / w) };
  };
  if (!a.length || !b.length) throw new RangeError('compareSets: both sets need labels');
  const A = agg(a), B2 = agg(b);
  const domains = new Set([...a, ...b].map(p => p.domain));
  const anyAdj = [...a, ...b].some(p => adjust(p, fits.get(p.domain) ?? null).adjusted);
  const note = domains.size > 1
    ? 'mixes shot domains; only the raw percentage-miss scale is shared across them'
    : anyAdj ? 'distance-adjusted with the measured scaling exponent' : 'raw percentage-miss; measured scaling is not significant so no adjustment applied';
  return { ...decide(A.r - B2.r, Math.sqrt(A.se ** 2 + B2.se ** 2), note), meanDA: A.D, meanDB: B2.D };
}

/** Piecewise-linear skill curve in log distance, written as weights on the label ratings so its uncertainty is exact. */
function curveWeights(pts: LabelPoint[], L: number): Map<string, number> | null {
  const s = [...pts].sort((p, q) => p.D - q.D || (p.id < q.id ? -1 : 1));
  const ls = s.map(p => Math.log(p.D));
  if (L < ls[0] - 1e-12 || L > ls[ls.length - 1] + 1e-12) return null;
  for (let i = 0; i < s.length - 1; i++) {
    if (L <= ls[i + 1] + 1e-12) {
      const span = ls[i + 1] - ls[i];
      const w = span > 1e-12 ? Math.min(1, Math.max(0, (L - ls[i]) / span)) : 0.5;
      const m = new Map<string, number>();
      m.set(s[i].id, (m.get(s[i].id) ?? 0) + (1 - w));
      m.set(s[i + 1].id, (m.get(s[i + 1].id) ?? 0) + w);
      return m;
    }
  }
  return new Map([[s[s.length - 1].id, 1]]);
}

/**
 * Distance-band comparison between two players in one domain, over the part of
 * [Dlo, Dhi] that both players actually cover. No extrapolation: outside common
 * support there is no answer, and the result says how much of the band was usable.
 */
export function compareBand(a: LabelPoint[], b: LabelPoint[], Dlo: number, Dhi: number): (Comparison & { coverage: number; from: number; to: number }) | null {
  if (a.length < 2 || b.length < 2) return null;
  const lo = Math.max(Math.log(Dlo), Math.log(Math.min(...a.map(p => p.D))), Math.log(Math.min(...b.map(p => p.D))));
  const hi = Math.min(Math.log(Dhi), Math.log(Math.max(...a.map(p => p.D))), Math.log(Math.max(...b.map(p => p.D))));
  if (!(hi > lo)) return null;
  const G2 = 256;
  const wa = new Map<string, number>(), wb = new Map<string, number>();
  for (let i = 0; i < G2; i++) {
    const L = lo + ((hi - lo) * (i + 0.5)) / G2;
    const ca = curveWeights(a, L)!, cb = curveWeights(b, L)!;
    for (const [k, v] of ca) wa.set(k, (wa.get(k) ?? 0) + v / G2);
    for (const [k, v] of cb) wb.set(k, (wb.get(k) ?? 0) + v / G2);
  }
  let diff = 0, varr = 0;
  for (const p of a) { const w = wa.get(p.id) ?? 0; diff += w * p.rating; varr += w * w * p.rd * p.rd; }
  for (const p of b) { const w = wb.get(p.id) ?? 0; diff -= w * p.rating; varr += w * w * p.rd * p.rd; }
  const coverage = (hi - lo) / (Math.log(Dhi) - Math.log(Dlo));
  return { ...decide(diff, Math.sqrt(varr), 'common distance support only'), coverage, from: Math.exp(lo), to: Math.exp(hi) };
}

export interface Priority { id: string; rating: number; rd: number; adjusted: boolean; tiedForLast: boolean }

/** Practice priority for one player: lowest first, with every label statistically tied for last flagged. */
export function practicePriority(labels: LabelPoint[], fits: Map<string, ScalingFit | null>): Priority[] {
  const xs = labels.map(p => { const a = adjust(p, fits.get(p.domain) ?? null); return { id: p.id, rating: a.rating, rd: a.rd, adjusted: a.adjusted }; })
    .sort((p, q) => p.rating - q.rating || (p.id < q.id ? -1 : 1));
  if (!xs.length) return [];
  const low = xs[0];
  return xs.map(p => ({ ...p, tiedForLast: p === low || p.rating - low.rating < Z * Math.sqrt(p.rd * p.rd + low.rd * low.rd) }));
}

// ---------------------------------------------------------------- launch layer (no sim, no physics)

export interface LaunchIn { ballSpeed: number; vla: number; hla: number; spin: number; spinAxis: number }
export interface Stat { mean: number; sd: number; seMean: number; seSd: number }
export interface LaunchMetrics {
  n: number;
  /** Start-line miss as a fraction of distance, pure geometry: RMS of tan(HLA). Physics-free and sim-free. */
  piStart: number;
  piStartRd: number;
  startLine: Stat;   // deg, + right
  curveAxis: Stat;   // deg, + curves right
  launch: Stat;      // deg
  speedCv: number;   // ball-speed SD / mean, dimensionless
  speedCvSe: number;
  spinCv: number;
  spinCvSe: number;
}

function stat(xs: number[]): Stat {
  const n = xs.length;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  return { mean: m, sd, seMean: sd / Math.sqrt(n), seSd: sd / Math.sqrt(2 * (n - 1)) };
}

/**
 * Consistency of how the ball leaves the face, straight from the launch monitor.
 * Every output is an angle or a ratio, so it is dimensionless and does not depend
 * on any simulator, version, air, altitude or temperature. It does depend on the
 * monitor and its firmware, which is why sessions record both.
 */
export function computeLaunch(ls: LaunchIn[]): LaunchMetrics {
  const n = ls.length;
  if (n < 3) throw new RangeError('computeLaunch: need at least 3 shots');
  const t2 = ls.map(l => Math.tan((l.hla * Math.PI) / 180) ** 2);
  const m2 = t2.reduce((a, b) => a + b, 0) / n;
  const v = t2.reduce((a, b) => a + (b - m2) ** 2, 0) / (n - 1);
  const piStart = Math.sqrt(m2);
  const sp = stat(ls.map(l => l.ballSpeed)), sn = stat(ls.map(l => l.spin));
  return {
    n, piStart,
    piStartRd: m2 > 0 ? (SCALE.B / (2 * LN2)) * (Math.sqrt(v / n) / m2) : Infinity,
    startLine: stat(ls.map(l => l.hla)),
    curveAxis: stat(ls.map(l => l.spinAxis)),
    launch: stat(ls.map(l => l.vla)),
    speedCv: sp.sd / sp.mean, speedCvSe: sp.seSd / sp.mean,
    spinCv: sn.sd / sn.mean, spinCvSe: sn.seSd / sn.mean,
  };
}

// ---------------------------------------------------------------- what drives the scatter (no physics model)

export interface Driver { name: string; perUnit: number; se: number; share: number }
export interface Explained { target: string; n: number; r2: number; drivers: Driver[]; unexplained: number }

/**
 * Regresses an outcome (offline or carry, as GSPro computed it) on the launch
 * numbers the monitor measured, using only this player's own shots. No ball-flight
 * coefficients are assumed: the slopes are measured from the data.
 *
 * share = b_i * cov(x_i, y) / var(y)  (Pratt's measure). Shares sum to R^2; the
 * rest is what the launch numbers do not explain (sim randomness, misreads, inputs
 * not sent). Needs more shots than inputs + 2.
 */
export function explain(target: string, y: number[], inputs: Record<string, number[]>): Explained | null {
  const names = Object.keys(inputs).filter(k => inputs[k].length === y.length);
  const n = y.length, p = names.length;
  if (n < p + 3) return null;
  const X = Array.from({ length: n }, (_, i) => [1, ...names.map(k => inputs[k][i])]);
  const q = p + 1;
  const XtX = Array.from({ length: q }, (_, a) => Array.from({ length: q }, (_, b) => X.reduce((s, r) => s + r[a] * r[b], 0)));
  const Xty = Array.from({ length: q }, (_, a) => X.reduce((s, r, i) => s + r[a] * y[i], 0));
  const inv = invertSym(XtX);
  if (!inv) return null;
  const beta = inv.map(row => row.reduce((s, v, j) => s + v * Xty[j], 0));
  const yb = y.reduce((a, b) => a + b, 0) / n;
  let sst = 0, sse = 0;
  for (let i = 0; i < n; i++) { const f = X[i].reduce((s, v, j) => s + v * beta[j], 0); sse += (y[i] - f) ** 2; sst += (y[i] - yb) ** 2; }
  const s2 = sse / (n - q);
  const vy = sst / (n - 1);
  const drivers = names.map((name, j) => {
    const x = inputs[name], xb = x.reduce((a, b) => a + b, 0) / n;
    let c = 0; for (let i = 0; i < n; i++) c += (x[i] - xb) * (y[i] - yb);
    c /= n - 1;
    return { name, perUnit: beta[j + 1], se: Math.sqrt(Math.max(0, inv[j + 1][j + 1] * s2)), share: vy > 0 ? (beta[j + 1] * c) / vy : 0 };
  }).sort((a, b) => b.share - a.share);
  const r2 = sst > 0 ? 1 - sse / sst : 0;
  return { target, n, r2, drivers, unexplained: 1 - r2 };
}

function invertSym(A: number[][]): number[][] | null {
  const n = A.length, M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12 * Math.max(1, Math.abs(A[c][c]))) return null;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map(r => r.slice(n));
}

// ---------------------------------------------------------------- comparability of two setups

export interface Setup { sim: string; simVersion: string; device: string; deviceFw?: string; conditions: string }

/**
 * Which layer two sets of numbers can be compared on, and why not otherwise.
 *   landing layer (where it landed): needs the same sim, sim version and conditions.
 *   launch layer (how it left the face): needs the same monitor model and firmware.
 */
export function comparable(a: Setup, b: Setup): { ok: boolean; landing: boolean; launch: boolean; differs: string[] } {
  const keys = ['sim', 'simVersion', 'conditions', 'device', 'deviceFw'] as const;
  const differs = keys.filter(k => (a[k] || '?').trim().toLowerCase() !== (b[k] || '?').trim().toLowerCase());
  const landing = !differs.some(k => k === 'sim' || k === 'simVersion' || k === 'conditions');
  const launch = !differs.some(k => k === 'device' || k === 'deviceFw');
  return { ok: landing, landing, launch, differs };
}

// ---------------------------------------------------------------- A/B

/** Shots per build needed to detect `delta` rating points at the given power, from a measured per-shot rating SD. */
export function requiredShots(perShotRatingSd: number, delta: number, power = 0.8): number {
  const zb = normInv(power);
  return Math.ceil(2 * (((Z + zb) * perShotRatingSd) / delta) ** 2);
}

/** Interleaved schedule, A-B-A-B in blocks, so warmup and fatigue cannot manufacture a winner. */
export function abSchedule(perBuild: number, block = 5): ('A' | 'B')[] {
  const out: ('A' | 'B')[] = [];
  let a = 0, b = 0, turn: 'A' | 'B' = 'A';
  while (a < perBuild || b < perBuild) {
    for (let i = 0; i < block; i++) {
      if (turn === 'A' && a < perBuild) { out.push('A'); a++; }
      else if (turn === 'B' && b < perBuild) { out.push('B'); b++; }
    }
    turn = turn === 'A' ? 'B' : 'A';
  }
  return out;
}

export function compareAB(a: SetMetrics, b: SetMetrics): Comparison {
  return decide(a.rating - b.rating, Math.sqrt(a.rd ** 2 + b.rd ** 2), 'same player, interleaved blocks');
}
