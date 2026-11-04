/**
 * The shape of the bounce and roll, for drawing it. Scoring uses GSPro's own roll-out: with these published
 * turf constants (measured on a firm teeing area) a 5 iron runs about 30 yards on a 10-stimp green, which is
 * too far, so the model is used for the hops' shape and scaled to where GSPro says the ball stopped.
 *
 * Bounce: a rigid ball with Coulomb friction hitting turf that is locally tilted toward it by the crater
 * it makes. Penner's form: the tilt grows with impact speed times landing angle, beta = k * s * phi (s in
 * ball radii per second, beta and phi in the same angle unit), so fast, steep landings dig in and slow hops
 * don't. Constants are the fit to bounces on a well-kept natural teeing area: Biber, Jones, Champneys,
 * Green and Szalai, "Measurements and linearized models for golf ball bounce", arXiv:2302.02758 (2023),
 * Table 3, campaign B, Penner model: k = 2.973e-4, restitution 0.222, friction 0.999. The same friction
 * acts while the ball skids after the last bounce.
 *
 * Roll: constant deceleration once the ball rolls without skidding. A green's deceleration follows from
 * the stimpmeter's definition: it releases the ball at 6.00 ft/s (1.83 m/s) and the green's speed is how
 * far it rolls, so a = v^2 / (2 d). Standard green: 10 ft, the USGA's medium speed for regular greens.
 *
 * Units: metres, seconds, rpm. Backspin is positive.
 */

export const G = 9.80665;
export const BALL_R = 0.04267 / 2;
export const TURF = { k: 2.973e-4, restitution: 0.222, friction: 0.999, source: 'Biber et al. 2023 (arXiv:2302.02758), Table 3, campaign B, Penner model' } as const;
export const STIMP_RELEASE = 1.83;
export const GREEN_STIMP_FT = 10;
export const decelFromStimp = (ft: number) => (STIMP_RELEASE * STIMP_RELEASE) / (2 * ft * 0.3048);
export const stimpFromDecel = (a: number) => (STIMP_RELEASE * STIMP_RELEASE) / (2 * a) / 0.3048;
export const GREEN_DECEL = decelFromStimp(GREEN_STIMP_FT);

export interface Touchdown { speed: number; angleDeg: number; spinRpm: number }
export interface Settle {
  /** Distance from the first landing to where the ball stops, along the line it landed on (negative: it came back). */
  run: number;
  hops: { from: number; to: number; height: number }[];
  /** Distance travelled before it starts to roll without skidding, and its speed then. */
  skidTo: number; rollSpeed: number;
  /** For drawing: [distance, height, t] samples from landing to rest. */
  path: number[][];
}

/** One impact with the tilted turf. Returns the velocity and spin as the ball leaves it. */
export function impact(vx: number, vy: number, w: number, turf = TURF) {
  const R = BALL_R, s = Math.hypot(vx, vy) / R, phi = Math.atan2(-vy, Math.abs(vx) || 1e-9);
  const b = Math.min(Math.PI / 3, turf.k * s * phi) * Math.sign(vx || 1), cb = Math.cos(b), sb = Math.sin(b);
  let vt = vx * cb + vy * sb;
  const vn = -vx * sb + vy * cb;               // negative: into the turf
  const vn2 = -turf.restitution * vn;
  const u = vt + w * R;                        // the contact point's slip
  const stop = (2 / 7) * u, cap = turf.friction * (1 + turf.restitution) * -vn;
  let w2: number;
  if (Math.abs(stop) <= cap) { vt -= stop; w2 = w - (5 / 7) * u / R; }
  else { const J = Math.sign(u) * cap; vt -= J; w2 = w - (5 / 2) * J / R; }
  return { vx: vt * cb - vn2 * sb, vy: vt * sb + vn2 * cb, w: w2 };
}

/** From touchdown to rest on a surface that decelerates a rolling ball at rollDecel (m/s^2). */
export function settle(td: Touchdown, rollDecel: number, turf = TURF): Settle {
  const a = (td.angleDeg * Math.PI) / 180;
  let vx = td.speed * Math.cos(a), vy = -td.speed * Math.sin(a), w = (td.spinRpm * 2 * Math.PI) / 60;
  let x = 0, t = 0;
  const hops: Settle['hops'] = [], path: number[][] = [[0, 0, 0]];
  for (let i = 0; i < 12; i++) {
    const o = impact(vx, vy, w, turf);
    vx = o.vx; w = o.w;
    if (o.vy < 0.25) { vy = 0; break; }        // too little to leave the ground: it skids on
    const ft = (2 * o.vy) / G, h = (o.vy * o.vy) / (2 * G);
    for (let k = 1; k <= 8; k++) { const s = (k / 8) * ft; path.push([x + vx * s, o.vy * s - 0.5 * G * s * s, t + s]); }
    hops.push({ from: x, to: x + vx * ft, height: h });
    x += vx * ft; t += ft; vy = -o.vy;
  }
  // Skid until the ball rolls: friction slows the slip at (7/2) mu g.
  const u = vx + w * BALL_R, mu = turf.friction;
  const ts = Math.abs(u) / (3.5 * mu * G), dir = Math.sign(u);
  const skid = vx * ts - 0.5 * dir * mu * G * ts * ts;
  for (let k = 1; k <= 4; k++) { const s = (k / 4) * ts; path.push([x + vx * s - 0.5 * dir * mu * G * s * s, 0, t + s]); }
  x += skid; t += ts;
  const v = vx - dir * mu * G * ts;
  const skidTo = x;
  // Roll to a stop.
  const tr = Math.abs(v) / rollDecel, roll = Math.sign(v) * (v * v) / (2 * rollDecel);
  for (let k = 1; k <= 10; k++) { const s = (k / 10) * tr; path.push([x + v * s - 0.5 * Math.sign(v) * rollDecel * s * s, 0, t + s]); }
  x += roll;
  return { run: x, hops, skidTo, rollSpeed: v, path };
}

/** Which standard surface a club plays to. */
export const surfaceFor = (clubClass: string): 'fairway' | 'green' => (['driver', 'wood'].includes(clubClass) ? 'fairway' : 'green');
