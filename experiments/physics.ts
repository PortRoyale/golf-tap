/**
 * EXPERIMENT, REJECTED (2026-11-03). Not imported by the engine or the tap.
 * Trackman tour averages cannot identify spin decay and contain no curved shots,
 * so this model cannot be trusted for offline. Scoring uses GSPro results instead.
 * Kept so the decision can be re-checked. See calibration-result.txt.
 */
/**
 * Standard ball flight.
 *
 * Every shot is flown from its raw launch data (ball speed, vertical launch,
 * horizontal launch, total spin, spin axis) through one frozen model in one
 * frozen reference atmosphere. The landing point it returns is the "standard
 * shot": where that strike would land on a calm day at sea level, no matter
 * where, when or on which simulator it was hit. That is what makes two players
 * on opposite sides of the world comparable.
 *
 * Point-mass trajectory, RK4, fixed 2 ms step (deterministic):
 *   drag   F = -1/2 rho A CD |v| v
 *   lift   F =  1/2 rho A CL |v|^2 (w_hat x v_hat)    Magnus, spin axis fixed in space
 *   CD = cd0 + cd1 * S          S = r*omega/|v|  (spin ratio)
 *   CL = clMax * (1 - exp(-S / s0))
 *   omega(t) = omega0 * exp(-t / tauSpin)
 *
 * The five coefficients are not chosen: calibrate.ts fits them to Trackman's
 * published PGA Tour averages (carry, apex, land angle for 12 clubs) and then
 * checks them, untouched, against the LPGA Tour table. Re-run calibrate.ts to
 * regenerate; any change bumps PHYSICS_VERSION and old shots are refused, not mixed.
 *
 * Frame: x = toward target, y = LEFT, z = up (right-handed). Public outputs use
 * offline = + right, matching the scoring engine.
 * Sign convention in: HLA + = starts right; spinAxis + = curves right (Trackman
 * convention). Connectors that differ are corrected by a per-device sign flip
 * that is verified live with one deliberate shot (see tap.ts).
 */

export const PHYSICS_VERSION = '1.0.0';

/** USGA/R&A rule limits used as the reference ball: max mass, min diameter. */
export const BALL = { mass: 0.04593, diameter: 0.04267 } as const;

export const G = 9.80665;

/** Fitted by calibrate.ts against Trackman PGA Tour averages. */
// NOT USED FOR SCORING. These are the shape-A fit from calibrate.ts; see calibration-result.txt for why the model was rejected.
export const AERO = {
  cd0: 0.25452,
  cd1: 0.23429,
  clMax: 0.37112,
  s0: 0.14543,
  tauSpin: 1e10, // unidentifiable from Trackman averages
} as const;

export interface Air { tempC: number; pressurePa: number; rh: number }

/**
 * The reference atmosphere every standard shot is flown in: sea level, 25 C, 50% humidity, no wind.
 * Frozen: changing it would change every rating ever computed, so it is versioned with the physics.
 */
export const REFERENCE_AIR: Air = { tempC: 25, pressurePa: 101325, rh: 0.5 };

/** Moist-air density (kg/m^3) from temperature, pressure and relative humidity. */
export function airDensity(a: Air): number {
  const T = a.tempC + 273.15;
  // Saturation vapour pressure, Buck (1981), Pa.
  const es = 611.21 * Math.exp((18.678 - a.tempC / 234.5) * (a.tempC / (257.14 + a.tempC)));
  const pv = Math.max(0, Math.min(1, a.rh)) * es;
  const pd = a.pressurePa - pv;
  return pd / (287.058 * T) + pv / (461.495 * T);
}

/** Pressure at an altitude in metres, standard lapse (for "what would this be at Denver" questions). */
export function pressureAtAltitude(m: number): number {
  return 101325 * Math.pow(1 - 2.25577e-5 * m, 5.25588);
}

export interface Launch {
  ballSpeed: number;   // m/s
  vla: number;         // deg, vertical launch
  hla: number;         // deg, + right
  spin: number;        // rpm, total
  spinAxis: number;    // deg, + curves right
}

export interface Flight {
  carry: number;     // m, along the target line
  offline: number;   // m, + right of the target line
  apex: number;      // m
  landAngle: number; // deg, descent angle at landing
  time: number;      // s
  landSpeed: number; // m/s
  physics: string;
}

export interface Aero { cd0: number; cd1: number; clMax: number; s0: number; tauSpin: number }

export type Coef = (S: number) => { cd: number; cl: number };

/** The production coefficient shape: drag linear in spin ratio, lift rising and saturating. */
export const coefOf = (a: Aero): Coef => (S) => ({ cd: a.cd0 + a.cd1 * S, cl: a.clMax * (1 - Math.exp(-S / a.s0)) });

/** Fly one shot. Pure and deterministic. */
export function fly(L: Launch, air: Air = REFERENCE_AIR, aero: Aero = AERO, dt = 0.002): Flight {
  return flyWith(L, air, coefOf(aero), aero.tauSpin, dt);
}

/** Same flight with any coefficient shape; used to test whether the chosen shape matters. */
export function flyWith(L: Launch, air: Air, coef: Coef, tauSpin: number, dt = 0.002): Flight {
  const aero = { tauSpin };
  const rho = airDensity(air);
  const r = BALL.diameter / 2;
  const A = Math.PI * r * r;
  const k = (0.5 * rho * A) / BALL.mass;
  const d2r = Math.PI / 180;
  const v0 = L.ballSpeed, el = L.vla * d2r, az = -L.hla * d2r; // + right is -y
  let px = 0, py = 0, pz = 0;
  let vx = v0 * Math.cos(el) * Math.cos(az), vy = v0 * Math.cos(el) * Math.sin(az), vz = v0 * Math.sin(el);
  // Spin axis in the launch-direction frame, then rotated by the launch azimuth.
  // Pure backspin is -y_launch; positive tilt adds -z, which curves the ball right.
  const tilt = L.spinAxis * d2r;
  const wxl = 0, wyl = -Math.cos(tilt), wzl = -Math.sin(tilt);
  const wx = wxl * Math.cos(az) - wyl * Math.sin(az);
  const wy = wxl * Math.sin(az) + wyl * Math.cos(az);
  const wz = wzl;
  const omega0 = (L.spin * 2 * Math.PI) / 60;

  const acc = (t: number, ux: number, uy: number, uz: number): [number, number, number] => {
    const V = Math.hypot(ux, uy, uz);
    if (V < 1e-9) return [0, 0, -G];
    const om = omega0 * Math.exp(-t / aero.tauSpin);
    const S = (r * om) / V;
    const { cd, cl } = coef(S);
    // w_hat x v (not normalised by |v|; multiplied by V below gives V^2 scaling)
    const cx = wy * uz - wz * uy, cy = wz * ux - wx * uz, cz = wx * uy - wy * ux;
    return [
      -k * cd * V * ux + k * cl * V * cx,
      -k * cd * V * uy + k * cl * V * cy,
      -k * cd * V * uz + k * cl * V * cz - G,
    ];
  };

  let t = 0, apex = 0;
  for (let i = 0; i < 200000; i++) {
    const a1 = acc(t, vx, vy, vz);
    const a2 = acc(t + dt / 2, vx + (a1[0] * dt) / 2, vy + (a1[1] * dt) / 2, vz + (a1[2] * dt) / 2);
    const a3 = acc(t + dt / 2, vx + (a2[0] * dt) / 2, vy + (a2[1] * dt) / 2, vz + (a2[2] * dt) / 2);
    const a4 = acc(t + dt, vx + a3[0] * dt, vy + a3[1] * dt, vz + a3[2] * dt);
    const nvx = vx + (dt / 6) * (a1[0] + 2 * a2[0] + 2 * a3[0] + a4[0]);
    const nvy = vy + (dt / 6) * (a1[1] + 2 * a2[1] + 2 * a3[1] + a4[1]);
    const nvz = vz + (dt / 6) * (a1[2] + 2 * a2[2] + 2 * a3[2] + a4[2]);
    const npx = px + (dt / 6) * (vx + 2 * (vx + (a1[0] * dt) / 2) + 2 * (vx + (a2[0] * dt) / 2) + (vx + a3[0] * dt));
    const npy = py + (dt / 6) * (vy + 2 * (vy + (a1[1] * dt) / 2) + 2 * (vy + (a2[1] * dt) / 2) + (vy + a3[1] * dt));
    const npz = pz + (dt / 6) * (vz + 2 * (vz + (a1[2] * dt) / 2) + 2 * (vz + (a2[2] * dt) / 2) + (vz + a3[2] * dt));
    if (npz < 0 && nvz < 0 && t > 0.05) {
      const f = pz / (pz - npz);
      const lx = px + f * (npx - px), ly = py + f * (npy - py);
      const lvx = vx + f * (nvx - vx), lvy = vy + f * (nvy - vy), lvz = vz + f * (nvz - vz);
      return {
        carry: lx, offline: -ly, apex,
        landAngle: Math.atan2(-lvz, Math.hypot(lvx, lvy)) / d2r,
        time: t + f * dt,
        landSpeed: Math.hypot(lvx, lvy, lvz),
        physics: PHYSICS_VERSION,
      };
    }
    px = npx; py = npy; pz = npz; vx = nvx; vy = nvy; vz = nvz; t += dt;
    if (pz > apex) apex = pz;
  }
  throw new Error('fly: did not land');
}

/** Offline split into where it started and how much it curved. */
export function startAndCurve(L: Launch, air: Air = REFERENCE_AIR): { start: number; curve: number; total: number } {
  const full = fly(L, air);
  const straight = fly({ ...L, spinAxis: 0 }, air);
  return { start: straight.offline, curve: full.offline - straight.offline, total: full.offline };
}

/**
 * Which launch variable drives the scatter, by linearisation around the set's mean launch.
 * Returns each input's share of the variance of carry and of offline (shares sum to 1 ignoring covariance).
 */
export function scatterSources(launches: Launch[], air: Air = REFERENCE_AIR) {
  const keys: (keyof Launch)[] = ['ballSpeed', 'vla', 'hla', 'spin', 'spinAxis'];
  const n = launches.length;
  if (n < 3) return null;
  const mean: any = {}, sd: any = {};
  for (const k of keys) {
    mean[k] = launches.reduce((a, l) => a + l[k], 0) / n;
    sd[k] = Math.sqrt(launches.reduce((a, l) => a + (l[k] - mean[k]) ** 2, 0) / (n - 1));
  }
  const step: Record<string, number> = { ballSpeed: 0.2, vla: 0.1, hla: 0.1, spin: 25, spinAxis: 0.2 };
  const out: Record<string, { carry: number; offline: number }> = {};
  let vc = 0, vo = 0;
  const parts: Record<string, [number, number]> = {};
  for (const k of keys) {
    const up = fly({ ...mean, [k]: mean[k] + step[k] }, air), dn = fly({ ...mean, [k]: mean[k] - step[k] }, air);
    const dc = ((up.carry - dn.carry) / (2 * step[k])) * sd[k];
    const dof = ((up.offline - dn.offline) / (2 * step[k])) * sd[k];
    parts[k] = [dc * dc, dof * dof];
    vc += dc * dc; vo += dof * dof;
  }
  for (const k of keys) out[k] = { carry: vc > 0 ? parts[k][0] / vc : 0, offline: vo > 0 ? parts[k][1] / vo : 0 };
  return { shares: out, mean: mean as Launch, sd: sd as Launch };
}
