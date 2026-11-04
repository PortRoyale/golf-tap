/**
 * The built-in demo: a pretend GSPro and a pretend golfer, so the whole app can be tried
 * with no launch monitor and no simulator. Used by `golf-tap --demo` and by the e2e tests.
 *
 * The pretend GSPro flies each shot with HIDDEN coefficients (the app's physics learner never
 * sees them) and writes the result to a GSPro.db LastShot table and a Player.log, the way the
 * real one is read. The pretend golfer has true carries that differ from a typical guess, so
 * "Find my real numbers" has something to find, and a weak 5 iron for the bag check to catch.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { flyWith, SHAPES } from './physics.ts';

const HIDDEN = { shape: 'sat5', x: [0.235, 0.21, 0.34, 0.155, 23] };
const SH = SHAPES.find(s => s.id === HIDDEN.shape)!;
const fly = (L: any) => flyWith(L, SH.coef(HIDDEN.x), SH.tau(HIDDEN.x), 0.004);
const YD = 0.9144, MPH = 0.44704;

// ---------------------------------------------------------------- pretend GSPro

export interface MiniSql { run(q: string, ...p: any[]): any; exec(q: string): void }

export function startFakeGspro(port: number, dir: string, db: MiniSql, onListen?: () => void) {
  fs.mkdirSync(dir, { recursive: true });
  const LOG = path.join(dir, 'Player.log');
  db.exec(`CREATE TABLE IF NOT EXISTS LastShot(ID INTEGER PRIMARY KEY AUTOINCREMENT, DateCreated TEXT, ShotData TEXT);
CREATE TABLE IF NOT EXISTS Settings(Key TEXT PRIMARY KEY, Value TEXT);
INSERT OR IGNORE INTO Settings VALUES('Version','3.49.11.13 (demo)'),('RangeElevationFt','0'),('Firmness','Normal'),('Units','Yards');`);
  fs.writeFileSync(LOG, 'GSPro demo log\nPhysics 2.0 loaded\n');
  const srv = net.createServer((s) => {
    fs.appendFileSync(LOG, `${new Date().toISOString()} OpenConnect client connected\n`);
    s.write(JSON.stringify({ Code: 201, Message: 'GSPro Player Information', Player: { Handed: 'RH', Club: 'I7' } }));
    let buf = '';
    s.on('data', (c) => {
      buf += c.toString();
      let i: number;
      while ((i = buf.indexOf('}{')) >= 0 || (buf.trim().endsWith('}') && buf.length)) {
        const cut = i >= 0 ? i + 1 : buf.length;
        const raw = buf.slice(0, cut); buf = buf.slice(cut);
        let m: any; try { m = JSON.parse(raw); } catch { break; }
        if (!m.BallData || m.ShotDataOptions?.IsHeartBeat) continue;
        s.write(JSON.stringify({ Code: 200, Message: 'Shot received successfully' }));
        const b = m.BallData;
        setTimeout(() => {
          const f = fly({ ballSpeed: b.Speed * MPH, vla: b.VLA, hla: b.HLA, spin: b.TotalSpin, spinAxis: b.SpinAxis });
          const roll = Math.max(0, 52 - f.landAngle) * 0.008;
          const shot = { Club: m.Club ?? 'I7', BallSpeed: b.Speed, VLA: b.VLA, HLA: b.HLA, TotalSpin: b.TotalSpin, SpinAxis: b.SpinAxis,
            CarryDistance: +(f.carry / YD).toFixed(1), TotalDistance: +((f.carry / YD) * (1 + roll)).toFixed(1), Offline: +(f.offline / YD).toFixed(1),
            PeakHeight: +(f.apex / YD).toFixed(1), DescentAngle: +f.landAngle.toFixed(1), ShotNumber: m.ShotNumber };
          db.run(`INSERT INTO LastShot(DateCreated, ShotData) VALUES(?, ?)`, new Date().toISOString(), JSON.stringify(shot));
          fs.appendFileSync(LOG, `${new Date().toISOString()} Shot ${m.ShotNumber}: carry ${shot.CarryDistance} offline ${shot.Offline}\n`);
        }, 250);
      }
    });
    s.on('error', () => { /* */ });
  });
  srv.listen(port, '127.0.0.1', onListen);
  return srv;
}

// ---------------------------------------------------------------- pretend golfer

export interface Prof { vla: number; spin: number; sdSpeed: number; sdVla: number; sdHla: number; sdSpin: number; sdAxis: number; hlaBias: number; axisBias: number; trueYd: number }
const BASE = { sdSpeed: 0.015, sdVla: 1.0, sdHla: 1.6, sdSpin: 0.06, sdAxis: 3.5, hlaBias: 0.3, axisBias: 1 };
export const GOLFER: Record<string, Prof> = {
  DRIVER: { ...BASE, vla: 12.5, spin: 2650, sdSpeed: 0.018, sdVla: 1.3, sdHla: 2.0, sdSpin: 0.09, sdAxis: 4.5, hlaBias: -0.4, axisBias: 1.5, trueYd: 258 },
  '3W': { ...BASE, vla: 11.5, spin: 3600, sdHla: 2.0, sdAxis: 4.5, trueYd: 232 },
  '5W': { ...BASE, vla: 12.5, spin: 4300, sdHla: 1.9, sdAxis: 4.2, trueYd: 216 },
  '4H': { ...BASE, vla: 13, spin: 4600, sdHla: 2.0, sdAxis: 4.2, trueYd: 196 },
  '4I': { ...BASE, vla: 12, spin: 4600, sdHla: 2.6, sdAxis: 5.2, hlaBias: 1, axisBias: 2.5, trueYd: 188 },
  '5I': { ...BASE, vla: 13, spin: 5200, sdSpeed: 0.03, sdHla: 3.0, sdAxis: 6, hlaBias: 1.4, axisBias: 3.5, trueYd: 179 },
  '6I': { ...BASE, vla: 14.5, spin: 6000, trueYd: 168 },
  '7I': { ...BASE, vla: 16.5, spin: 6800, trueYd: 156 },
  '8I': { ...BASE, vla: 18.5, spin: 7600, trueYd: 144 },
  '9I': { ...BASE, vla: 21, spin: 8400, sdHla: 1.4, sdAxis: 3, trueYd: 131 },
  PW: { ...BASE, vla: 25, spin: 9000, sdHla: 1.3, sdAxis: 2.5, trueYd: 116 },
  GW: { ...BASE, vla: 28, spin: 9300, sdHla: 1.3, sdAxis: 2.5, trueYd: 101 },
  SW: { ...BASE, vla: 31, spin: 9500, sdHla: 1.4, sdAxis: 2.5, trueYd: 86 },
  LW: { ...BASE, vla: 34, spin: 9200, sdHla: 1.5, sdAxis: 2.5, sdSpeed: 0.022, trueYd: 68 },
};
export const prof = (club: string): Prof => GOLFER[club.toUpperCase()] ?? { ...BASE, vla: 16, spin: 6800, trueYd: 150 };
export const CODE: Record<string, string> = { DRIVER: 'DR', '3W': 'W3', '5W': 'W5', '4H': 'H4', '4I': 'I4', '5I': 'I5', '6I': 'I6', '7I': 'I7', '8I': 'I8', '9I': 'I9', PW: 'PW', GW: 'GW', SW: 'SW', LW: 'LW' };

export class Golfer {
  private a: number;
  private n = 1;
  private speedCache = new Map<string, number>();
  constructor(seed = 20261103) { this.a = seed >>> 0; }
  private u() { this.a = (this.a + 0x6d2b79f5) >>> 0; let t = this.a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
  private g() { let x = 0; while (x === 0) x = this.u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * this.u()); }
  private speedFor(p: Prof, yd: number): number {
    const key = `${p.vla}|${p.spin}|${yd.toFixed(1)}`;
    const hit = this.speedCache.get(key); if (hit) return hit;
    let lo = 30, hi = 200;
    for (let i = 0; i < 36; i++) { const m = (lo + hi) / 2; if (fly({ ballSpeed: m * MPH, vla: p.vla, hla: 0, spin: p.spin, spinAxis: 0 }).carry / YD < yd) lo = m; else hi = m; }
    this.speedCache.set(key, (lo + hi) / 2);
    return (lo + hi) / 2;
  }
  /** One OpenConnect shot message. spread scales the golfer's scatter (below 1 = a tighter day). */
  shot(club: string, opts: { push?: boolean; partial?: number; spread?: number } = {}) {
    const p = prof(club), k = opts.spread ?? 1;
    const v = this.speedFor(p, p.trueYd * (opts.partial ?? 1));
    const z = this.g(), hla = opts.push ? 7 + 0.5 * this.g() : p.hlaBias + p.sdHla * k * z;
    return {
      DeviceID: 'Demo launch monitor (simulated)', Units: 'Yards', ShotNumber: this.n++, APIversion: '1', Club: CODE[club.toUpperCase()] ?? 'I7',
      BallData: {
        Speed: +(v * (1 + p.sdSpeed * k * this.g())).toFixed(1), VLA: +(p.vla + p.sdVla * k * this.g()).toFixed(1), HLA: +hla.toFixed(1),
        TotalSpin: Math.round(p.spin * (1 + p.sdSpin * k * this.g())), SpinAxis: +(p.axisBias + 0.35 * (hla - p.hlaBias) + p.sdAxis * k * this.g()).toFixed(1), CarryDistance: 0,
      },
      ClubData: { Speed: +(v / 1.38).toFixed(1), AngleOfAttack: -3.5, FaceToTarget: +(hla * 0.8).toFixed(1), Path: +(hla * 0.8 - 1).toFixed(1) },
      ShotDataOptions: { ContainsBallData: true, ContainsClubData: true, LaunchMonitorIsReady: true, IsHeartBeat: false },
    };
  }
  static hello() { return { DeviceID: 'Demo launch monitor (simulated)', Units: 'Yards', ShotNumber: 0, APIversion: '1', ShotDataOptions: { ContainsBallData: false, ContainsClubData: false, LaunchMonitorIsReady: true, IsHeartBeat: true } }; }
}

/** A pretend launch monitor connector: one socket to the app's listen port, like a real connector. */
export class DemoMonitor {
  private sock: net.Socket | null = null;
  readonly golfer = new Golfer();
  private port: number;
  constructor(port: number) { this.port = port; }
  async connect() {
    if (this.sock && !this.sock.destroyed) return;
    const s = net.connect({ host: '127.0.0.1', port: this.port });
    await new Promise<void>((res, rej) => { s.once('connect', () => res()); s.once('error', rej); });
    s.on('data', () => { /* acks */ });
    s.on('error', () => { /* */ });
    s.on('close', () => { if (this.sock === s) this.sock = null; });
    this.sock = s;
    s.write(JSON.stringify(Golfer.hello()));
  }
  async send(msg: any) { await this.connect(); this.sock!.write(JSON.stringify(msg)); }
  close() { this.sock?.end(); this.sock = null; }
}
