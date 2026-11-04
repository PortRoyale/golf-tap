// node --test rollout.test.ts
// Physical sanity of the bounce and roll model used to draw each shot's hops and roll-out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { impact, settle, GREEN_DECEL, decelFromStimp, stimpFromDecel, BALL_R } from './rollout.ts';

const energy = (vx: number, vy: number, w: number) => 0.5 * (vx * vx + vy * vy) + 0.5 * 0.4 * BALL_R * BALL_R * w * w; // per unit mass

test('an impact never adds energy', () => {
  for (const v of [5, 15, 30]) for (const ang of [20, 40, 60]) for (const rpm of [-2000, 0, 3000, 9000]) {
    const a = (ang * Math.PI) / 180, vx = v * Math.cos(a), vy = -v * Math.sin(a), w = (rpm * 2 * Math.PI) / 60;
    const o = impact(vx, vy, w);
    assert.ok(energy(o.vx, o.vy, o.w) <= energy(vx, vy, w) * (1 + 1e-9), `v ${v} angle ${ang} spin ${rpm}`);
    assert.ok(o.vy >= 0, 'leaves the ground going up, or not at all');
  }
});

test('the stimpmeter relation round-trips, and a 10 ft green decelerates about 0.55 m/s^2', () => {
  assert.ok(Math.abs(stimpFromDecel(decelFromStimp(11)) - 11) < 1e-9);
  assert.ok(Math.abs(GREEN_DECEL - 0.549) < 0.002);
});

test('more backspin stops it sooner; a heavily spun steep wedge comes back', () => {
  const runs = [2000, 5000, 8000, 11000].map(rpm => settle({ speed: 22, angleDeg: 51, spinRpm: rpm }, GREEN_DECEL).run);
  for (let i = 1; i < runs.length; i++) assert.ok(runs[i] < runs[i - 1], `run should fall with spin: ${runs.map(r => r.toFixed(2)).join(', ')}`);
  assert.ok(settle({ speed: 22, angleDeg: 51, spinRpm: 9060 }, GREEN_DECEL).run < 0, 'spins back');
});

test('a steeper landing runs less, and a slower surface stops it sooner', () => {
  const flat = settle({ speed: 28, angleDeg: 30, spinRpm: 2500 }, 2).run, steep = settle({ speed: 28, angleDeg: 45, spinRpm: 2500 }, 2).run;
  assert.ok(steep < flat);
  assert.ok(settle({ speed: 28, angleDeg: 36, spinRpm: 2000 }, 3).run < settle({ speed: 28, angleDeg: 36, spinRpm: 2000 }, 1).run);
});

test('the drawn path starts at the landing, stays above ground and ends at the run', () => {
  const st = settle({ speed: 25, angleDeg: 44, spinRpm: 4440 }, GREEN_DECEL);
  assert.deepEqual(st.path[0], [0, 0, 0]);
  assert.ok(st.path.every(p => p[1] >= -1e-9));
  assert.ok(Math.abs(st.path[st.path.length - 1][0] - st.run) < 1e-6);
  for (let i = 1; i < st.path.length; i++) assert.ok(st.path[i][2] >= st.path[i - 1][2], 'time runs forward');
});
