/**
 * Pretend launch monitor connector for the e2e run, played like a golfer would (the golfer lives in demo.ts).
 *   node connector.ts <tapPort> <uiPort> <mode> [args]
 *     hello              heartbeat only (the monitor says it's ready)
 *     one [right]        one shot with the current club; "right" pushes it well right
 *     plan               follow the practice plan until it ends (env UNTIL=club:n pauses there)
 *     label <n>          n shots with whatever club is on screen
 */
import net from 'node:net';
import { Golfer, prof } from '../demo.ts';

const [TAP, UI, MODE, ARG] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4] ?? 'plan', process.argv[5]];
const PACE = Number(process.env.PACE ?? 650);
const golfer = new Golfer(Number(process.env.SEED) || 20261103);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const get = async (p: string) => (await fetch(`http://127.0.0.1:${UI}${p}`)).json();
/** Sends one shot and waits until the app has filed it, so the next decision sees it. */
async function hit(msg: any) {
  const before = (await get('/api/stats')).shotsSaved;
  sock.write(JSON.stringify(msg));
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) { if ((await get('/api/stats')).shotsSaved > before) break; await sleep(80); }
}
const sock = net.connect({ host: '127.0.0.1', port: TAP });
await new Promise<void>(r => sock.on('connect', () => r()));
sock.on('data', () => { /* acks */ });
sock.write(JSON.stringify(Golfer.hello()));
await sleep(400);

if (MODE === 'hello') { await sleep(300); sock.end(); process.exit(0); }
if (MODE === 'one') {
  const s = await get('/api/state');
  await hit(golfer.shot(s.label?.club ?? '7i', { push: ARG === 'right' }));
  await sleep(400); sock.end(); process.exit(0);
}
if (MODE === 'label') {
  for (let i = 0; i < Number(ARG || 10); i++) {
    const s = await get('/api/state');
    await hit(golfer.shot(s.label.club, { spread: Number(process.env.SPREAD || 1) }));
    await sleep(PACE / 2);
  }
  await sleep(1200); sock.end(); process.exit(0);
}

const [untilClub, untilN] = (process.env.UNTIL ?? '').split(':');
let idle = 0;
for (;;) {
  const v: any = await get('/api/session');
  const p = v.plan;
  if (!p?.active || !p.step) { if (++idle > 12) break; await sleep(500); continue; }
  idle = 0;
  if (untilClub && p.step.club === untilClub && p.done >= Number(untilN)) break;
  const partial = p.step.domain === 'partial' ? p.step.targetYd / prof(p.step.club).trueYd : 1;
  await hit(golfer.shot(p.step.club, { partial }));
  await sleep(PACE / 2);
}
await sleep(1500);
sock.end();
process.exit(0);
