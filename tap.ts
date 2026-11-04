/**
 * Shot Quality Engine — Wire Tap and live session recorder.
 *
 * What it does, in order of importance:
 *   1. Sits between the launch monitor connector and GSPro on the OpenConnect port
 *      and relays every byte unchanged, in both directions. It fails open: if any
 *      capture code breaks, the relay keeps running.
 *   2. Records EVERYTHING it can see to captures/tap-<time>.ndjson: every TCP chunk
 *      (hex + text), every parsed JSON message, every new or changed row in any
 *      table of any GSPro SQLite file it finds, and every new line of GSPro and
 *      connector log files. Nothing is filtered at capture time.
 *   3. Learns the field schema live, so you can see what data exists before deciding
 *      what to use.
 *   4. Optional: maps discovered fields to offline/carry/total, assembles shots, saves
 *      them to sqe.db (SQLite), and scores sets live with engine.ts.
 *
 * Run (no install beyond one of these):
 *   tap.exe                      Windows build, nothing else needed
 *   node tap.ts                  Node 22.18+ (runs TypeScript directly)
 *   bun tap.ts                   Bun 1.1+
 *
 * Modes:
 *   default        listen :9211, forward to 127.0.0.1:921   (point the LM connector at 9211)
 *   --inline       listen :921,  forward to 127.0.0.1:922   (move GSPro's API to 922 first)
 *   --no-upstream  capture only, forward nothing
 *   --db-only      no TCP at all; watch GSPro files only     (when the connector can't be repointed)
 *
 * Other flags:
 *   --listen <port>  --upstream <host:port>  --ui <port>  --ui-host <addr>
 *   --gsprodb <path> (repeatable)  --watch <dir> (repeatable)  --poll <ms>
 */

import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import * as E from './engine.ts';
import * as P from './physics.ts';
import { APP_HTML, FONTS } from './ui.gen.ts';
import * as Demo from './demo.ts';
import * as Roll from './rollout.ts';

// ---------------------------------------------------------------- background fit worker mode
// The same program, started with --fit-worker, learns physics from a job on stdin and exits.
// Running it as a separate process means a fit can never delay a shot reaching GSPro.
if (process.argv.includes('--fit-worker')) {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const job = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const change = job.previous && job.recent?.length ? P.detectChange(job.recent, job.previous) : null;
  const fit = P.learn(job.pairs, job.sim, job.previous);
  const gate = P.gate(job.pairs, fit);
  process.stdout.write(JSON.stringify({ fit, gate, change }));
  process.exit(0);
}

// ---------------------------------------------------------------- quiet sqlite warning

const _emitWarning = process.emitWarning.bind(process);
(process as any).emitWarning = (w: any, ...rest: any[]) => {
  const msg = typeof w === 'string' ? w : w?.message ?? '';
  if (/SQLite is an experimental feature/i.test(msg)) return;
  return (_emitWarning as any)(w, ...rest);
};

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const opts = (n: string) => { const out: string[] = []; argv.forEach((a, i) => { if (a === `--${n}` && argv[i + 1]) out.push(argv[i + 1]); }); return out; };

/** The built-in demo: a pretend GSPro and launch monitor, its own data folder and ports, nothing real touched. */
const DEMO = flag('demo');
const INLINE = flag('inline');
const DB_ONLY = flag('db-only');
const NO_UP = flag('no-upstream') || DB_ONLY;
const LISTEN_PORT = Number(opt('listen', DEMO ? '9291' : INLINE ? '921' : '9211'));
const [UP_HOST, UP_PORT_S] = opt('upstream', DEMO ? '127.0.0.1:9292' : INLINE ? '127.0.0.1:922' : '127.0.0.1:921').split(':');
const UP_PORT = Number(UP_PORT_S || 921);
const UI_PORT = Number(opt('ui', DEMO ? '8090' : '8080'));
const UI_HOST = opt('ui-host', '127.0.0.1');
const POLL_MS = Math.max(100, Number(opt('poll', DEMO ? '150' : '200')));
const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';
/** The one version number. A release tag must equal `v${APP_VERSION}`; CI refuses to publish otherwise. */
export const APP_VERSION = '1.3.1';
const VERSION = `golf-tap ${APP_VERSION} / engine ${E.ALGO_VERSION} / physics learner`;
const REPO = 'PortRoyale/golf-tap';

/** True inside the single-file executable built by `bun build --compile`. */
const COMPILED = typeof (globalThis as any).Bun !== 'undefined' && /\$bunfs|~BUN/i.test(String((globalThis as any).Bun?.main ?? ''));
/** Data lives next to the program so an update (which swaps only the exe) never touches it. */
const BASE_DIR = COMPILED ? path.dirname(process.execPath) : process.cwd();
const DATA_DIR = DEMO ? path.join(BASE_DIR, 'demo-data') : BASE_DIR;
// The demo starts fresh every time.
if (DEMO && !flag('demo-keep')) { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ } }
fs.mkdirSync(DATA_DIR, { recursive: true });
const DEMO_GSPRO_DIR = path.join(DATA_DIR, 'pretend-gspro');

const T0 = Date.now();
/** Demo runs only (GOLF_TAP_DEMO_CLOCK=1): sessions can be dated in the past so the History screen has weeks to show. */
const DEMO_CLOCK = DEMO || process.env.GOLF_TAP_DEMO_CLOCK === '1';
let clockShiftMs = 0;
const nowMs = () => Date.now() + clockShiftMs;
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const CAP_DIR = path.join(DATA_DIR, 'captures');
fs.mkdirSync(CAP_DIR, { recursive: true });
const LOG_PATH = path.join(CAP_DIR, `tap-${STAMP}.ndjson`);
const SCHEMA_PATH = path.join(CAP_DIR, `tap-${STAMP}.schema.json`);
const CONFIG_PATH = path.join(DATA_DIR, 'sqe-config.json');
const SQE_DB_PATH = path.join(DATA_DIR, 'sqe.db');
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

// ---------------------------------------------------------------- event bus

type Ev = Record<string, any>;
let seq = 0;
const RING_MAX = 3000;
const ring: Ev[] = [];
const sse = new Set<http.ServerResponse>();

function emit(ev: Ev): Ev {
  ev.seq = ++seq;
  ev.t = Date.now() - T0;
  ev.iso = new Date().toISOString();
  ring.push(ev);
  if (ring.length > RING_MAX) ring.shift();
  try { logStream.write(JSON.stringify(ev) + '\n'); } catch { /* disk full must not stop relay */ }
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const r of sse) { try { r.write(payload); } catch { /* gone */ } }
  return ev;
}

function note(level: 'info' | 'warn' | 'error', msg: string, extra: Ev = {}) {
  emit({ kind: 'note', level, msg, ...extra });
  console.log(`${level === 'error' ? '!!' : level === 'warn' ? ' !' : '  '} ${msg}`);
}

/** Any capture-side failure is logged and swallowed. The relay is never allowed to die for it. */
function guard<T>(what: string, f: () => T): T | undefined {
  try { return f(); } catch (e: any) { note('error', `${what}: ${e?.message ?? e}`); return undefined; }
}

const stats = {
  version: VERSION,
  started: new Date().toISOString(),
  mode: DB_ONLY ? 'db-only' : NO_UP ? 'capture-only' : INLINE ? 'inline' : 'proxy',
  listenPort: DB_ONLY ? null : LISTEN_PORT,
  upstream: NO_UP ? null : `${UP_HOST}:${UP_PORT}`,
  upstreamListening: null as boolean | null,
  upstreamCheck: 'not run',
  conns: 0, liveConns: 0,
  bytesLM: 0, bytesGS: 0, msgsLM: 0, msgsGS: 0, badJson: 0,
  dbFiles: 0, dbRows: 0, dbUpdates: 0, fileLines: 0,
  shotsFired: 0, shotsSaved: 0, shotsIncomplete: 0,
  logPath: LOG_PATH, sqeDb: SQE_DB_PATH,
};

// ---------------------------------------------------------------- json framing + schema

/** Pull complete top-level JSON objects from a stream buffer. String- and escape-aware; TCP may split or merge messages. */
function extractJson(s: string): { objs: string[]; rest: string } {
  let depth = 0, inStr = false, esc = false, start = -1, lastEnd = 0;
  const objs: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { if (depth > 0) inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}' && depth > 0) { depth--; if (depth === 0 && start >= 0) { objs.push(s.slice(start, i + 1)); lastEnd = i + 1; start = -1; } }
  }
  const rest = depth > 0 && start >= 0 ? s.slice(start) : s.slice(lastEnd);
  return { objs, rest: depth === 0 && rest.indexOf('{') < 0 ? '' : rest };
}

function flatten(obj: any, prefix = '', out: Record<string, any> = {}): Record<string, any> {
  if (obj === null || typeof obj !== 'object') { out[prefix || 'value'] = obj; return out; }
  for (const k of Object.keys(obj)) {
    const v = obj[k], p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatten(v, p, out);
    else if (typeof v === 'string' && /^\s*[{[]/.test(v)) {
      // GSPro stores shot JSON as text inside SQLite columns: unpack it so its fields are visible.
      try { const j = JSON.parse(v); if (j && typeof j === 'object') { flatten(j, p, out); continue; } } catch { /* plain string */ }
      out[p] = v;
    } else out[p] = v;
  }
  return out;
}

interface FieldInfo { src: string; path: string; count: number; types: Set<string>; min: number | null; max: number | null; samples: string[]; last: any; firstSeq: number; lastSeq: number }
const schema = new Map<string, FieldInfo>();

function learn(src: string, flat: Record<string, any>) {
  for (const p of Object.keys(flat)) {
    const v = flat[p];
    const key = `${src}|${p}`;
    let e = schema.get(key);
    if (!e) {
      e = { src, path: p, count: 0, types: new Set(), min: null, max: null, samples: [], last: null, firstSeq: seq + 1, lastSeq: seq + 1 };
      schema.set(key, e);
      note('info', `new field [${src}] ${p} = ${JSON.stringify(v)?.slice(0, 80)}`);
    }
    e.count++; e.lastSeq = seq + 1; e.last = v;
    e.types.add(v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
    const num = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
    if (num !== null && Number.isFinite(num)) { e.min = e.min === null ? num : Math.min(e.min, num); e.max = e.max === null ? num : Math.max(e.max, num); }
    if (e.samples.length < 6) { const s = JSON.stringify(v)?.slice(0, 60) ?? 'undefined'; if (!e.samples.includes(s)) e.samples.push(s); }
  }
}

function schemaDump() {
  return [...schema.values()].map(e => ({ src: e.src, path: e.path, count: e.count, types: [...e.types], min: e.min, max: e.max, samples: e.samples, last: e.last }))
    .sort((a, b) => a.src.localeCompare(b.src) || a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------- shot assembly

type Source = 'LM' | 'DB' | 'FILE';
interface Sample { src: Source; at: number; flat: Record<string, any>; raw: any; ref: string }
const recent: Record<Source, Sample[]> = { LM: [], DB: [], FILE: [] };

function observe(s: Sample) {
  const list = recent[s.src];
  list.push(s);
  while (list.length > 40 || (list.length && s.at - list[0].at > 30000)) list.shift();
  guard('assembler', () => assemble(s));
}

// ---------------------------------------------------------------- TCP proxy

const probePorts = new Set<number>();
let lastDevice = '';

function makeSink(dir: 'LM' | 'GS', connId: number, reply?: (o: any) => void) {
  let buf = '';
  const seen = new Set<string>();
  return (chunk: Buffer) => {
    if (dir === 'LM') stats.bytesLM += chunk.length; else stats.bytesGS += chunk.length;
    emit({ kind: 'raw', dir, connId, bytes: chunk.length, hex: chunk.toString('hex'), utf8: chunk.toString('utf8') });
    buf += chunk.toString('utf8');
    if (buf.length > 2_000_000) { note('warn', `${dir} #${connId}: 2MB without a complete JSON object, dropping parse buffer (raw bytes are still logged)`); buf = ''; return; }
    const { objs, rest } = extractJson(buf);
    buf = rest;
    for (const raw of objs) {
      let parsed: any;
      try { parsed = JSON.parse(raw); } catch (e: any) { stats.badJson++; emit({ kind: 'badjson', dir, connId, raw, err: String(e?.message ?? e) }); continue; }
      const flat = flatten(parsed);
      learn(dir, flat);
      if (dir === 'LM') stats.msgsLM++; else stats.msgsGS++;
      emit({ kind: 'msg', dir, connId, raw, parsed });
      if (dir === 'LM') {
        const sn = flat['ShotNumber'];
        const key = sn !== undefined ? `sn:${sn}` : raw;
        const hb = flat['ShotDataOptions.IsHeartBeat'] === true;
        if (typeof flat['DeviceID'] === 'string') lastDevice = flat['DeviceID'];
        if (!hb && !seen.has(key)) { seen.add(key); observe({ src: 'LM', at: Date.now(), flat, raw: parsed, ref: `conn${connId}:${sn ?? stats.msgsLM}` }); }
        if (reply && !hb && flat['ShotDataOptions.ContainsBallData'] !== false && flat['BallData.Speed'] !== undefined) reply({ Code: 200, Message: 'Shot received successfully' });
      }
    }
    if (buf.length) emit({ kind: 'partial', dir, connId, held: buf.length, preview: buf.slice(0, 160) });
  };
}

function startProxy() {
  const server = net.createServer((lm) => {
    const connId = ++stats.conns;
    stats.liveConns++;
    const isProbe = probePorts.has(lm.remotePort ?? -1);
    const peer = `${lm.remoteAddress}:${lm.remotePort}`;
    note('info', `conn #${connId} open from ${peer}${isProbe ? ' (probe: not forwarded to GSPro)' : ''}`);
    emit({ kind: 'conn', event: 'open', connId, peer, probe: isProbe });
    // With no GSPro behind us, answer like GSPro does so connectors that wait for an ack keep sending.
    const emulate = NO_UP && !isProbe;
    const reply = emulate ? (o: any) => { const s = JSON.stringify(o); if (!lm.destroyed) lm.write(s); emit({ kind: 'emulated', dir: 'GS', connId, msg: s }); } : undefined;
    const lmSink = makeSink('LM', connId, reply), gsSink = makeSink('GS', connId);
    if (emulate) { lmSockets.add(lm); lm.on('close', () => lmSockets.delete(lm)); setTimeout(pushClubToLM, 300); }
    let gs: net.Socket | null = null;
    let pending: Buffer[] = [];
    let gsReady = false;

    if (!NO_UP && !isProbe) {
      gs = net.connect({ host: UP_HOST, port: UP_PORT }, () => {
        gsReady = true;
        note('info', `conn #${connId} upstream connected -> ${UP_HOST}:${UP_PORT}`);
        for (const c of pending) gs!.write(c);
        pending = [];
      });
      gs.setNoDelay(true);
      gs.on('data', (c) => { if (!lm.destroyed) lm.write(c); guard('capture GS', () => gsSink(c)); });
      gs.on('error', (e) => note('error', `conn #${connId} upstream: ${e.message}. Capture continues; GSPro is not receiving these shots.`));
      gs.on('close', () => { emit({ kind: 'conn', event: 'upstream_close', connId }); if (!lm.destroyed) lm.end(); });
    }
    lm.setNoDelay(true);
    lm.on('data', (c) => {
      // Relay first, capture second.
      if (gs) { if (gsReady && !gs.destroyed) gs.write(c); else pending.push(c); }
      guard('capture LM', () => lmSink(c));
    });
    lm.on('error', (e) => note('warn', `conn #${connId} client: ${e.message}`));
    lm.on('close', () => { stats.liveConns--; note('info', `conn #${connId} closed`); emit({ kind: 'conn', event: 'close', connId }); if (gs && !gs.destroyed) gs.end(); });
  });
  listenRetry(server, LISTEN_PORT, '0.0.0.0', 'proxy');
  return server;
}

/**
 * Right after an in-app update the old copy may hold the ports for a moment.
 * Retry for up to 30 s in that case; otherwise a busy port is a real conflict.
 */
function listenRetry(srv: net.Server | http.Server, port: number, host: string, what: string, onListen?: () => void) {
  const restarted = !!process.env.GOLF_TAP_RESTARTED;
  let tries = 0;
  const attempt = () => srv.listen(port, host, onListen);
  srv.on('error', (e: any) => {
    if (e.code === 'EADDRINUSE' && restarted && ++tries < 60) { setTimeout(attempt, 500); return; }
    if (e.code === 'EADDRINUSE') {
      console.error(`\n  Port ${port} (${what}) is already taken by another program.`);
      if (what === 'proxy') console.error(INLINE ? `  In --inline mode GSPro's own API must be moved to 922 first.` : `  Is golf-tap already running in another window? Pick another port with --listen <port>.`);
      else console.error(`  Is golf-tap already running in another window? Pick another with --ui <port>.`);
    } else console.error(`\n  ${what} listen error: ${e.message}\n`);
    process.exit(1);
  });
  attempt();
}

// ---------------------------------------------------------------- SQLite access (Node or Bun)

interface Sql { all(q: string, ...p: any[]): any[]; run(q: string, ...p: any[]): { lastInsertRowid: number | bigint }; exec(q: string): void; close(): void; kind: string }

async function openSql(file: string, readOnly: boolean): Promise<Sql> {
  if (typeof (globalThis as any).Bun !== 'undefined') {
    const { Database } = await import('bun:sqlite' as string);
    const db = readOnly ? new Database(file, { readonly: true }) : new Database(file, { create: true });
    try { db.exec('PRAGMA busy_timeout = 250'); } catch { /* */ }
    return { kind: 'bun:sqlite', all: (q, ...p) => db.query(q).all(...p), run: (q, ...p) => db.query(q).run(...p), exec: (q) => db.exec(q), close: () => db.close() };
  }
  const spec = 'node:' + 'sqlite';
  const { DatabaseSync } = await import(spec);
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  // Wait up to 250 ms for GSPro to finish a write instead of failing the read.
  try { db.exec('PRAGMA busy_timeout = 250'); } catch { /* */ }
  return { kind: 'node:sqlite', all: (q, ...p) => db.prepare(q).all(...p), run: (q, ...p) => db.prepare(q).run(...p) as any, exec: (q) => db.exec(q), close: () => db.close() };
}

// ---------------------------------------------------------------- GSPro file discovery

const gsproRoots = () => {
  if (DEMO) return [DEMO_GSPRO_DIR];
  const roots = [
    path.join(HOME, 'AppData', 'LocalLow', 'GSPro'),
    path.join(HOME, 'AppData', 'Local', 'GSPro'),
    path.join(HOME, 'AppData', 'Roaming', 'GSPro'),
    'C:\\GSPro', 'D:\\GSPro', 'C:\\Program Files\\GSPro', 'C:\\Program Files (x86)\\GSPro',
    path.join(HOME, 'Documents', 'GSPro'),
  ];
  return [...new Set([...roots, ...opts('watch')])].filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
};

function walk(dir: string, depth: number, out: string[], cap = 4000) {
  if (depth < 0 || out.length > cap) return;
  let ents: fs.Dirent[];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/^(Courses|courses|Cache|cache|Textures|ShaderCache|Crashes)$/.test(e.name)) walk(p, depth - 1, out, cap); }
    else out.push(p);
  }
}

function discoverFiles() {
  const all: string[] = [];
  for (const r of gsproRoots()) walk(r, 4, all);
  const dbs = new Set(opts('gsprodb').map(p => path.resolve(p)));
  const logs = new Set<string>();
  for (const f of all) {
    const low = f.toLowerCase();
    if (/\.(db|sqlite|sqlite3|db3)$/.test(low)) dbs.add(f);
    // Logs and text the connector or GSPro writes. CSV is deliberately not read.
    else if (/\.(log|txt|json)$/.test(low) && !/\.csv$/.test(low)) logs.add(f);
  }
  return { dbs: [...dbs], logs: [...logs] };
}

// ---------------------------------------------------------------- GSPro DB watcher (all tables)

interface TableWatch { name: string; hasRowid: boolean; maxRowid: number; tailHash: string; cols: string[] }
interface DbWatch { file: string; sql: Sql | null; viaCopy: boolean; tables: Map<string, TableWatch>; lastErr: string; size: number; mtime: number; locks: number }
const dbWatches: DbWatch[] = [];

function q(name: string) { return '"' + name.replace(/"/g, '""') + '"'; }

async function attachDb(file: string) {
  if (dbWatches.some(w => w.file === file)) return;
  const w: DbWatch = { file, sql: null, viaCopy: false, tables: new Map(), lastErr: '', size: 0, mtime: 0, locks: 0 };
  dbWatches.push(w);
  stats.dbFiles = dbWatches.length;
  await openWatch(w, true);
}

async function openWatch(w: DbWatch, initial: boolean) {
  try { w.sql?.close(); } catch { /* */ }
  w.sql = null;
  let target = w.file;
  if (w.viaCopy) {
    // GSPro may hold a lock. Read a private copy instead; never touch the original.
    const tmp = path.join(os.tmpdir(), `sqe-copy-${path.basename(w.file)}-${process.pid}`);
    try {
      fs.copyFileSync(w.file, tmp);
      for (const ext of ['-wal', '-shm']) { try { fs.copyFileSync(w.file + ext, tmp + ext); } catch { try { fs.unlinkSync(tmp + ext); } catch { /* */ } } }
    } catch (e: any) { w.lastErr = `copy failed: ${e.message}`; return; }
    target = tmp;
  }
  try {
    w.sql = await openSql(target, true);
    const tabs = w.sql.all(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
    for (const t of tabs) {
      if (w.tables.has(t.name)) continue;
      const cols = w.sql.all(`PRAGMA table_info(${q(t.name)})`).map((c: any) => `${c.name}:${c.type}`);
      const hasRowid = !/WITHOUT\s+ROWID/i.test(t.sql ?? '');
      let maxRowid = 0;
      if (hasRowid) { const r = w.sql.all(`SELECT MAX(rowid) AS m FROM ${q(t.name)}`)[0]; maxRowid = Number(r?.m ?? 0); }
      const tw: TableWatch = { name: t.name, hasRowid, maxRowid, tailHash: '', cols };
      tw.tailHash = tailHash(w.sql, tw);
      w.tables.set(t.name, tw);
      const count = Number(w.sql.all(`SELECT COUNT(*) AS c FROM ${q(t.name)}`)[0]?.c ?? 0);
      emit({ kind: 'db_table', file: w.file, table: t.name, cols, rows: count, createSql: t.sql });
      // Show the most recent rows once, so the shape of each table is visible before any shot.
      const sample = hasRowid ? w.sql.all(`SELECT rowid AS __rowid, * FROM ${q(t.name)} ORDER BY rowid DESC LIMIT 2`) : w.sql.all(`SELECT * FROM ${q(t.name)} LIMIT 2`);
      for (const row of sample) { const flat = flatten(row); learn(`DB:${t.name}`, flat); emit({ kind: 'db_sample', file: w.file, table: t.name, row: plain(row) }); }
    }
    if (initial) note('info', `GSPro data file: ${w.file} (${w.tables.size} tables, read-only via ${w.sql.kind}${w.viaCopy ? ', private copy' : ''})`);
    w.lastErr = '';
  } catch (e: any) {
    w.lastErr = e.message;
    if (!w.viaCopy) { note('warn', `${path.basename(w.file)}: ${e.message}. Switching to reading a private copy.`); w.viaCopy = true; await openWatch(w, initial); }
    else note('warn', `${path.basename(w.file)}: ${e.message}`);
  }
}

function plain(row: any): any {
  const o: any = {};
  for (const k of Object.keys(row)) { const v = row[k]; o[k] = typeof v === 'bigint' ? Number(v) : v instanceof Uint8Array ? `<blob ${v.length}B>` : v; }
  return o;
}

function tailHash(sql: Sql, t: TableWatch): string {
  const rows = t.hasRowid ? sql.all(`SELECT * FROM ${q(t.name)} ORDER BY rowid DESC LIMIT 3`) : sql.all(`SELECT * FROM ${q(t.name)} LIMIT 50`);
  return JSON.stringify(rows.map(plain));
}

let dbPollBusy = false;
async function pollDbs() {
  if (dbPollBusy) return;
  dbPollBusy = true;
  try {
    for (const w of dbWatches) {
      if (w.viaCopy) {
        let st: fs.Stats | null = null, wal: fs.Stats | null = null;
        try { st = fs.statSync(w.file); } catch { continue; }
        try { wal = fs.statSync(w.file + '-wal'); } catch { /* */ }
        const sig = st.mtimeMs + (wal?.mtimeMs ?? 0) + st.size + (wal?.size ?? 0);
        if (sig === w.mtime) continue;
        w.mtime = sig;
        await openWatch(w, false);
      }
      if (!w.sql) continue;
      try {
        // New tables can appear mid-session.
        const n = Number(w.sql.all(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'`)[0]?.c ?? 0);
        if (n !== w.tables.size) await openWatch(w, false);
        for (const t of w.tables.values()) {
          let appended = 0;
          if (t.hasRowid) {
            const rows = w.sql.all(`SELECT rowid AS __rowid, * FROM ${q(t.name)} WHERE rowid > ? ORDER BY rowid LIMIT 500`, t.maxRowid);
            appended = rows.length;
            for (const r of rows) {
              t.maxRowid = Math.max(t.maxRowid, Number(r.__rowid));
              const row = plain(r), flat = flatten(row);
              stats.dbRows++;
              learn(`DB:${t.name}`, flat);
              emit({ kind: 'db_row', file: w.file, table: t.name, row });
              observe({ src: 'DB', at: Date.now(), flat: prefixKeys(t.name, flat), raw: { table: t.name, row }, ref: `${t.name}#${row.__rowid}` });
            }
          }
          const h = tailHash(w.sql, t);
          if (h !== t.tailHash) {
            const before = t.tailHash;
            t.tailHash = h;
            // New rows change the tail too; only an unchanged row count with a changed tail is an in-place update.
            if (before && !appended) {
              // Rows changed in place (an UPDATE), not appended. Report the newest row as it is now.
              const latest = t.hasRowid ? w.sql.all(`SELECT rowid AS __rowid, * FROM ${q(t.name)} ORDER BY rowid DESC LIMIT 1`) : w.sql.all(`SELECT * FROM ${q(t.name)} LIMIT 1`);
              for (const r of latest) {
                const row = plain(r), flat = flatten(row);
                stats.dbUpdates++;
                learn(`DB:${t.name}`, flat);
                emit({ kind: 'db_update', file: w.file, table: t.name, row });
                observe({ src: 'DB', at: Date.now(), flat: prefixKeys(t.name, flat), raw: { table: t.name, row, updated: true }, ref: `${t.name}#${row.__rowid ?? 'u'}@${seq}` });
              }
            }
          }
        }
        w.lastErr = '';
        w.locks = 0;
      } catch (e: any) {
        const transient = /locked|busy/i.test(e.message);
        if (transient) {
          // GSPro writing at the same instant is normal. Retry next poll; only switch to a private copy if it keeps happening.
          if (++w.locks >= 3 && !w.viaCopy) { note('warn', `${path.basename(w.file)} stays locked by GSPro; reading a private copy from now on.`); w.viaCopy = true; await openWatch(w, false); }
          continue;
        }
        if (e.message !== w.lastErr) note('warn', `${path.basename(w.file)} poll: ${e.message}`);
        w.lastErr = e.message;
        if (/malformed|disk i\/o|unable to open/i.test(e.message) && !w.viaCopy) { w.viaCopy = true; await openWatch(w, false); }
      }
    }
  } finally { dbPollBusy = false; }
}

function prefixKeys(table: string, flat: Record<string, any>) {
  const o: Record<string, any> = {};
  for (const k of Object.keys(flat)) o[`${table}.${k}`] = flat[k];
  return o;
}

// ---------------------------------------------------------------- log tailer

interface Tail { file: string; pos: number; partial: string }
const tails = new Map<string, Tail>();

function attachTail(file: string) {
  if (tails.has(file)) return;
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return; }
  tails.set(file, { file, pos: size, partial: '' });
  // Context: the last lines already in the file.
  try {
    const n = Math.min(size, 8192), fd = fs.openSync(file, 'r'), b = Buffer.alloc(n);
    fs.readSync(fd, b, 0, n, size - n); fs.closeSync(fd);
    const lines = b.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-15);
    emit({ kind: 'file_context', file, lines });
  } catch { /* */ }
}

function pollTails() {
  for (const t of tails.values()) {
    let size: number;
    try { size = fs.statSync(t.file).size; } catch { continue; }
    if (size < t.pos) { t.pos = 0; t.partial = ''; emit({ kind: 'note', level: 'info', msg: `log restarted: ${t.file}` }); }
    if (size === t.pos) continue;
    const n = Math.min(size - t.pos, 4_000_000);
    try {
      const fd = fs.openSync(t.file, 'r'), b = Buffer.alloc(n);
      fs.readSync(fd, b, 0, n, t.pos); fs.closeSync(fd);
      t.pos += n;
      const text = t.partial + b.toString('utf8');
      const parts = text.split(/\r?\n/);
      t.partial = parts.pop() ?? '';
      for (const line of parts) {
        if (!line.trim()) continue;
        stats.fileLines++;
        const ev: Ev = { kind: 'file', file: t.file, line };
        const { objs } = extractJson(line);
        for (const raw of objs) {
          try {
            const j = JSON.parse(raw), flat = flatten(j);
            learn(`FILE:${path.basename(t.file)}`, flat);
            ev.json = j;
            observe({ src: 'FILE', at: Date.now(), flat: prefixKeys(path.basename(t.file), flat), raw: { file: t.file, json: j }, ref: `${path.basename(t.file)}@${t.pos}` });
          } catch { /* text line */ }
        }
        emit(ev);
      }
    } catch (e: any) { note('warn', `tail ${t.file}: ${e.message}`); }
  }
}

async function rescanFiles() {
  const { dbs, logs } = discoverFiles();
  for (const d of dbs) await attachDb(d);
  for (const l of logs) attachTail(l);
}

// ---------------------------------------------------------------- ports + upstream health

interface Listen { port: number; pid?: number; name?: string; path?: string }
let lastPorts: Listen[] = [];

function run(cmd: string, args: string[], ms = 9000): Promise<string> {
  return new Promise((res) => execFile(cmd, args, { timeout: ms, windowsHide: true, maxBuffer: 8 << 20 }, (err, out) => res(err ? '' : String(out))));
}

async function listeningPorts(): Promise<Listen[] | null> {
  if (IS_WIN) {
    const ps = `Get-NetTCPConnection -State Listen | Sort-Object LocalPort -Unique | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; [pscustomobject]@{ port = [int]$_.LocalPort; pid = [int]$_.OwningProcess; name = $p.ProcessName; path = $p.Path } } | ConvertTo-Json -Compress`;
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
    if (out.trim()) { try { const j = JSON.parse(out); return (Array.isArray(j) ? j : [j]).map((x: any) => ({ port: x.port, pid: x.pid, name: x.name ?? undefined, path: x.path ?? undefined })); } catch { /* fall through */ } }
    const ns = await run('netstat', ['-ano', '-p', 'tcp']);
    if (!ns) return null;
    const out2: Listen[] = [];
    for (const line of ns.split(/\r?\n/)) { const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i); if (m) out2.push({ port: Number(m[1]), pid: Number(m[2]) }); }
    return out2;
  }
  const ss = await run('ss', ['-ltnpH']);
  if (ss) {
    const out: Listen[] = [];
    for (const line of ss.split('\n')) { const m = line.match(/:(\d+)\s+\S+:\S+\s*(?:users:\(\("([^"]+)",pid=(\d+))?/); if (m) out.push({ port: Number(m[1]), name: m[2], pid: m[3] ? Number(m[3]) : undefined }); }
    return out;
  }
  const ls = await run('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n']);
  if (!ls) return null;
  const out: Listen[] = [];
  for (const line of ls.split('\n').slice(1)) { const c = line.split(/\s+/); const m = c[8]?.match(/:(\d+)$/); if (m) out.push({ name: c[0], pid: Number(c[1]), port: Number(m[1]) }); }
  return out;
}

async function checkUpstream() {
  if (NO_UP) { stats.upstreamCheck = 'not forwarding'; return; }
  const local = /^(127\.|localhost$|0\.0\.0\.0$|::1$)/.test(UP_HOST);
  if (local) {
    const ports = await listeningPorts();
    if (ports) {
      lastPorts = ports;
      const up = ports.find(p => p.port === UP_PORT);
      const was = stats.upstreamListening;
      stats.upstreamListening = !!up;
      stats.upstreamCheck = up ? `GSPro API port ${UP_PORT} is listening (${up.name ?? 'pid ' + up.pid})` : (stats.dbRows + stats.dbUpdates > 0 ? `nothing on port ${UP_PORT}, which is fine: your launch monitor talks to GSPro directly and Pattern reads the shots from GSPro's database` : `nothing is listening on ${UP_PORT}. If your connector is GSPro's own (Foresight, Bushnell and others), that is normal: just hit a shot and Pattern reads it from GSPro's database. An Open API connector needs GSPro open first.`);
      if (was !== stats.upstreamListening) note(up ? 'info' : 'info', stats.upstreamCheck);
      return;
    }
  }
  // Remote upstream, or no OS tool: only probe by connecting when no launch monitor is attached,
  // so a health check can never collide with a live connection.
  if (stats.liveConns > 0) return;
  await new Promise<void>((res) => {
    const s = net.connect({ host: UP_HOST, port: UP_PORT });
    const done = (ok: boolean, why: string) => { s.destroy(); stats.upstreamListening = ok; stats.upstreamCheck = why; res(); };
    s.setTimeout(1500, () => done(false, 'timeout'));
    s.on('connect', () => done(true, `reachable (connect test)`));
    s.on('error', (e) => done(false, e.message));
  });
}

// ---------------------------------------------------------------- recorder: config, sqe.db, scoring

type Unit = 'yd' | 'm' | 'ft' | 'mph' | 'mps' | 'kmh';
interface MapField { src: Source; path: string; unit: Unit; flip?: boolean }
/** measure: what a shot is scored on. 'finish' is where the ball stopped (golf is played to where it ends up); 'carry' is where it landed. */
type Measure = 'finish' | 'carry';
type LabelCfg = { club: string; clubClass: string; shape: string; domain: string; mode: E.Mode; targetYd: number; build: string; measure?: Measure };
type BagClub = { club: string; clubClass: string; stockYd: number; totalYd?: number; measured?: boolean };
interface Step extends LabelCfg { shots: number; note: string }
interface Config {
  player: string;
  handed: 'R' | 'L';
  mapping: { offline?: MapField; carry?: MapField; total?: MapField; ballSpeed?: MapField };
  label: LabelCfg;
  recording: boolean;
  /** What physics the shots went through. Numbers are only comparable across identical setups. */
  setup: { sim: string; simVersion: string; conditions: string; deviceFw: string };
  bag: BagClub[];
  plan: { steps: Step[]; index: number; active: boolean };
  /** Per-player bags; `bag` is the current player's. */
  bags: Record<string, BagClub[]>;
  /** Score where the ball stops (default) or where it lands. */
  scoreOn: Measure;
  /** Width of the fairway a driver or wood is judged against, yards. Part of the target, like its distance. */
  fairwayYd: number;
  /** The user confirmed which way right is with a real shot. */
  directionChecked: boolean;
  /** First-run setup finished on this machine. */
  onboarded: boolean;
}

const defaultConfig: Config = {
  player: 'Player 1', handed: 'R', mapping: {},
  label: { club: '7i', clubClass: 'mid_iron', shape: 'stock', domain: 'full', mode: 'target', targetYd: 150, build: '', measure: 'finish' },
  recording: false,
  setup: { sim: 'GSPro', simVersion: '', conditions: 'practice range, default settings', deviceFw: '' },
  bag: [],
  plan: { steps: [], index: 0, active: false },
  bags: {},
  directionChecked: false,
  onboarded: false,
  scoreOn: 'finish',
  fairwayYd: 30,
};
let cfg: Config = loadConfig();

function loadConfig(): Config {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...defaultConfig, ...j, label: { ...defaultConfig.label, ...(j.label ?? {}) }, mapping: j.mapping ?? {}, setup: { ...defaultConfig.setup, ...(j.setup ?? {}) }, bag: j.bag ?? [], plan: { ...defaultConfig.plan, ...(j.plan ?? {}) }, bags: j.bags ?? {} };
  } catch { return JSON.parse(JSON.stringify(defaultConfig)); }
}

// ---------------------------------------------------------------- practice plans

const WEDGE_FRACTIONS = [0.25, 0.5, 0.75, 1];

/** Builds a guided sequence from the player's own stock yardages. */
/** Where a club is aimed: where it usually stops when scoring the finish (once measured), else its carry. */
function targetFor(b: BagClub): number { return cfg.scoreOn === 'finish' && b.totalYd ? b.totalYd : b.stockYd; }

/** clubs: only these clubs from the bag (all when empty), so you can check a few without the whole bag. */
function makePlan(kind: string, shots: number, clubs: string[] = []): Step[] {
  const only = new Set(clubs.map(c => c.toLowerCase()));
  const bag = [...cfg.bag].filter(b => b.stockYd > 0 && (!only.size || only.has(b.club.toLowerCase()))).sort((a, b) => a.stockYd - b.stockYd);
  // A typed-in guess never decides a score: until a club's distance has been measured, long and short are judged
  // against your own average with it ('discovery'), and left and right against the target line as always.
  const base = (b: Config['bag'][number]): LabelCfg => ({ club: b.club, clubClass: b.clubClass, shape: 'stock', domain: b.clubClass === 'driver' ? 'tee' : 'full', mode: b.measured ? 'target' : 'discovery', targetYd: targetFor(b), build: '', measure: cfg.scoreOn });
  if (kind === 'warmup') {
    // Before a round: the longest club, a middle iron and a wedge (or the clubs you picked), a few shots each.
    let pick = bag;
    if (!only.size && bag.length > 3) {
      const full = bag.filter(b => b.clubClass !== 'wedge' || /^(PW|GW|AW|SW|5\d)$/i.test(b.club));
      const longest = bag[bag.length - 1], wedge = bag.find(b => b.clubClass === 'wedge') ?? bag[0];
      const midYd = (longest.stockYd + wedge.stockYd) / 2, middle = full.filter(b => b !== longest && b !== wedge).sort((a, c) => Math.abs(a.stockYd - midYd) - Math.abs(c.stockYd - midYd))[0];
      pick = [wedge, middle, longest].filter(Boolean) as BagClub[];
    }
    return pick.map(b => ({ ...base(b), shots, note: `Warm-up: ${b.club}, stock swing to ${targetFor(b)} yd.` }));
  }
  if (kind === 'discovery') return bag.map(b => ({ ...base(b), mode: 'discovery' as E.Mode, shots, note: `Find your real ${b.club} number: aim at the flag, swing your stock swing.` }));
  if (kind === 'baseline') return bag.map(b => ({ ...base(b), shots, note: `${b.club} to ${targetFor(b)} yd, stock swing.` }));
  if (kind === 'shapes') return bag.flatMap(b => ['stock', 'draw', 'fade'].map(shape => ({ ...base(b), shape, shots, note: `${b.club} ${shape} to ${targetFor(b)} yd.` })));
  if (kind === 'ladder') return bag.filter(b => b.clubClass === 'wedge').flatMap(b => WEDGE_FRACTIONS.map(f => ({
    ...base(b), domain: f < 1 ? 'partial' : 'full', targetYd: Math.round(targetFor(b) * f), shots,
    note: f < 1 ? `${b.club} ${Math.round(f * 100)}% swing to ${Math.round(targetFor(b) * f)} yd.` : `${b.club} full to ${targetFor(b)} yd.`,
  })));
  return [];
}

function applyStep() {
  const s = cfg.plan.steps[cfg.plan.index];
  if (!s) return;
  const { shots: _n, note: _t, ...label } = s;
  cfg.label = label;
  noteLabel();
  saveConfig();
  pushClubToLM();
  emit({ kind: 'plan', index: cfg.plan.index, total: cfg.plan.steps.length, step: s });
}

function stepShotCount(): number {
  if (!store || !sessionId) return 0;
  return Number(store.all(`SELECT COUNT(*) AS c FROM shot WHERE session_id=? AND label_id=? AND complete=1 AND excluded=0`, sessionId, labelId())[0].c);
}

function maybeAdvance() {
  if (!cfg.plan.active) return;
  const s = cfg.plan.steps[cfg.plan.index];
  if (!s || stepShotCount() < s.shots) return;
  // Only a full, stock swing teaches a club its number; a ladder's part swings and shaped shots never do.
  if (s.mode === 'discovery' && s.domain !== 'partial' && s.shape === 'stock') guard('learn stock distance', () => learnStock(s));
  if (cfg.plan.index + 1 < cfg.plan.steps.length) { cfg.plan.index++; applyStep(); note('info', `plan: next is ${cfg.plan.steps[cfg.plan.index].note}`); }
  else {
    // A finished plan closes its session, so each plan is its own point in History and Results never mixes two.
    const ended = sessionId;
    cfg.plan.active = false; cfg.recording = false; saveConfig();
    guard('learn distances', () => learnFromSession(ended));
    sessionId = 0;
    emit({ kind: 'plan', done: true, ended }); note('info', 'plan complete');
  }
}

/** After a "find my numbers" step, the bag takes the measured carry, and where the club usually stops, instead of the guess. */
function learnStock(s: Step) {
  if (!store) return;
  const rows = store.all(`SELECT carry_m, total_m FROM shot WHERE session_id=? AND label_id=? AND complete=1 AND excluded=0`, sessionId, labelId(s));
  if (rows.length < 3) return;
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const measured = Math.round(mean(rows.map((r: any) => r.carry_m)) / YD);
  const totals = rows.filter((r: any) => r.total_m !== null).map((r: any) => r.total_m);
  const stops = totals.length >= 3 ? Math.round(mean(totals) / YD) : undefined;
  const b = cfg.bag.find(x => x.club === s.club);
  if (b) {
    note('info', `${s.club}: measured carry ${measured} yd (was ${b.stockYd})${stops ? `, stops at ${stops}` : ''}`);
    b.stockYd = measured;
    if (stops) b.totalYd = stops;
    b.measured = true;
    cfg.bags[cfg.player] = cfg.bag;
    saveConfig();
  }
}

/**
 * When a session ends, every club in it that has no measured distance yet, with at least 5 counted shots,
 * takes its real carry and where it stops from those shots. From then on it is scored against them.
 */
function learnFromSession(sid: number) {
  if (!store || !sid) return;
  const MIN = 5;
  const rows = store.all(`SELECT l.club AS club, s.carry_m AS carry_m, s.total_m AS total_m FROM shot s JOIN label l ON l.id=s.label_id WHERE s.session_id=? AND s.complete=1 AND s.excluded=0 AND l.domain != 'partial' AND l.shape='stock'`, sid);
  const by = new Map<string, any[]>();
  for (const r of rows) { const k = String(r.club); if (!by.has(k)) by.set(k, []); by.get(k)!.push(r); }
  let changed = false;
  for (const [club, rs] of by) {
    const b = cfg.bag.find(x => x.club === club);
    if (!b || b.measured || rs.length < MIN) continue;
    const mean = (v: number[]) => v.reduce((a, c) => a + c, 0) / v.length;
    const carry = Math.round(mean(rs.map((r: any) => r.carry_m)) / YD);
    const tot = rs.filter((r: any) => r.total_m !== null).map((r: any) => r.total_m);
    note('info', `${club}: learned from ${rs.length} shots: carries ${carry} yd (you had ${b.stockYd})${tot.length >= MIN ? `, stops at ${Math.round(mean(tot) / YD)}` : ''}`);
    b.stockYd = carry; if (tot.length >= MIN) b.totalYd = Math.round(mean(tot) / YD); b.measured = true; changed = true;
  }
  if (changed) { cfg.bags[cfg.player] = cfg.bag; saveConfig(); }
}

// ---------------------------------------------------------------- emulate GSPro replies (capture-only mode)

const lmSockets = new Set<net.Socket>();

/** GSPro club codes, so launch monitor software can switch modes when no GSPro is attached. */
function clubCode(club: string, cls: string): string {
  const c = club.trim().toUpperCase();
  if (cls === 'driver' || /^(DR|DRIVER|1W)$/.test(c)) return 'DR';
  let m = c.match(/^(\d)\s*W(OOD)?$/); if (m) return `W${m[1]}`;
  m = c.match(/^(\d)\s*H(YBRID)?$/); if (m) return `H${m[1]}`;
  m = c.match(/^(\d)\s*I?(RON)?$/); if (m && cls !== 'wedge') return `I${m[1]}`;
  if (/^(PW|GW|AW|SW|LW|PT)$/.test(c)) return c === 'AW' ? 'GW' : c;
  m = c.match(/^(\d{2})$/); if (m) { const d = Number(m[1]); return d <= 47 ? 'PW' : d <= 53 ? 'GW' : d <= 57 ? 'SW' : 'LW'; }
  return 'I7';
}

function pushClubToLM() {
  if (!NO_UP) return; // with GSPro attached, GSPro sends its own player information
  const msg = JSON.stringify({ Code: 201, Message: 'GSPro Player Information', Player: { Handed: cfg.handed === 'L' ? 'LH' : 'RH', Club: clubCode(cfg.label.club, cfg.label.clubClass) } });
  for (const s of lmSockets) { try { s.write(msg); emit({ kind: 'emulated', dir: 'GS', msg }); } catch { /* */ } }
}
function saveConfig() { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch (e: any) { note('warn', `config not saved: ${e.message}`); } }

const toM = (v: number, u: Unit) => u === 'yd' ? v * 0.9144 : u === 'ft' ? v * 0.3048 : v;
const toMps = (v: number, u: Unit) => u === 'mph' ? v * 0.44704 : u === 'kmh' ? v / 3.6 : v;
const YD = 0.9144;

let store: Sql | null = null;
let sessionId = 0;

const STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS player(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, handed TEXT NOT NULL DEFAULT 'R');
CREATE TABLE IF NOT EXISTS label(
  id INTEGER PRIMARY KEY, player_id INTEGER NOT NULL REFERENCES player(id),
  club TEXT NOT NULL, club_class TEXT NOT NULL, shape TEXT NOT NULL, domain TEXT NOT NULL,
  mode TEXT NOT NULL, target_m REAL NOT NULL, build TEXT NOT NULL DEFAULT '', measure TEXT NOT NULL DEFAULT 'carry',
  UNIQUE(player_id, club, club_class, shape, domain, mode, target_m, build, measure));
CREATE TABLE IF NOT EXISTS session(id INTEGER PRIMARY KEY, player_id INTEGER NOT NULL REFERENCES player(id),
  started_utc TEXT NOT NULL, tool TEXT NOT NULL, capture_log TEXT NOT NULL,
  sim TEXT NOT NULL DEFAULT '', sim_version TEXT NOT NULL DEFAULT '', device TEXT NOT NULL DEFAULT '', device_fw TEXT NOT NULL DEFAULT '', conditions TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS shot(
  id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES session(id), label_id INTEGER NOT NULL REFERENCES label(id),
  struck_utc TEXT NOT NULL, offline_m REAL, carry_m REAL, total_m REAL, ball_mps REAL, depth_m REAL, rest_offline_m REAL,
  complete INTEGER NOT NULL, excluded INTEGER NOT NULL DEFAULT 0, exclude_why TEXT,
  mapping_json TEXT NOT NULL, raw_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS shot_label ON shot(label_id, session_id);
CREATE TABLE IF NOT EXISTS physics_fit(
  id INTEGER PRIMARY KEY, created_utc TEXT NOT NULL, sim TEXT NOT NULL, sim_version TEXT NOT NULL,
  version TEXT NOT NULL, shape TEXT NOT NULL, n_train INTEGER NOT NULL, promotable INTEGER NOT NULL,
  fit_json TEXT NOT NULL, gate_json TEXT NOT NULL, change_json TEXT);
`;

async function openStore() {
  try {
    store = await openSql(SQE_DB_PATH, false);
    store.exec(STORE_SCHEMA);
    // Older stores: add the columns this version reads.
    for (const q of [`ALTER TABLE label ADD COLUMN measure TEXT NOT NULL DEFAULT 'carry'`, `ALTER TABLE shot ADD COLUMN rest_offline_m REAL`, `ALTER TABLE session ADD COLUMN kind TEXT NOT NULL DEFAULT ''`]) { try { store.exec(q); } catch { /* already there */ } }
    store.run(`INSERT OR IGNORE INTO meta(k,v) VALUES('schema','1')`);
    note('info', `shot store: ${SQE_DB_PATH} (${store.kind})`);
  } catch (e: any) {
    store = null;
    note('warn', `shot store unavailable (${e.message}). Capture still works; scoring needs Node 22.18+, Bun, or tap.exe.`);
  }
}

function playerId(): number {
  store!.run(`INSERT OR IGNORE INTO player(name, handed) VALUES(?, ?)`, cfg.player, cfg.handed);
  store!.run(`UPDATE player SET handed=? WHERE name=?`, cfg.handed, cfg.player);
  return Number(store!.all(`SELECT id FROM player WHERE name=?`, cfg.player)[0].id);
}

/** Which label was on screen when. A shot belongs to the label shown at the moment the ball was struck. */
const labelHistory: { t: number; label: LabelCfg }[] = [];
function noteLabel() {
  const last = labelHistory[labelHistory.length - 1];
  if (!last || JSON.stringify(last.label) !== JSON.stringify(cfg.label)) labelHistory.push({ t: Date.now(), label: { ...cfg.label } });
  while (labelHistory.length > 500) labelHistory.shift();
}
function labelAt(t: number): LabelCfg {
  for (let i = labelHistory.length - 1; i >= 0; i--) if (labelHistory[i].t <= t) return labelHistory[i].label;
  return labelHistory[0]?.label ?? cfg.label;
}

function labelId(L: LabelCfg = cfg.label): number {
  const pid = playerId();
  const tm = Math.round(L.targetYd * YD * 1e6) / 1e6;
  const ms = L.measure ?? 'carry';
  store!.run(`INSERT OR IGNORE INTO label(player_id, club, club_class, shape, domain, mode, target_m, build, measure) VALUES(?,?,?,?,?,?,?,?,?)`, pid, L.club, L.clubClass, L.shape, L.domain, L.mode, tm, L.build, ms);
  return Number(store!.all(`SELECT id FROM label WHERE player_id=? AND club=? AND club_class=? AND shape=? AND domain=? AND mode=? AND target_m=? AND build=? AND measure=?`, pid, L.club, L.clubClass, L.shape, L.domain, L.mode, tm, L.build, ms)[0].id);
}

function ensureSession(): number {
  if (!store) return 0;
  if (!sessionId) {
    const S = cfg.setup;
    const r = store.run(`INSERT INTO session(player_id, started_utc, tool, capture_log, sim, sim_version, device, device_fw, conditions) VALUES(?,?,?,?,?,?,?,?,?)`,
      playerId(), new Date(nowMs()).toISOString(), VERSION, LOG_PATH, S.sim, S.simVersion, lastDevice, S.deviceFw, S.conditions);
    sessionId = Number(r.lastInsertRowid);
    note('info', `session #${sessionId} started for ${cfg.player} (${S.sim} ${S.simVersion || 'version not entered'}, ${lastDevice || 'device not seen yet'})`);
  }
  if (lastDevice) store.run(`UPDATE session SET device=? WHERE id=? AND device=''`, lastDevice, sessionId);
  return sessionId;
}

// Shot assembly: a shot is anchored by the source that carries the carry field, then the
// other mapped fields are gathered from the nearest event of their own source within 10 s.
const WINDOW_MS = 10000;
interface Open { anchor: Sample; timer: any; parts: Partial<Record<Source, Sample>> }
const open: Open[] = [];

function readField(m: MapField | undefined, parts: Partial<Record<Source, Sample>>): number | null {
  if (!m) return null;
  const s = parts[m.src];
  if (!s) return null;
  const v = s.flat[m.path];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function assemble(s: Sample) {
  const mp = cfg.mapping;
  if (!cfg.recording || !mp.carry) return;
  if (s.src === mp.carry.src && s.flat[mp.carry.path] !== undefined) {
    stats.shotsFired++;
    const o: Open = { anchor: s, timer: null, parts: { [s.src]: s } };
    for (const src of ['LM', 'DB', 'FILE'] as Source[]) {
      if (src === s.src) continue;
      const near = pickPartner(s, src);
      if (near) { o.parts[src] = near; usedRefs.add(near.ref); }
    }
    open.push(o);
    // Done as soon as every mapped field is in; only wait for a missing part when it can still arrive.
    o.timer = setTimeout(() => guard('finalize shot', () => finalize(o)), needsMore(o) ? 6000 : 40);
    return;
  }
  for (const o of open) if (!o.parts[s.src] && !usedRefs.has(s.ref) && Math.abs(s.at - o.anchor.at) <= WINDOW_MS && !(s.src === 'LM' && s.at > o.anchor.at + 100)) { o.parts[s.src] = s; usedRefs.add(s.ref); if (!needsMore(o)) { clearTimeout(o.timer); o.timer = setTimeout(() => guard('finalize shot', () => finalize(o)), 40); } }
}

const usedRefs = new Set<string>();

/**
 * The launch-monitor message that produced this simulator result. It must have
 * arrived before the result (the strike comes first), must not belong to another
 * shot already, and wins outright if the simulator echoed the same ball speed.
 */
function pickPartner(anchor: Sample, src: Source): Sample | undefined {
  const before = src === 'LM';
  const cands = recent[src].filter(x => !usedRefs.has(x.ref) && Math.abs(x.at - anchor.at) <= WINDOW_MS && (!before || x.at <= anchor.at + 100));
  if (!cands.length) return undefined;
  if (src === 'LM') {
    const echoed = Object.values(anchor.flat).filter(x => typeof x === 'number') as number[];
    const exact = cands.filter(c => { const sp = Number(c.flat['BallData.Speed']); return Number.isFinite(sp) && echoed.some(e => Math.abs(e - sp) < 0.051 || Math.abs(e - sp * 1.609344) < 0.06); });
    if (exact.length) return exact.sort((a, b) => b.at - a.at)[0];
    return cands.sort((a, b) => b.at - a.at)[0];
  }
  return cands.sort((a, b) => Math.abs(a.at - anchor.at) - Math.abs(b.at - anchor.at))[0];
}

function needsMore(o: Open) {
  const mp = cfg.mapping;
  return [mp.offline, mp.carry, mp.total, mp.ballSpeed].some(m => m && !o.parts[m.src]);
}

function finalize(o: Open) {
  const i = open.indexOf(o);
  if (i >= 0) open.splice(i, 1);
  const mp = cfg.mapping;
  // If GSPro was switched between yards and metres, its ball speed stops matching the launch monitor's mph
  // by the old ratio. Follow the switch so no shot is read in the wrong units.
  if (mp.ballSpeed && mp.ballSpeed.src !== 'LM' && o.parts.LM) {
    const sim = readField(mp.ballSpeed, o.parts), lmMph = Number(o.parts.LM.flat['BallData.Speed']);
    if (sim !== null && lmMph > 0) {
      const r = sim / lmMph, metric = Math.abs(r - 1.609344) < 0.05, imperial = Math.abs(r - 1) < 0.03;
      const nowMetric = mp.ballSpeed.unit === 'kmh';
      if ((metric && !nowMetric) || (imperial && nowMetric)) {
        for (const k of ['carry', 'offline', 'total'] as const) if (mp[k] && mp[k]!.src === mp.ballSpeed.src) mp[k]!.unit = metric ? 'm' : 'yd';
        mp.ballSpeed.unit = metric ? 'kmh' : 'mph';
        saveConfig();
        note('warn', `GSPro is now showing ${metric ? 'metres and km/h' : 'yards and mph'}; reading its numbers that way from this shot on`);
      }
    }
  }
  const offRaw = readField(mp.offline, o.parts), carryRaw = readField(mp.carry, o.parts);
  const totalRaw = readField(mp.total, o.parts), bsRaw = readField(mp.ballSpeed, o.parts);
  const offline = offRaw === null ? null : toM(offRaw, mp.offline!.unit) * (mp.offline!.flip ? -1 : 1);
  const carry = carryRaw === null ? null : toM(carryRaw, mp.carry!.unit);
  const total = totalRaw === null ? null : toM(totalRaw, mp.total!.unit);
  const bs = bsRaw === null ? null : toMps(bsRaw, mp.ballSpeed!.unit);
  const complete = offline !== null && carry !== null;
  const raw = Object.fromEntries(Object.entries(o.parts).map(([k, v]) => [k, { ref: v!.ref, at: new Date(v!.at).toISOString(), data: v!.raw }]));
  // The strike time is the launch monitor's message if we have it; the shot belongs to the label on screen then.
  const struck = Math.min(...Object.values(o.parts).map(p => p!.at));
  const L = labelAt(struck);
  let id = 0;
  if (store) {
    const lid = labelId(L), sid = ensureSession();
    const tm = L.targetYd * YD;
    const rawText = JSON.stringify(raw);
    const restOff = restOffline(rawText, carry, offline, total);
    const r = store.run(`INSERT INTO shot(session_id,label_id,struck_utc,offline_m,carry_m,total_m,ball_mps,depth_m,complete,mapping_json,raw_json,rest_offline_m) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      sid, lid, new Date(struck + clockShiftMs).toISOString(), offline, carry, total, bs, carry === null ? null : carry - tm, complete ? 1 : 0, JSON.stringify(mp), rawText, restOff);
    id = Number(r.lastInsertRowid);
  }
  while (usedRefs.size > 2000) usedRefs.delete(usedRefs.values().next().value as string);
  if (complete) stats.shotsSaved++; else stats.shotsIncomplete++;
  emit({ kind: 'shot', id, complete, label: { ...L }, offlineYd: offline === null ? null : offline / YD, carryYd: carry === null ? null : carry / YD, totalYd: total === null ? null : total / YD, ballMph: bs === null ? null : bs / 0.44704, sources: Object.keys(o.parts), refs: Object.values(o.parts).map(p => p!.ref) });
  if (!complete) note('warn', `shot ${id || ''} incomplete: ${offline === null ? 'offline ' : ''}${carry === null ? 'carry ' : ''}missing. Check the field mapping.`);
  if (complete) guard('plan', maybeAdvance);
  if (complete) guard('learn', () => maybeLearn());
}

/** Launch numbers as the monitor sent them, pulled from the stored raw record. */
/**
 * Launch numbers from GSPro's own shot record (DrivingRangeShot / LastShot ShotData), for when the launch
 * monitor talks to GSPro directly and not through Pattern. Real GSPro 2026 names: BallSpeed, VLA, HLA,
 * BackSpin, SideSpin, rawSpinAxis (negative = curving left), Decent (sic, descent angle), PeakHeight.
 */
function launchFromSim(raw: any): Record<string, number> | null {
  for (const src of ['DB', 'FILE']) {
    let row = raw?.[src]?.data?.row ?? raw?.[src]?.data?.json ?? null;
    if (!row) continue;
    let sd: any = row.ShotData ?? row;
    if (typeof sd === 'string') { try { sd = JSON.parse(sd); } catch { continue; } }
    const keys = Object.keys(sd ?? {});
    const num = (...names: string[]) => { for (const n of names) { const k = keys.find(x => x.toLowerCase() === n.toLowerCase()); const v = k === undefined ? NaN : Number(sd[k]); if (Number.isFinite(v)) return v; } return undefined; };
    const speed = num('BallSpeed', 'Speed');
    if (!speed) continue;
    const back = num('BackSpin'), side = num('SideSpin');
    const o: Record<string, number> = { ballSpeed: cfg.mapping.ballSpeed?.unit === 'kmh' ? speed / 1.609344 : speed };
    const put = (k: string, v: number | undefined) => { if (v !== undefined && Number.isFinite(v)) o[k] = v; };
    put('launch', num('VLA', 'LaunchAngle'));
    put('startLine', num('HLA', 'LaunchDirection'));
    put('spin', num('TotalSpin') ?? (back !== undefined && side !== undefined ? Math.hypot(back, side) : back));
    put('spinAxis', num('SpinAxis', 'rawSpinAxis') ?? (back !== undefined && side !== undefined ? (Math.atan2(side, back) * 180) / Math.PI : undefined));
    const cs = num('ClubSpeed'); if (cs) put('clubSpeed', cs);
    return o;
  }
  return null;
}

function launchOf(rawJson: string): Record<string, number> | null {
  try {
    const raw = JSON.parse(rawJson);
    const b = raw?.LM?.data?.BallData;
    if (!b || !(Number(b.Speed) > 0)) return launchFromSim(raw);
    const o: Record<string, number> = {};
    const put = (k: string, v: any) => { const n = Number(v); if (v !== undefined && v !== null && Number.isFinite(n)) o[k] = n; };
    put('ballSpeed', b.Speed); put('launch', b.VLA); put('startLine', b.HLA); put('spin', b.TotalSpin ?? (b.BackSpin !== undefined && b.SideSpin !== undefined ? Math.hypot(b.BackSpin, b.SideSpin) : undefined));
    put('spinAxis', b.SpinAxis ?? (b.BackSpin !== undefined && b.SideSpin !== undefined ? (Math.atan2(b.SideSpin, b.BackSpin) * 180) / Math.PI : undefined));
    const c = raw?.LM?.data?.ClubData;
    if (c) { put('clubSpeed', c.Speed); put('face', c.FaceToTarget); put('path', c.Path); put('attack', c.AngleOfAttack); }
    return o;
  } catch { return null; }
}

/**
 * The ball flight to draw for a shot. The shape comes from the physics model (the learned fit once it has
 * one, the literature seed before that); it is then stretched so it lands exactly where GSPro said it did,
 * because GSPro is the authority on where the ball went. Yards, with x downrange, y right, z up.
 */
const flightCache = new Map<string, any>();
function flightOf(rawJson: string, carryM: number | null, offlineM: number | null, totalM: number | null) {
  const key = `${rawJson.length}|${carryM}|${offlineM}|${totalM}|${rawJson.slice(-120)}`;
  if (flightCache.has(key)) return flightCache.get(key);
  const out = flightUncached(rawJson, carryM, offlineM, totalM);
  if (flightCache.size > 4000) flightCache.clear();
  flightCache.set(key, out);
  return out;
}
function flightUncached(rawJson: string, carryM: number | null, offlineM: number | null, totalM: number | null) {
  const L = launchOf(rawJson);
  if (!L || L.ballSpeed === undefined || L.launch === undefined || carryM === null || offlineM === null) return null;
  const lf = (() => { try { return latestFit(); } catch { return null; } })();
  const fit = lf && lf.gate && lf.gate.promotable ? lf.fit : null;
  const sh = P.SHAPES.find(x => x.id === (fit ? fit.shape : 'sat5'))!;
  const xv = fit ? fit.x : sh.x0;
  const tr: number[][] = [];
  const land = P.flyWith({ ballSpeed: L.ballSpeed * 0.44704, vla: L.launch, hla: L.startLine ?? 0, spin: L.spin ?? 0, spinAxis: L.spinAxis ?? 0 }, sh.coef(xv), sh.tau(xv), 0.005, P.MODEL_AIR, tr);
  if (!(land.carry > 1) || tr.length < 3) return null;
  // Scale the whole flight about the tee so it carries exactly GSPro's distance. A uniform scale keeps every
  // angle: the ball still leaves on the launch monitor's start line and launch angle.
  const k = carryM / land.carry;
  // Whatever sideways difference is left goes into the curve, not the start line: the correction grows with the
  // square of the distance travelled, so it is zero at the tee and has zero slope there.
  const c = offlineM - k * land.offline;
  const path = tr.map(([x, y, z, t]) => { const u = x / land.carry; return [+(x * k / YD).toFixed(3), +((y * k + c * u * u) / YD).toFixed(3), +(z * k / YD).toFixed(3), +t.toFixed(3)]; });
  // Roll-out as GSPro reports it; negative when the ball spins back.
  const rollYd = totalM !== null && Math.abs(totalM - carryM) > 0.2 ? (totalM - carryM) / YD : null;
  // The shape of the hops and roll after landing, from the bounce model; the drawing scales it to GSPro's roll-out.
  let bounce: any = null;
  try { const st = Roll.settle({ speed: (land.vLand ?? 0) * Math.sqrt(k), angleDeg: land.landAngle, spinRpm: land.spinLand ?? 0 }, Roll.GREEN_DECEL); bounce = { run: st.run / YD, path: st.path.map(([d, h, tt]) => [+(d / YD).toFixed(3), +(h / YD).toFixed(3), +tt.toFixed(3)]) }; } catch { bounce = null; }
  return { path, apexYd: land.apex * k / YD, landAngle: land.landAngle, hang: land.time, rollYd, bounce, model: fit ? 'learned' : 'seed', launch: L };
}

function drivers(rows: any[]) {
  const L = rows.map(r => launchOf(r.raw_json));
  if (L.some(x => !x)) return null;
  const col = (k: string) => (L.every(x => x![k] !== undefined) ? L.map(x => x![k]) : null);
  const pick = (ks: string[]) => Object.fromEntries(ks.map(k => [k, col(k)]).filter(([, v]) => v && new Set(v as number[]).size > 1)) as Record<string, number[]>;
  const off = E.explain('offline', rows.map(r => r.offline_m / YD), pick(['startLine', 'spinAxis']));
  const car = E.explain('carry', rows.map(r => r.carry_m / YD), pick(['ballSpeed', 'launch', 'spin']));
  return { offline: off, carry: car };
}

// ---------------------------------------------------------------- physics learner (shadow mode)

interface LearnState { running: boolean; lastN: number; latest: any | null; error: string; lastChange: any | null }
const learnState: LearnState = { running: false, lastN: 0, latest: null, error: '', lastChange: null };
const LEARN_FIRST = 30, LEARN_EVERY = 25;

/** Launch as the monitor sent it, converted to SI. OpenConnect "Units: Yards" sends ball speed in mph. */
function siLaunch(rawJson: string): P.Launch | null {
  const L = launchOf(rawJson);
  if (!L || [L.ballSpeed, L.launch, L.startLine, L.spin, L.spinAxis].some(v => v === undefined)) return null;
  let units = 'Yards';
  try { units = JSON.parse(rawJson)?.LM?.data?.Units ?? 'Yards'; } catch { /* */ }
  const v = /met/i.test(units) ? L.ballSpeed : L.ballSpeed * 0.44704;
  return { ballSpeed: v, vla: L.launch, hla: L.startLine, spin: L.spin, spinAxis: L.spinAxis };
}

/** Every complete shot recorded under the current sim and version, as (launch, landing) training pairs. */
function trainingPairs(): P.Pair[] {
  if (!store) return [];
  const rows = store.all(`SELECT s.offline_m, s.carry_m, s.raw_json, s.label_id, s.session_id, l.target_m, l.mode
    FROM shot s JOIN label l ON l.id=s.label_id JOIN session se ON se.id=s.session_id
    WHERE s.complete=1 AND s.excluded=0 AND se.sim=? AND se.sim_version=? ORDER BY s.id`, cfg.setup.sim, cfg.setup.simVersion);
  const out: P.Pair[] = [];
  for (const r of rows) {
    const L = siLaunch(r.raw_json);
    if (!L) continue;
    out.push({ L, carry: r.carry_m, offline: r.offline_m, group: r.mode === 'target' ? `${r.session_id}:${r.label_id}` : undefined, D: r.target_m });
  }
  return out;
}

function latestFit(): any | null {
  if (!store) return null;
  const r = store.all(`SELECT * FROM physics_fit WHERE sim=? AND sim_version=? ORDER BY id DESC LIMIT 1`, cfg.setup.sim, cfg.setup.simVersion)[0];
  if (!r) return null;
  return { id: r.id, created: r.created_utc, fit: JSON.parse(r.fit_json), gate: JSON.parse(r.gate_json), change: r.change_json ? JSON.parse(r.change_json) : null };
}

function runFitWorker(job: any): Promise<any> {
  return new Promise((res, rej) => {
    const self = process.argv[1] ?? '';
    const args = !COMPILED && /\.(ts|js|mjs)$/i.test(self) ? [...process.execArgv, self, '--fit-worker'] : ['--fit-worker'];
    const ch = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    try { os.setPriority(ch.pid!, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    let out = '', err = '';
    ch.stdout.on('data', d => { out += d; });
    ch.stderr.on('data', d => { err += d; });
    ch.on('error', rej);
    ch.on('close', code => { if (code === 0) { try { res(JSON.parse(out)); } catch (e) { rej(e); } } else rej(new Error(err.trim().split('\n').pop() || `fit worker exited ${code}`)); });
    ch.stdin.end(JSON.stringify(job));
  });
}

/** Called after each saved shot. Starts a background fit when enough new pairs have arrived. */
function maybeLearn(force = false) {
  if (!store || learnState.running) return;
  const pairs = trainingPairs();
  if (!force && (pairs.length < LEARN_FIRST || pairs.length - learnState.lastN < LEARN_EVERY)) return;
  if (pairs.length < 20) return;
  const prev = latestFit();
  const recent = prev ? pairs.slice(prev.fit.nTrain) : [];
  learnState.running = true;
  learnState.lastN = pairs.length;
  emit({ kind: 'learn', event: 'start', n: pairs.length });
  runFitWorker({ pairs, sim: `${cfg.setup.sim} ${cfg.setup.simVersion}`.trim(), previous: prev?.fit ?? null, recent })
    .then(({ fit, gate, change }) => {
      store!.run(`INSERT INTO physics_fit(created_utc, sim, sim_version, version, shape, n_train, promotable, fit_json, gate_json, change_json) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        new Date().toISOString(), cfg.setup.sim, cfg.setup.simVersion, fit.version, fit.shape, fit.nTrain, gate.promotable ? 1 : 0, JSON.stringify(fit), JSON.stringify(gate), change ? JSON.stringify(change) : null);
      learnState.latest = fit; learnState.error = ''; learnState.lastChange = change;
      emit({ kind: 'learn', event: 'done', version: fit.version, shape: fit.shape, n: fit.nTrain, cvCarryYd: fit.cvCarryRms / YD, cvOfflineYd: fit.cvOfflineRms / YD, gate });
      note('info', `physics learned from ${fit.nTrain} shots: shape ${fit.shape}, held-out error carry ${(fit.cvCarryRms / YD).toFixed(2)} yd, offline ${(fit.cvOfflineRms / YD).toFixed(2)} yd, ${gate.promotable ? 'passes' : 'not yet passing'} the promotion gate`);
      if (change?.changed) note('warn', `The simulator's physics appears to have CHANGED: recent shots land ${(change.meanCarryErr / YD).toFixed(1)} yd off the learned model (z=${change.z.toFixed(1)}). Check whether ${cfg.setup.sim} updated, and enter the new version.`);
    })
    .catch(e => { learnState.error = String(e.message ?? e); note('warn', `physics learner: ${learnState.error}`); })
    .finally(() => { learnState.running = false; });
}

/** The same set scored through the learned model instead of the simulator's landing points. */
function shadowScore(usable: any[], targetM: number, mode: E.Mode) {
  const lf = latestFit();
  if (!lf || usable.length < 3) return null;
  const pts: E.Shot[] = [];
  for (const r of usable) { const L = siLaunch(r.raw_json); if (!L) return null; const l = P.flyFit(L, lf.fit); pts.push({ x: l.offline, y: l.carry - targetM }); }
  const m = E.computeSet(pts, targetM, mode);
  return { rating: m.rating, rd: m.rd, version: lf.fit.version, promotable: lf.gate.promotable };
}

/**
 * Sideways position where the ball stopped. GSPro reports the total distance; the roll goes on along the
 * direction the ball was travelling when it landed (from the drawn flight), so the sideways part of the
 * roll comes from that heading.
 */
function restOffline(rawJson: string, carryM: number | null, offlineM: number | null, totalM: number | null): number | null {
  if (offlineM === null || carryM === null) return null;
  if (totalM === null || Math.abs(totalM - carryM) < 0.2) return offlineM;
  try {
    const f = flightOf(rawJson, carryM, offlineM, totalM);
    const p = f?.path; if (!p || p.length < 4) return offlineM;
    const a = p[p.length - 1], b = p[p.length - 4], hx = a[0] - b[0], hy = a[1] - b[1], hn = Math.hypot(hx, hy) || 1;
    return offlineM + (totalM - carryM) * (hy / hn);
  } catch { return offlineM; }
}

/** The point each shot is scored on: where it stopped, or where it landed. */
function pointOf(r: any, measure: string): { x: number; y: number } {
  if (measure === 'finish') return { x: (r.rest_offline_m ?? r.offline_m) as number, y: (r.total_m ?? r.carry_m) as number };
  return { x: r.offline_m as number, y: r.carry_m as number };
}

/**
 * The golf outcome of each finish. Wedges and irons: how many finished inside 10 and 20 feet of the flag.
 * Driver and woods: how many finished in the fairway (cfg.fairwayYd wide, centred on the target line).
 */
function outcomesOf(rows: any[], L: any) {
  const pts = rows.filter(r => r.carry_m !== null && r.offline_m !== null).map(r => pointOf(r, L.measure));
  if (!pts.length) return null;
  if (['driver', 'wood'].includes(L.club_class)) {
    const half = (cfg.fairwayYd * YD) / 2;
    return { kind: 'fairway', n: pts.length, fairway: pts.filter(p => Math.abs(p.x) <= half).length, widthYd: cfg.fairwayYd };
  }
  const d = pts.map(p => Math.hypot(p.x, p.y - L.target_m));
  return { kind: 'green', n: pts.length, in10ft: d.filter(v => v <= 10 * 0.3048).length, in20ft: d.filter(v => v <= 20 * 0.3048).length };
}

/**
 * Has GSPro's roll-out changed for this club? Finish scores are only comparable while the ground behaves
 * the same. Compares how far the ball ran after landing this session with earlier sessions of the same
 * label on the same simulator and version; flags a change that is both clear (|t| > 3.29, the same
 * two-sided 0.1% bar the physics change detector uses) and large (more than a yard and a quarter of before).
 */
function rollCheck(L: any, sid: number) {
  if (!store || !sid) return null;
  const se = store.all(`SELECT sim, sim_version FROM session WHERE id=?`, sid)[0];
  if (!se) return null;
  const runs = (rows: any[]) => rows.filter((r: any) => r.total_m !== null && r.carry_m !== null).map((r: any) => r.total_m - r.carry_m);
  const now = runs(store.all(`SELECT carry_m, total_m FROM shot WHERE session_id=? AND label_id=? AND complete=1 AND excluded=0`, sid, L.id));
  const before = runs(store.all(`SELECT s.carry_m, s.total_m FROM shot s JOIN session se ON se.id=s.session_id WHERE s.label_id=? AND s.session_id<>? AND s.complete=1 AND s.excluded=0 AND se.sim=? AND se.sim_version=?`, L.id, sid, se.sim, se.sim_version));
  if (now.length < 5 || before.length < 10) return { known: false, nowYd: now.length ? now.reduce((a, b) => a + b, 0) / now.length / YD : null };
  const ms = (v: number[]) => { const m = v.reduce((a, b) => a + b, 0) / v.length; return { m, v: v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1) }; };
  const a = ms(now), b = ms(before), tStat = (a.m - b.m) / Math.sqrt(a.v / now.length + b.v / before.length || 1e-12);
  const big = Math.abs(a.m - b.m) > Math.max(YD, 0.25 * Math.abs(b.m));
  return { known: true, changed: Math.abs(tStat) > 3.29 && big, nowYd: a.m / YD, beforeYd: b.m / YD, t: tStat };
}

function scoreSet(rows: any[], targetM: number, mode: E.Mode, measure = 'carry') {
  const shots = rows.map(r => { const p = pointOf(r, measure); return { x: p.x, y: p.y - targetM }; });
  if (shots.length < 3) return null;
  const m = E.computeSet(shots, targetM, mode);
  const c = E.contours(shots, m);
  return { metrics: m, contours: c };
}

function sessionView() {
  if (!store) return { store: false };
  const sid = sessionId;
  const lid = labelId();
  const label = store.all(`SELECT * FROM label WHERE id=?`, lid)[0];
  const shots = sid ? store.all(`SELECT id, struck_utc, offline_m, carry_m, total_m, ball_mps, depth_m, rest_offline_m, complete, excluded, exclude_why, raw_json FROM shot WHERE session_id=? AND label_id=? ORDER BY id`, sid, lid) : [];
  const usable = shots.filter((s: any) => s.complete && !s.excluded);
  let scored: any = null;
  try { scored = scoreSet(usable, label.target_m, label.mode, label.measure); } catch (e: any) { scored = { error: e.message }; }
  let why: any = null;
  try { why = usable.length >= 6 ? drivers(usable) : null; } catch { why = null; }
  const sess = sid ? store.all(`SELECT sim, sim_version, device, device_fw, conditions FROM session WHERE id=?`, sid)[0] : null;
  let shadow: any = null;
  try { shadow = shadowScore(usable, label.target_m, label.mode); } catch { shadow = null; }
  let launchLayer: any = null;
  try {
    const L = usable.map((r: any) => launchOf(r.raw_json));
    if (usable.length >= 3 && L.every((x: any) => x && ['ballSpeed', 'launch', 'startLine', 'spin', 'spinAxis'].every(k => x[k] !== undefined)))
      launchLayer = E.computeLaunch(L.map((x: any) => ({ ballSpeed: x.ballSpeed, vla: x.launch, hla: x.startLine, spin: x.spin, spinAxis: x.spinAxis })));
  } catch { launchLayer = null; }
  const step = cfg.plan.steps[cfg.plan.index];
  const plan = { active: cfg.plan.active, index: cfg.plan.index, total: cfg.plan.steps.length, step, done: step ? Math.min(step.shots, usable.length) : 0, next: cfg.plan.steps[cfg.plan.index + 1] ?? null };
  // Bag view: every label with 3+ usable shots this session.
  const bag: any[] = [];
  if (sid) {
    for (const L of store.all(`SELECT DISTINCT l.* FROM label l JOIN shot s ON s.label_id=l.id WHERE s.session_id=?`, sid)) {
      const rs = store.all(`SELECT offline_m, carry_m, total_m, rest_offline_m FROM shot WHERE session_id=? AND label_id=? AND complete=1 AND excluded=0 ORDER BY id`, sid, L.id);
      if (rs.length < 3) { bag.push({ id: L.id, club: L.club, shape: L.shape, mode: L.mode, targetYd: L.target_m / YD, n: rs.length }); continue; }
      const sc = scoreSet(rs, L.target_m, L.mode, L.measure)!;
      bag.push({ id: L.id, club: L.club, shape: L.shape, mode: L.mode, domain: L.domain, targetYd: L.target_m / YD, n: rs.length, rating: sc.metrics.rating, rd: sc.metrics.rd, piQ: sc.metrics.piQ, piB: sc.metrics.piB, piS: sc.metrics.piS });
    }
    const scoredBag = bag.filter(b => b.rating !== undefined && b.mode === 'target');
    const pr = E.practicePriority(scoredBag.map(b => ({ id: String(b.id), player: cfg.player, D: b.targetYd * YD, rating: b.rating, rd: b.rd, domain: b.domain })), new Map());
    for (const p of pr) { const b = bag.find(x => String(x.id) === p.id); if (b) b.tiedForLast = p.tiedForLast; }
    bag.sort((a, b) => (a.rating ?? 1e9) - (b.rating ?? 1e9));
  }
  let trend: any = null;
  try { trend = history().labels.find((x: any) => x.id === lid) ?? null; } catch { trend = null; }
  return { store: true, recording: cfg.recording, session: sid, setup: sess, plan, why, launch: launchLayer, shadow, trend, label: { ...label, targetYd: label.target_m / YD }, shots: shots.map(({ raw_json: _r, ...s }: any) => ({ ...s, flight: (() => { try { return flightOf(_r, s.carry_m, s.offline_m, s.total_m); } catch { return null; } })(), offlineYd: s.offline_m === null ? null : s.offline_m / YD, carryYd: s.carry_m === null ? null : s.carry_m / YD, totalYd: s.total_m === null ? null : s.total_m / YD, restOffYd: (s.rest_offline_m ?? s.offline_m) === null ? null : (s.rest_offline_m ?? s.offline_m) / YD, ...(() => { if (s.carry_m === null || s.offline_m === null) return { scoreX: null, scoreY: null, depthYd: null }; const p = pointOf(s, label.measure); return { scoreX: p.x / YD, scoreY: p.y / YD, depthYd: (p.y - label.target_m) / YD }; })() })), scored, bag, scoreOn: cfg.scoreOn, outcomes: (() => { try { return outcomesOf(usable, label); } catch { return null; } })(), roll: (() => { try { return rollCheck(label, sid); } catch { return null; } })() };
}

// ---------------------------------------------------------------- probe

async function probe(): Promise<string> {
  if (DB_ONLY) return 'db-only mode has no listener to probe';
  return new Promise((res) => {
    let tries = 0;
    const attempt = () => {
      const localPort = 40000 + Math.floor(Math.random() * 20000);
      probePorts.add(localPort);
      const s = net.connect({ host: '127.0.0.1', port: LISTEN_PORT, localPort }, () => {
        s.write(JSON.stringify({
          DeviceID: 'WireTap Probe', Units: 'Yards', ShotNumber: 900000 + (seq % 99999), APIversion: '1',
          BallData: { Speed: 150.3, SpinAxis: -8.4, TotalSpin: 2750, BackSpin: 2700, SideSpin: -400, HLA: 1.2, VLA: 13.6, CarryDistance: 248.1 },
          ClubData: { Speed: 102.1, AngleOfAttack: -1.4, FaceToTarget: 0.8, Path: 1.9 },
          ShotDataOptions: { ContainsBallData: true, ContainsClubData: true, IsHeartBeat: false },
        }));
        setTimeout(() => { s.end(); setTimeout(() => probePorts.delete(localPort), 2000); }, 400);
        res(`probe sent through :${LISTEN_PORT} (never forwarded to GSPro)`);
      });
      s.on('error', (e: any) => { probePorts.delete(localPort); if (e.code === 'EADDRINUSE' && ++tries < 5) attempt(); else res(`probe failed: ${e.message}`); });
    };
    attempt();
  });
}

// ---------------------------------------------------------------- HTTP UI

function body(req: http.IncomingMessage): Promise<any> {
  return new Promise((res) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); }); req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch { res({}); } }); });
}
const json = (res: http.ServerResponse, o: any, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o, (_k, v) => typeof v === 'bigint' ? Number(v) : v)); };

function lanUrls(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${UI_PORT}`);
  return out;
}

const ui = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      for (const ev of ring.slice(-600)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      sse.add(res); everWindow = true;
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* */ } }, 15000);
      req.on('close', () => { clearInterval(ka); sse.delete(res); if (!sse.size) lastWindowGone = Date.now(); });
      return;
    }
    if (p === '/api/schema') return json(res, schemaDump());
    if (await demoApi(p, req, res)) return;
    const r = await appApi(p, req, res);
    if (r) return;
    if (p === '/api/stats') return json(res, { ...stats, recording: cfg.recording, session: sessionId, openShots: open.length });
    if (p === '/api/system') return json(res, {
      ports: lastPorts.filter(x => [921, 922, UP_PORT, LISTEN_PORT, UI_PORT].includes(x.port) || /gs|golf|connect|launch|garmin|skytrak|uneekor|foresight|rapsodo|mevo|square|bushnell/i.test(x.name ?? '')),
      allPortsCount: lastPorts.length,
      dbs: dbWatches.map(w => ({ file: w.file, viaCopy: w.viaCopy, error: w.lastErr, tables: [...w.tables.values()].map(t => ({ name: t.name, cols: t.cols, maxRowid: t.maxRowid })) })),
      logs: [...tails.values()].map(t => ({ file: t.file, pos: t.pos })),
      roots: gsproRoots(), lan: lanUrls(), uiHost: UI_HOST, platform: process.platform, runtime: typeof (globalThis as any).Bun !== 'undefined' ? `bun ${(globalThis as any).Bun.version}` : `node ${process.version}`,
    });
    if (p === '/api/ports' && req.method === 'POST') { const r = await listeningPorts(); if (r) lastPorts = r; return json(res, { ok: !!r, count: lastPorts.length }); }
    if (p === '/api/rescan' && req.method === 'POST') { await rescanFiles(); return json(res, { dbs: dbWatches.length, logs: tails.size }); }
    if (p === '/api/probe' && req.method === 'POST') return json(res, { msg: await probe() });
    if (p === '/api/mark' && req.method === 'POST') { const b = await body(req); emit({ kind: 'mark', text: String(b.text ?? '').slice(0, 500) }); return json(res, { ok: true }); }
    if (p === '/api/config' && req.method === 'GET') return json(res, cfg);
    if (p === '/api/config' && req.method === 'POST') {
      const b = await body(req);
      if (b.player !== undefined && b.player !== cfg.player) sessionId = 0;
      const setupChanged = b.setup && JSON.stringify({ ...cfg.setup, ...b.setup }) !== JSON.stringify(cfg.setup);
      cfg = { ...cfg, ...b, label: { ...cfg.label, ...(b.label ?? {}) }, mapping: b.mapping ?? cfg.mapping, setup: { ...cfg.setup, ...(b.setup ?? {}) }, plan: cfg.plan, bag: b.bag ?? cfg.bag };
      cfg.label.targetYd = Math.max(1, Number(cfg.label.targetYd) || 150);
      if (setupChanged) sessionId = 0; // a different sim or setting is a different session
      noteLabel();
      saveConfig();
      if (b.label) pushClubToLM();
      emit({ kind: 'config', cfg });
      return json(res, cfg);
    }
    if (p === '/api/session/new' && req.method === 'POST') { sessionId = 0; if (store) ensureSession(); return json(res, { session: sessionId }); }
    if (p === '/api/plan/generate' && req.method === 'POST') {
      const b = await body(req);
      if (Array.isArray(b.bag)) cfg.bag = b.bag.map((x: any) => ({ club: String(x.club).trim(), clubClass: String(x.clubClass || 'mid_iron'), stockYd: Number(x.stockYd) })).filter((x: any) => x.club && x.stockYd > 0);
      const steps = makePlan(String(b.kind || 'baseline'), Math.max(3, Math.min(100, Number(b.shots) || 10)));
      cfg.plan = { steps, index: 0, active: steps.length > 0 };
      saveConfig();
      if (steps.length) applyStep();
      return json(res, cfg.plan);
    }
    if (p === '/api/plan/step' && req.method === 'POST') {
      const b = await body(req);
      if (b.stop) { cfg.plan.active = false; saveConfig(); return json(res, cfg.plan); }
      const i = Math.max(0, Math.min(cfg.plan.steps.length - 1, cfg.plan.index + Number(b.delta || 0)));
      cfg.plan.index = i; cfg.plan.active = cfg.plan.steps.length > 0;
      applyStep();
      return json(res, cfg.plan);
    }
    if (p === '/api/session') return json(res, sessionView());
    if (p === '/api/physics') { const lf = latestFit(); return json(res, { running: learnState.running, error: learnState.error, pairs: store ? trainingPairs().length : 0, first: LEARN_FIRST, every: LEARN_EVERY, latest: lf, setup: cfg.setup }); }
    if (p === '/api/physics/learn' && req.method === 'POST') { maybeLearn(true); return json(res, { started: learnState.running }); }
    const ex = p.match(/^\/api\/shot\/(\d+)\/exclude$/);
    if (ex && req.method === 'POST' && store) {
      const b = await body(req);
      store.run(`UPDATE shot SET excluded=?, exclude_why=? WHERE id=?`, b.excluded ? 1 : 0, b.excluded ? String(b.why || 'marked in UI') : null, Number(ex[1]));
      emit({ kind: 'exclude', id: Number(ex[1]), excluded: !!b.excluded, why: b.why });
      return json(res, { ok: true });
    }
    if (p === '/download/capture') { res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="${path.basename(LOG_PATH)}"` }); fs.createReadStream(LOG_PATH).pipe(res); return; }
    if (p === '/download/schema') { fs.writeFileSync(SCHEMA_PATH, JSON.stringify(schemaDump(), null, 2)); res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${path.basename(SCHEMA_PATH)}"` }); fs.createReadStream(SCHEMA_PATH).pipe(res); return; }
    if (p === '/download/db' && fs.existsSync(SQE_DB_PATH)) { res.writeHead(200, { 'Content-Type': 'application/vnd.sqlite3', 'Content-Disposition': 'attachment; filename="sqe.db"' }); fs.createReadStream(SQE_DB_PATH).pipe(res); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(p === '/debug' ? HTML : APP_HTML);
  } catch (e: any) { try { json(res, { error: e.message }, 500); } catch { /* */ } }
});

// ---------------------------------------------------------------- page

const HTML = /* html */ `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SQE Wire Tap</title>
<style>
:root{--bg:#0b0f14;--pan:#121922;--pan2:#18212c;--ln:#24303d;--tx:#e6edf3;--dim:#8b98a8;--f:#5d6977;
--lm:#39d0d8;--gs:#f0b429;--db:#a371f7;--fi:#7ee787;--er:#f0556a;--ok:#3fb950;--m:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}
html,body{height:100%;overflow:hidden}
body{margin:0;background:var(--bg);color:var(--tx);font:13px/1.45 var(--m);display:flex;flex-direction:column}
header{flex:none;z-index:5}
code{word-break:break-all}
header{padding:8px 12px;border-bottom:1px solid var(--ln);display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--pan)}
h1{font-size:12px;margin:0 6px 0 0;letter-spacing:.08em;text-transform:uppercase;color:var(--dim)}
.pill{font-size:11px;padding:3px 8px;border-radius:5px;background:var(--pan2);border:1px solid var(--ln);color:var(--dim);white-space:nowrap}
.pill b{color:var(--tx)}.dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:5px;vertical-align:1px}
.up{background:var(--ok)}.down{background:var(--er)}.unk{background:var(--f)}
button,select,input{background:var(--pan2);color:var(--tx);border:1px solid var(--ln);border-radius:5px;padding:5px 8px;font:inherit;font-size:12px}
button{cursor:pointer;color:var(--dim)}button:hover{color:var(--tx);border-color:var(--f)}
button.on,button.pri{background:var(--lm);color:#05181b;border-color:var(--lm);font-weight:600}
button.rec{background:var(--er);color:#fff;border-color:var(--er)}
nav{display:flex;gap:4px;padding:6px 12px;border-bottom:1px solid var(--ln);background:var(--pan)}
nav button{border-radius:5px 5px 0 0}
nav{flex:none}main{flex:1;min-height:0;display:flex;flex-direction:column}
.tab{display:none}#t-wire.on{display:flex;flex:1;min-height:0}#t-sess.on,#t-sys.on{display:block;flex:1;min-height:0;overflow-y:auto}
#feed{flex:1;overflow-y:auto;padding:2px 0}
.side{width:46%;max-width:640px;border-left:1px solid var(--ln);overflow-y:auto;background:var(--pan)}
.row{padding:2px 10px;border-bottom:1px solid #141b24;display:flex;gap:8px}
.sq{color:var(--f);width:46px;text-align:right;flex-shrink:0;font-size:11px}.tm{color:var(--f);width:58px;flex-shrink:0;font-size:11px}
.dr{width:40px;flex-shrink:0;font-weight:700;font-size:11px}.LM{color:var(--lm)}.GS{color:var(--gs)}.DB{color:var(--db)}.FILE{color:var(--fi)}.SHOT{color:var(--ok)}
.bd{flex:1;min-width:0;word-break:break-all;white-space:pre-wrap}
.k-raw .bd{color:var(--f)}.k-note .bd{color:var(--dim);font-style:italic}.lvl-warn .bd{color:var(--gs)}.lvl-error .bd,.k-badjson .bd{color:var(--er)}
.k-partial .bd{color:#6b5a2a}.k-shot .bd{color:var(--ok);font-weight:600}.k-mark .bd{color:#fff;background:#2a1f3d}
h2{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--f);margin:0;padding:8px 12px;border-bottom:1px solid var(--ln);background:var(--pan);position:sticky;top:0;z-index:1}
table{width:100%;border-collapse:collapse;font-size:11.5px}
th{text-align:left;color:var(--f);font-weight:500;padding:4px 8px;border-bottom:1px solid var(--ln);font-size:10px;background:var(--pan2)}
td{padding:3px 8px;border-bottom:1px solid #18212b;color:var(--dim);vertical-align:top}td.p{color:var(--tx);word-break:break-all}td.n{text-align:right;white-space:nowrap}
.grid{padding:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px;align-content:start}
.wide{grid-column:span 2}@media(max-width:760px){.wide{grid-column:auto}}
.card{background:var(--pan);border:1px solid var(--ln);border-radius:9px;overflow:hidden}
.card .in{padding:10px 12px}
label.f{display:flex;flex-direction:column;gap:3px;font-size:10.5px;color:var(--f);text-transform:uppercase;letter-spacing:.06em}
.fr{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}.fr>*{flex:1;min-width:90px}
.big{font-size:26px;font-weight:700;color:var(--lm)}.mut{color:var(--f)}
.kv{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.kv div{background:var(--pan2);border:1px solid var(--ln);border-radius:7px;padding:6px 8px}
.kv b{display:block;font-size:15px;color:var(--tx)}.kv span{font-size:10px;color:var(--f);text-transform:uppercase}
svg{display:block;width:100%;height:auto}
.warn{color:var(--gs)}.bad{color:var(--er)}.good{color:var(--ok)}
.hint{font-size:11.5px;color:var(--dim);line-height:1.5}
.hint code{color:var(--lm)}
@media(max-width:900px){.tab.on{flex-direction:column}.side{width:100%;max-width:none;border-left:0;border-top:1px solid var(--ln);max-height:45vh}}
</style></head><body>
<header>
  <h1>SQE Wire Tap</h1>
  <span class="pill" id="st"><span class="dot unk"></span>starting</span>
  <span class="pill">LM <b id="bl">0</b>B</span><span class="pill">GSPro <b id="bg">0</b>B</span>
  <span class="pill">DB rows <b id="dr">0</b></span><span class="pill">log lines <b id="fl">0</b></span>
  <span class="pill">fields <b id="fc">0</b></span><span class="pill">shots <b id="sc">0</b></span>
  <span style="flex:1"></span>
  <input id="mk" placeholder="mark: e.g. 7i stock #1" style="width:190px">
  <button id="bMark">mark</button><button id="bProbe">probe</button>
  <button class="pri" id="bDemo" title="Runs a second copy with a pretend launch monitor and GSPro. Your data is untouched.">try it with pretend shots</button><a href="/"><button>back to the app</button></a>
</header>
<nav><button class="on" data-t="wire">Wire</button><button data-t="sess">Session</button><button data-t="sys">System</button></nav>
<main>
<section class="tab on" id="t-wire">
  <div style="flex:1;display:flex;flex-direction:column;min-width:0">
    <div style="padding:6px 10px;border-bottom:1px solid var(--ln);display:flex;gap:6px;flex-wrap:wrap">
      <button class="on" data-k="raw">raw bytes</button><button class="on" data-k="msg">JSON</button><button class="on" data-k="db">GSPro DB</button>
      <button class="on" data-k="file">logs</button><button class="on" data-k="note">notes</button><button id="bHex">hex</button><button class="on" id="bFollow">follow</button>
      <button id="bClear">clear view</button><span style="flex:1"></span>
      <a href="/download/capture"><button>download capture</button></a><a href="/download/schema"><button>download fields</button></a>
    </div>
    <div id="feed"></div>
  </div>
  <div class="side"><h2>Every field seen, by source</h2>
    <table><thead><tr><th>source</th><th>path</th><th>type</th><th class="n">n</th><th class="n">min</th><th class="n">max</th><th>samples</th></tr></thead><tbody id="sb"></tbody></table>
    <div class="in hint" id="se" style="padding:14px">Nothing yet. Press <b>probe</b> to check the pipe, then take a swing.</div>
  </div>
</section>
<section class="tab" id="t-sess"><div class="grid">
  <div class="card" style="grid-column:1/-1"><h2>Now</h2><div class="in" id="nowBox"><div class="mut">No plan running. Build one from your bag below, or set a club by hand in card 1.</div></div></div>
  <div class="card"><h2>0 · Your bag and plan</h2><div class="in">
    <div class="hint" style="margin-bottom:6px">One club per line: name and your flushed carry in yards. Class is guessed from the name; add it as a third word to override (wedge, short_iron, mid_iron, long_iron, hybrid, wood, driver).</div>
    <textarea id="bagText" rows="8" style="width:100%;background:var(--pan2);color:var(--tx);border:1px solid var(--ln);border-radius:5px;font:inherit;padding:6px" placeholder="LW 70&#10;SW 85&#10;GW 100&#10;PW 120&#10;9i 135&#10;7i 160&#10;5i 185&#10;Driver 265"></textarea>
    <div class="fr" style="margin-top:6px"><label class="f">shots per step<input id="planShots" type="number" min="3" max="100" value="10"></label></div>
    <div class="fr"><button data-plan="discovery">find my numbers</button><button data-plan="baseline" class="pri">baseline bag</button><button data-plan="ladder">wedge ladder</button><button data-plan="shapes">stock / draw / fade</button></div>
  </div></div>
  <div class="card"><h2>1 · Who and what</h2><div class="in">
    <div class="fr"><label class="f">player<input id="pPlayer"></label><label class="f">hand<select id="pHand"><option>R</option><option>L</option></select></label></div>
    <div class="fr"><label class="f">sim<input id="sSim" placeholder="GSPro"></label><label class="f">sim version<input id="sVer" placeholder="from GSPro's about screen"></label></div>
    <div class="fr"><label class="f">conditions<input id="sCond" placeholder="range, default firmness, no wind"></label><label class="f">monitor firmware<input id="sFw" placeholder="e.g. 4.50"></label></div>
    <div class="fr"><label class="f">club<input id="lClub" placeholder="7i, PW, 52, Driver"></label>
      <label class="f">class<select id="lClass"><option>wedge</option><option>short_iron</option><option>mid_iron</option><option>long_iron</option><option>hybrid</option><option>wood</option><option>driver</option></select></label></div>
    <div class="fr"><label class="f">shape<select id="lShape"><option>stock</option><option>draw</option><option>fade</option><option>low</option><option>high</option><option>punch</option></select></label>
      <label class="f">domain<select id="lDomain"><option value="full">full swing</option><option value="partial">partial</option><option value="tee">tee</option></select></label></div>
    <div class="fr"><label class="f">target (yd)<input id="lTarget" type="number" min="1" step="1"></label>
      <label class="f">mode<select id="lMode"><option value="target">target (scored)</option><option value="discovery">discovery (find my number)</option></select></label>
      <label class="f">build<input id="lBuild" placeholder="optional: shaft/head"></label></div>
    <button class="pri" id="bSave">save</button> <button id="bNewSess">new session</button>
  </div></div>
  <div class="card"><h2>2 · Which fields are the shot</h2><div class="in">
    <div class="hint" style="margin-bottom:8px">Pick from fields actually seen on the wire. Carry and offline are required. Verify the sign once: hit one ball clearly right; offline must read positive, otherwise tick flip.</div>
    <div id="maps"></div>
    <div class="fr" style="margin-top:6px"><button class="pri" id="bMap">save mapping</button><button id="bAuto">auto-suggest</button></div>
    <div style="margin-top:8px"><button id="bRec">start recording shots</button> <span id="recState" class="mut"></span></div>
  </div></div>
  <div class="card" style="grid-row:span 2"><h2>3 · This set</h2><div class="in" id="setBox"><div class="mut">No shots yet.</div></div></div>
  <div class="card"><h2>4 · Shots</h2><div style="max-height:320px;overflow-y:auto"><table><thead><tr><th>#</th><th class="n">offline yd</th><th class="n">carry yd</th><th class="n">vs target</th><th class="n">total yd</th><th></th></tr></thead><tbody id="shotRows"></tbody></table></div></div>
  <div class="card wide"><h2>5 · Bag this session (practice the top)</h2><div style="max-height:320px;overflow-y:auto"><table><thead><tr><th>club</th><th>shape</th><th class="n">target</th><th class="n">n</th><th class="n">rating</th><th class="n">±</th><th class="n">miss %</th><th></th></tr></thead><tbody id="bagRows"></tbody></table></div></div>
</div></section>
<section class="tab" id="t-sys"><div class="grid">
  <div class="card"><h2>Connection</h2><div class="in hint" id="sysConn"></div></div>
  <div class="card"><h2>Ports of interest</h2><div class="in"><button id="bPorts">refresh</button></div><table><thead><tr><th class="n">port</th><th>process</th><th class="n">pid</th></tr></thead><tbody id="portRows"></tbody></table></div>
  <div class="card"><h2>GSPro data files (read-only)</h2><div class="in"><button id="bRescan">rescan</button></div><div id="dbList" class="in hint"></div></div>
  <div class="card" style="grid-column:1/-1"><h2>Physics learner (shadow mode: never used for scores until it passes the gate)</h2><div class="in hint" id="physBox">Loading...</div></div>
  <div class="card"><h2>Logs being tailed</h2><div id="logList" class="in hint"></div></div>
  <div class="card"><h2>Downloads</h2><div class="in hint"><a href="/download/capture"><button>capture (everything)</button></a> <a href="/download/schema"><button>field list</button></a> <a href="/download/db"><button>sqe.db (shots)</button></a></div></div>
</div></section>
</main>
<script>
var $=function(id){return document.getElementById(id)};
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function post(u,b){return fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}).then(function(r){return r.json()})}
function f1(v,d){return v==null||!isFinite(v)?'—':Number(v).toFixed(d==null?1:d)}
var show={raw:true,msg:true,db:true,file:true,note:true},hex=false,follow=true;
document.querySelectorAll('nav button').forEach(function(b){b.onclick=function(){document.querySelectorAll('nav button').forEach(function(x){x.classList.toggle('on',x===b)});document.querySelectorAll('.tab').forEach(function(t){t.classList.toggle('on',t.id==='t-'+b.dataset.t)});if(b.dataset.t==='wire'&&follow){var fd=$('feed');fd.scrollTop=fd.scrollHeight}if(b.dataset.t==='sess')refreshSession();if(b.dataset.t==='sys')refreshSystem()}});
document.querySelectorAll('[data-k]').forEach(function(b){b.onclick=function(){show[b.dataset.k]=!show[b.dataset.k];b.classList.toggle('on',show[b.dataset.k])}});
$('bHex').onclick=function(){hex=!hex;this.classList.toggle('on',hex)};
$('bFollow').onclick=function(){follow=!follow;this.classList.toggle('on',follow)};
$('bClear').onclick=function(){$('feed').innerHTML=''};
$('bProbe').onclick=function(){post('/api/probe')};
$('bDemo').onclick=function(){var b=this;b.textContent='starting the demo...';fetch('/api/demo/start',{method:'POST'}).then(function(r){return r.json()}).then(function(j){b.textContent='try it with pretend shots';if(j.url)window.open(j.url,'_blank')})};
$('bMark').onclick=function(){var t=$('mk').value.trim();if(t){post('/api/mark',{text:t});$('mk').value=''}};
$('mk').onkeydown=function(e){if(e.key==='Enter')$('bMark').onclick()};
function group(ev){var k=ev.kind;if(k==='conn')return'skip';if(k==='raw'||k==='partial')return'raw';if(k==='msg'||k==='badjson')return'msg';if(k.indexOf('db')===0)return'db';if(k.indexOf('file')===0)return'file';if(k==='note'||k==='conn'||k==='config'||k==='exclude')return'note';return'always'}
function line(ev){
  var g=group(ev);if(g==='skip')return;if(g!=='always'&&!show[g])return;
  var dir=ev.dir||(g==='db'?'DB':g==='file'?'FILE':ev.kind==='shot'?'SHOT':'');var b='';
  if(ev.kind==='raw')b=(hex?ev.hex:esc(ev.utf8))+'  ('+ev.bytes+'B)';
  else if(ev.kind==='msg')b=esc(ev.raw);
  else if(ev.kind==='badjson')b='PARSE FAIL '+esc(ev.err)+' :: '+esc(String(ev.raw).slice(0,300));
  else if(ev.kind==='partial')b='waiting for rest of message ('+ev.held+'B): '+esc(ev.preview);
  else if(ev.kind==='db_row'||ev.kind==='db_update'||ev.kind==='db_sample')b=(ev.kind==='db_update'?'UPDATED ':ev.kind==='db_sample'?'existing ':'NEW ')+esc(ev.table)+'  '+esc(JSON.stringify(ev.row));
  else if(ev.kind==='db_table')b='table '+esc(ev.table)+' ('+ev.rows+' rows): '+esc(ev.cols.join(', '));
  else if(ev.kind==='file')b=esc(ev.file.split(/[\\\\/]/).pop())+': '+esc(ev.line);
  else if(ev.kind==='file_context')b=esc(ev.file)+' (last lines):\\n'+esc(ev.lines.join('\\n'));
  else if(ev.kind==='shot')b='SHOT '+(ev.complete?'':'INCOMPLETE ')+esc(ev.label.club+' '+ev.label.shape)+'  offline '+f1(ev.offlineYd)+' yd  carry '+f1(ev.carryYd)+' yd  total '+f1(ev.totalYd)+' yd  ball '+f1(ev.ballMph)+' mph  from '+esc(ev.sources.join('+'));
  else if(ev.kind==='mark')b='MARK  '+esc(ev.text);
  else if(ev.kind==='note')b=esc(ev.msg);
  else if(ev.kind==='conn')b='connection '+ev.event+(ev.peer?' '+ev.peer:'')+(ev.probe?' (probe)':'');
  else b=esc(JSON.stringify(ev));
  var d=document.createElement('div');d.className='row k-'+ev.kind+(ev.level?' lvl-'+ev.level:'');
  d.innerHTML='<span class="sq">'+ev.seq+'</span><span class="tm">'+(ev.t/1000).toFixed(2)+'</span><span class="dr '+dir+'">'+(dir||'·')+'</span><span class="bd">'+b+'</span>';
  var feed=$('feed');feed.appendChild(d);while(feed.childElementCount>4000)feed.removeChild(feed.firstChild);if(follow)feed.scrollTop=feed.scrollHeight;
}
var schema=[];
function refreshSchema(){fetch('/api/schema').then(function(r){return r.json()}).then(function(j){schema=j;$('fc').textContent=j.length;$('se').style.display=j.length?'none':'block';
  $('sb').innerHTML=j.map(function(e){return'<tr><td>'+esc(e.src)+'</td><td class="p">'+esc(e.path)+'</td><td>'+esc(e.types.join('/'))+'</td><td class="n">'+e.count+'</td><td class="n">'+(e.min==null?'':e.min)+'</td><td class="n">'+(e.max==null?'':e.max)+'</td><td>'+esc(e.samples.join(' '))+'</td></tr>'}).join('')})}
function refreshStats(){fetch('/api/stats').then(function(r){return r.json()}).then(function(s){
  $('bl').textContent=s.bytesLM;$('bg').textContent=s.bytesGS;$('dr').textContent=s.dbRows+s.dbUpdates;$('fl').textContent=s.fileLines;$('sc').textContent=s.shotsSaved+(s.shotsIncomplete?' (+'+s.shotsIncomplete+' incomplete)':'');
  var fromDb=!s.liveConns&&(s.dbRows+s.dbUpdates)>0;
  var cls=fromDb||s.upstreamListening===true?'up':s.upstreamListening===false?'down':'unk';
  // When the launch monitor talks to GSPro directly (Foresight/Bushnell connector), nothing uses port 921 or 9211: shots come from GSPro's database.
  $('st').innerHTML='<span class="dot '+cls+'"></span>'+(fromDb?'reading shots from GSPro\u2019s database (launch monitor talks to GSPro directly; ports not used)':s.mode+(s.listenPort?' :'+s.listenPort:'')+(s.upstream?' → '+s.upstream:'')+'  ·  '+(s.liveConns?s.liveConns+' LM connected':'no LM connected'));
  $('sysConn').innerHTML='<div>'+esc(s.version)+'</div><div>mode <b>'+esc(s.mode)+'</b></div><div>listening on <b>'+(s.listenPort||'—')+'</b> · forwarding to <b>'+(s.upstream||'nothing')+'</b></div><div>GSPro API check: <b class="'+(s.upstreamListening===true?'good':s.upstreamListening===false?'bad':'')+'">'+esc(s.upstreamCheck)+'</b></div><div>capture file: <code>'+esc(s.logPath)+'</code></div><div>shot store: <code>'+esc(s.sqeDb)+'</code></div>';
  $('bRec').textContent=s.recording?'stop recording':'start recording shots';$('bRec').className=s.recording?'rec':'';
  $('recState').textContent=s.recording?('recording to session #'+(s.session||'(starts on first shot)')):'not recording';
})}
// ---- session tab
var MAPS=[['carry','carry distance','yd',true],['offline','offline (+ right)','yd',true],['total','total distance','yd',false],['ballSpeed','ball speed','mph',false]];
var UNITS={yd:['yd','m','ft'],mph:['mph','mps','kmh']};
function numericFields(){return schema.filter(function(e){return e.types.indexOf('number')>=0||(e.min!=null)})}
function srcOf(e){return e.src==='LM'||e.src==='GS'?'LM':e.src.indexOf('DB:')===0?'DB':'FILE'}
function keyOf(e){return e.src.indexOf('DB:')===0?e.src.slice(3)+'.'+e.path:e.src.indexOf('FILE:')===0?e.src.slice(5)+'.'+e.path:e.path}
function drawMaps(cfg){
  var nf=numericFields().filter(function(e){return e.src!=='GS'});
  $('maps').innerHTML=MAPS.map(function(m){var cur=cfg.mapping[m[0]]||{};var opts='<option value="">'+(m[3]?'— required —':'— none —')+'</option>'+nf.map(function(e){var v=srcOf(e)+'|'+keyOf(e),k=keyOf(e),leaf=k.split('.').pop(),rest=k.slice(0,Math.max(0,k.length-leaf.length-1));return'<option value="'+esc(v)+'"'+(cur.src+'|'+cur.path===v?' selected':'')+'>'+esc(leaf+'   ·   '+srcOf(e)+(rest?' '+rest:'')+'   e.g. '+(e.samples[0]||''))+'</option>'}).join('');
    var us=UNITS[m[2]].map(function(u){return'<option'+((cur.unit||m[2])===u?' selected':'')+'>'+u+'</option>'}).join('');
    return'<div class="fr" style="border-top:1px solid var(--ln);padding-top:6px"><label class="f" style="flex:1 1 100%">'+m[1]+'<select data-m="'+m[0]+'" style="width:100%">'+opts+'</select></label><label class="f" style="flex:0 0 110px">unit<select data-u="'+m[0]+'">'+us+'</select></label>'+(m[0]==='offline'?'<label class="f" style="flex:0 0 auto;flex-direction:row;align-items:center;gap:6px;margin-top:14px"><input type="checkbox" data-fl="offline"'+(cur.flip?' checked':'')+'> flip sign</label>':'')+'</div>'}).join('');
}
function collectMaps(){var mp={};MAPS.forEach(function(m){var v=document.querySelector('[data-m="'+m[0]+'"]').value;if(!v)return;var i=v.indexOf('|');mp[m[0]]={src:v.slice(0,i),path:v.slice(i+1),unit:document.querySelector('[data-u="'+m[0]+'"]').value};if(m[0]==='offline')mp[m[0]].flip=document.querySelector('[data-fl="offline"]').checked});return mp}
function autoSuggest(){var nf=numericFields().filter(function(e){return e.src!=='GS'});var pick=function(re){var c=nf.filter(function(e){return re.test(e.path)});c.sort(function(a,b){var r=function(e){return srcOf(e)==='DB'?0:srcOf(e)==='FILE'?1:2};return r(a)-r(b)||b.count-a.count});return c[0]};
  var pairs={carry:/carry/i,offline:/offline|side.?dist|lateral/i,total:/total.?dist|totaldistance/i,ballSpeed:/ball.?speed|BallData\\.Speed$/i};
  Object.keys(pairs).forEach(function(k){var e=pick(pairs[k]);if(e){var s=document.querySelector('[data-m="'+k+'"]');s.value=srcOf(e)+'|'+keyOf(e)}})}
function loadCfg(){return fetch('/api/config').then(function(r){return r.json()}).then(function(c){
  $('pPlayer').value=c.player;$('pHand').value=c.handed;$('sSim').value=c.setup.sim;$('sVer').value=c.setup.simVersion;$('sCond').value=c.setup.conditions;$('sFw').value=c.setup.deviceFw||'';
  if(!$('bagText').dataset.touched&&c.bag&&c.bag.length)$('bagText').value=c.bag.map(function(b){return b.club+' '+b.stockYd+' '+b.clubClass}).join('\\n');$('lClub').value=c.label.club;$('lClass').value=c.label.clubClass;$('lShape').value=c.label.shape;$('lDomain').value=c.label.domain;$('lTarget').value=c.label.targetYd;$('lMode').value=c.label.mode;$('lBuild').value=c.label.build;drawMaps(c);return c})}
$('bagText').oninput=function(){this.dataset.touched='1'};
function guessClass(c){c=c.toUpperCase();if(/^(DR|DRIVER|1W)$/.test(c))return'driver';if(/^\\dW|WOOD/.test(c))return'wood';if(/^\\dH|HYB/.test(c))return'hybrid';if(/^(PW|GW|AW|SW|LW)$/.test(c)||/^\\d{2}$/.test(c))return'wedge';var m=c.match(/^(\\d)I?$/);if(m){var n=+m[1];return n>=8?'short_iron':n>=5?'mid_iron':'long_iron'}return'mid_iron'}
function parseBag(){return $('bagText').value.split(/\\n/).map(function(l){var t=l.trim().split(/\\s+/);if(t.length<2)return null;var yd=parseFloat(t[1]);if(!(yd>0))return null;return{club:t[0],stockYd:yd,clubClass:t[2]||guessClass(t[0])}}).filter(Boolean)}
document.querySelectorAll('[data-plan]').forEach(function(b){b.onclick=function(){var bag=parseBag();if(!bag.length){alert('Enter your clubs and carries first.');return}post('/api/plan/generate',{kind:b.dataset.plan,shots:Number($('planShots').value),bag:bag}).then(function(p){if(!p.steps.length)alert(b.dataset.plan==='ladder'?'No wedges in the bag list.':'Nothing to plan.');refreshSession()})}});
function drawNow(v){var p=v.plan,box=$('nowBox');if(!p||!p.step||!p.active){box.innerHTML='<div class="mut">'+(p&&p.total&&!p.active?'Plan finished or stopped. ':'')+'No plan running. Build one from your bag below, or set a club by hand in card 1.</div>';return}
  var s=p.step,left=Math.max(0,s.shots-p.done);
  box.innerHTML='<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap"><div><div class="mut" style="font-size:11px">STEP '+(p.index+1)+' OF '+p.total+'</div><div style="font-size:30px;font-weight:700;color:var(--tx)">'+esc(s.club)+' <span style="color:var(--lm)">'+(s.mode==='discovery'?'stock swing':esc(String(s.targetYd))+' yd')+'</span> '+(s.shape!=='stock'?'<span style="color:var(--gs)">'+esc(s.shape)+'</span>':'')+'</div><div class="hint">'+esc(s.note)+'</div></div>'+
  '<div style="text-align:center"><div style="font-size:42px;font-weight:700;color:'+(left?'var(--tx)':'var(--ok)')+'">'+p.done+'<span class="mut" style="font-size:20px"> / '+s.shots+'</span></div><div class="mut" style="font-size:11px">'+(left?left+' to go':'done')+'</div></div>'+
  '<div style="flex:1"></div><div class="hint">'+(p.next?'Next: '+esc(p.next.club)+' '+(p.next.mode==='discovery'?'':esc(String(p.next.targetYd))+' yd ')+(p.next.shape!=='stock'?esc(p.next.shape):''):'Last step')+'<div style="margin-top:6px"><button data-step="-1">back</button> <button data-step="1">skip</button> <button data-step="stop">stop plan</button></div></div></div>'+
  (v.recording?'':'<div class="warn" style="margin-top:6px">Press "start recording shots" in card 2 to count shots.</div>');
  document.querySelectorAll('[data-step]').forEach(function(b){b.onclick=function(){post('/api/plan/step',b.dataset.step==='stop'?{stop:true}:{delta:Number(b.dataset.step)}).then(refreshSession)}});
}
function drawWhy(w){if(!w)return'<div class="hint mut" style="margin-top:6px">After 6 shots: what drives the miss, measured from your launch data.</div>';
  var part=function(e,label){if(!e)return'';
    // Shares only add up cleanly when the inputs vary independently; with few shots they can come out
    // below 0 or above 100%. Then the honest answer is "not separable yet", plus the measured slopes.
    var ok=e.drivers.every(function(d){return d.share>-0.05&&d.share<1.05});
    if(!ok)return'<div style="margin-top:4px"><b>'+label+'</b> <span class="warn">not separable yet at n='+e.n+'</span>: these inputs moved together. Slopes: '+e.drivers.map(function(d){return esc(nice(d.name))+' '+f1(d.perUnit,2)+'±'+f1(d.se,2)}).join(' · ')+'</div>';
    return'<div style="margin-top:4px"><b>'+label+'</b> '+e.drivers.map(function(d){return esc(nice(d.name))+' '+Math.round(Math.max(0,d.share)*100)+'%'}).join(' · ')+' · <span class="mut">unexplained '+Math.round(Math.max(0,e.unexplained)*100)+'%</span></div>'};
  return'<div class="hint" style="margin-top:8px">What drives the miss (regression on your own shots, n='+((w.offline||w.carry||{}).n||0)+'):'+part(w.offline,'offline ←')+part(w.carry,'carry ←')+'</div>'}
function drawLaunch(L){if(!L)return'';var s=function(x,d){return f1(x,d==null?1:d)};
  return'<div class="hint" style="margin-top:8px"><b>Launch layer</b> <span class="mut">(straight from the monitor; no sim, no physics)</span><div class="kv" style="margin-top:4px"><div><span>start line</span><b>'+(L.startLine.mean>=0?'R ':'L ')+s(Math.abs(L.startLine.mean))+'° ±'+s(L.startLine.sd)+'</b></div><div><span>curve axis</span><b>'+(L.curveAxis.mean>=0?'+':'')+s(L.curveAxis.mean)+'° ±'+s(L.curveAxis.sd)+'</b></div><div><span>start-line miss %</span><b>'+s(L.piStart*100,2)+'</b></div><div><span>ball speed ±</span><b>'+s(L.speedCv*100,1)+'%</b></div><div><span>launch ±</span><b>'+s(L.launch.sd)+'°</b></div><div><span>spin ±</span><b>'+s(L.spinCv*100,0)+'%</b></div></div></div>'}
function nice(k){return{startLine:'start line',spinAxis:'curve (spin axis)',ballSpeed:'ball speed',launch:'launch angle',spin:'spin'}[k]||k}
$('bSave').onclick=function(){post('/api/config',{player:$('pPlayer').value.trim()||'Player 1',handed:$('pHand').value,setup:{sim:$('sSim').value.trim(),simVersion:$('sVer').value.trim(),conditions:$('sCond').value.trim(),deviceFw:$('sFw').value.trim()},label:{club:$('lClub').value.trim()||'?',clubClass:$('lClass').value,shape:$('lShape').value,domain:$('lDomain').value,targetYd:Number($('lTarget').value),mode:$('lMode').value,build:$('lBuild').value.trim()}}).then(refreshSession)};
$('bMap').onclick=function(){post('/api/config',{mapping:collectMaps()}).then(loadCfg)};
$('bAuto').onclick=autoSuggest;
$('bNewSess').onclick=function(){post('/api/session/new').then(refreshSession)};
$('bRec').onclick=function(){fetch('/api/config').then(function(r){return r.json()}).then(function(c){if(!c.recording&&!(c.mapping.carry&&c.mapping.offline)){alert('Map carry and offline first.');return}post('/api/config',{recording:!c.recording}).then(refreshStats)})};
function plot(sc,targetYd){
  if(!sc||!sc.metrics)return'';var m=sc.metrics,YD=0.9144;
  var pts=sc.pts.map(function(p){return[p.x/YD,p.y/YD]});var c90=sc.contours[sc.contours.length-1];
  var ext=Math.max(8,c90.ra/YD*1.15+Math.hypot(m.muX,m.muY)/YD);pts.forEach(function(p){ext=Math.max(ext,Math.abs(p[0])*1.1,Math.abs(p[1])*1.1)});
  var W=360,H=360,s=(W/2-14)/ext,X=function(x){return W/2+x*s},Y=function(y){return H/2-y*s};
  var o='<svg viewBox="0 0 '+W+' '+H+'"><rect x="0" y="0" width="'+W+'" height="'+H+'" fill="#0e141b"/>';
  o+='<line x1="'+X(-ext)+'" y1="'+Y(0)+'" x2="'+X(ext)+'" y2="'+Y(0)+'" stroke="#24303d"/><line x1="'+X(0)+'" y1="'+Y(-ext)+'" x2="'+X(0)+'" y2="'+Y(ext)+'" stroke="#24303d"/>';
  var shades=['#123a40','#14474e','#185861','#1c6b75','#22808b'];
  for(var i=sc.contours.length-1;i>=0;i--){var c=sc.contours[i];o+='<ellipse cx="'+X(c.cx/YD)+'" cy="'+Y(c.cy/YD)+'" rx="'+(c.ra/YD*s)+'" ry="'+(c.rb/YD*s)+'" transform="rotate('+(-c.thetaDeg)+' '+X(c.cx/YD)+' '+Y(c.cy/YD)+')" fill="'+shades[sc.contours.length-1-i]+'" fill-opacity=".55" stroke="#39d0d8" stroke-opacity=".35"/>'}
  pts.forEach(function(p){o+='<circle cx="'+X(p[0])+'" cy="'+Y(p[1])+'" r="3.6" fill="#e6edf3" stroke="#0b0f14"/>'});
  o+='<circle cx="'+X(0)+'" cy="'+Y(0)+'" r="7" fill="none" stroke="#3fb950" stroke-width="2"/><circle cx="'+X(m.muX/YD)+'" cy="'+Y(m.muY/YD)+'" r="5" fill="none" stroke="#f0b429" stroke-width="2"/>';
  o+='<text x="6" y="14" fill="#5d6977" font-size="10">long</text><text x="6" y="'+(H-6)+'" fill="#5d6977" font-size="10">short</text><text x="'+(W-34)+'" y="'+(H/2-4)+'" fill="#5d6977" font-size="10">right</text>';
  return o+'</svg><div class="hint">Bands hold 10/25/50/75/90% of shots if the pattern is normal. Actual share inside: '+sc.contours.map(function(c){return Math.round(c.p*100)+'%→'+Math.round(c.empirical*100)+'%'}).join(' · ')+'. Green = target, amber = your center.</div>';
}
function refreshSession(){return Promise.all([loadCfg(),fetch('/api/session').then(function(r){return r.json()})]).then(function(a){var v=a[1];
  if(!v.store){$('setBox').innerHTML='<div class="warn">Shot store unavailable on this runtime. Capture still works. Use tap.exe, Bun, or Node 22.18+.</div>';return}
  drawNow(v);
  $('shotRows').innerHTML=v.shots.map(function(s,i){return'<tr style="'+(s.excluded?'opacity:.4':'')+'"><td>'+(i+1)+(s.complete?'':' <span class="warn">incomplete</span>')+'</td><td class="n">'+f1(s.offlineYd)+'</td><td class="n">'+f1(s.carryYd)+'</td><td class="n">'+f1(s.depthYd)+'</td><td class="n">'+f1(s.totalYd)+'</td><td><button data-ex="'+s.id+'" data-v="'+(s.excluded?0:1)+'">'+(s.excluded?'include':'exclude')+'</button></td></tr>'}).join('')||'<tr><td colspan="6" class="mut">No shots for this label in this session.</td></tr>';
  document.querySelectorAll('[data-ex]').forEach(function(b){b.onclick=function(){var why=b.dataset.v==='1'?prompt('Why exclude? (misread, practice swing, wrong club)','misread'):'';if(b.dataset.v==='1'&&!why)return;post('/api/shot/'+b.dataset.ex+'/exclude',{excluded:b.dataset.v==='1',why:why}).then(refreshSession)}});
  var sc=v.scored,box=$('setBox');
  if(!sc||sc.error||!sc.metrics){box.innerHTML='<div class="mut">'+(sc&&sc.error?esc(sc.error):'Need 3 usable shots for '+esc(v.label.club)+' at '+f1(v.label.targetYd,0)+' yd.')+'</div>';}
  else{var m=sc.metrics;sc.pts=v.shots.filter(function(s){return s.complete&&!s.excluded}).map(function(s){return{x:s.offline_m,y:m.mode==='discovery'?s.depth_m-m.depthOffset:s.depth_m}});
    var lead=m.piB>m.piS?'aim (bias)':'strike (scatter)';
    box.innerHTML='<div style="display:flex;align-items:baseline;gap:10px"><span class="big">'+f1(m.rating,0)+'</span><span class="mut">± '+f1(m.rd,0)+' · 95% '+f1(m.ratingLo,0)+'–'+f1(m.ratingHi,0)+' · n='+m.n+(m.mode==='discovery'?' · <span class="warn">discovery</span>':'')+'</span></div>'+
      '<div class="kv" style="margin:8px 0"><div><span>miss %</span><b>'+f1(m.piQ*100,2)+'</b></div><div><span>aim %</span><b>'+f1(m.piB*100,2)+'</b></div><div><span>scatter %</span><b>'+f1(m.piS*100,2)+'</b></div>'+
      '<div><span>tilt</span><b>'+(m.tiltSignificant?f1(m.thetaDeg,0)+'° ±'+f1(m.thetaHalfWidthDeg,0):'none found')+'</b></div><div><span>shape b/a</span><b>'+f1(m.piE,2)+'</b></div><div><span>trimmed</span><b>'+f1(m.ratingTrim,0)+'</b></div></div>'+
      '<div class="hint">Bigger leak: <b>'+lead+'</b>. Center sits '+f1(Math.abs(m.muX/0.9144))+' yd '+(m.muX>=0?'right':'left')+(m.mode==='discovery'?' · measured stock carry '+f1(v.label.targetYd+m.depthOffset/0.9144)+' yd':', '+f1(Math.abs(m.muY/0.9144))+' yd '+(m.muY>=0?'long':'short'))+'.'+(m.tiltSignificant?'':' No directional pattern is detectable at this shot count.')+'</div>'+(v.shadow?'<div class="hint" style="margin-top:6px">Same shots through the learned physics: <b>'+f1(v.shadow.rating,0)+'</b> ± '+f1(v.shadow.rd,0)+' vs '+esc((v.setup&&v.setup.sim)||'sim')+' '+f1(m.rating,0)+' <span class="mut">('+esc(v.shadow.version)+(v.shadow.promotable?', gate passed':', shadow only')+')</span></div>':'')+drawLaunch(v.launch)+drawWhy(v.why)+plot(sc,v.label.targetYd);}
  $('bagRows').innerHTML=v.bag.map(function(b){return'<tr><td>'+esc(b.club)+'</td><td>'+esc(b.shape)+'</td><td class="n">'+f1(b.targetYd,0)+'</td><td class="n">'+b.n+'</td><td class="n">'+(b.rating==null?'—':f1(b.rating,0))+'</td><td class="n">'+(b.rd==null?'':f1(b.rd,0))+'</td><td class="n">'+(b.piQ==null?'':f1(b.piQ*100,2))+'</td><td>'+(b.tiedForLast?'<span class="warn">practice</span>':'')+(b.mode==='discovery'?' <span class="mut">discovery</span>':'')+'</td></tr>'}).join('')||'<tr><td colspan="8" class="mut">Nothing scored yet.</td></tr>';
})}
// ---- system tab
function refreshSystem(){fetch('/api/system').then(function(r){return r.json()}).then(function(s){
  $('portRows').innerHTML=(s.ports.length?s.ports:[]).map(function(p){return'<tr><td class="n">'+p.port+'</td><td>'+esc(p.name||'')+'<div class="mut">'+esc(p.path||'')+'</div></td><td class="n">'+(p.pid||'')+'</td></tr>'}).join('')||'<tr><td colspan="3" class="mut">'+(s.allPortsCount?'No GSPro or launch monitor ports listening.':'Port list not available yet (refresh).')+'</td></tr>';
  $('dbList').innerHTML=(s.dbs.map(function(d){return'<div style="margin-bottom:8px"><code>'+esc(d.file)+'</code>'+(d.viaCopy?' <span class="warn">(reading a copy: file is locked)</span>':'')+(d.error?' <span class="bad">'+esc(d.error)+'</span>':'')+'<div>'+d.tables.map(function(t){return esc(t.name)+' <span class="mut">('+esc(t.cols.join(', '))+')</span>'}).join('<br>')+'</div></div>'}).join('')||'None found under: '+esc(s.roots.join(', ')||'(no GSPro folders found)')+'. Use --gsprodb &lt;path&gt;.')+'<div class="mut">runtime '+esc(s.runtime)+' · '+esc(s.platform)+'</div>';
  $('logList').innerHTML=s.logs.map(function(l){return'<div><code>'+esc(l.file)+'</code></div>'}).join('')||'None found.';
  refreshPhysics();
  if(s.uiHost!=='127.0.0.1')$('sysConn').innerHTML+='<div>View from another device: '+s.lan.map(esc).join(', ')+'</div>';
})}
function refreshPhysics(){fetch('/api/physics').then(function(r){return r.json()}).then(function(p){var b=$('physBox');var L=p.latest;
  var h='<div>Learning <b>'+esc((p.setup.sim||'?')+' '+(p.setup.simVersion||'(version not entered)'))+'</b> physics from your own shots: <b>'+p.pairs+'</b> paired shots (launch numbers in, landing out). First fit at '+p.first+', then every '+p.every+'. '+(p.running?'<span class="warn">Fitting now in the background...</span>':'')+'</div>';
  if(p.error)h+='<div class="bad">'+esc(p.error)+'</div>';
  if(!L)h+='<div class="mut" style="margin-top:6px">No fit yet.</div>';
  else{var f=L.fit,g=L.gate;h+='<div style="margin-top:8px">Latest: <code>'+esc(f.version)+'</code> from '+f.nTrain+' shots. Shape chosen by held-out error: <b>'+esc(f.shape)+'</b>.</div>'+
    '<div class="kv" style="margin-top:6px"><div><span>held-out carry error</span><b>'+f1(f.cvCarryRms/0.9144,2)+' yd</b></div><div><span>held-out offline error</span><b>'+f1(f.cvOfflineRms/0.9144,2)+' yd</b></div><div><span>gate</span><b class="'+(g.promotable?'good':'warn')+'">'+(g.promotable?'PASSES':'not yet')+'</b></div></div>'+
    '<div style="margin-top:6px">Gate: '+g.sets+' sets, '+Math.round(g.passRate*100)+'% move by less than a quarter of their own error bar (needs 95% of at least 5 sets). Median rating shift '+f1(g.medianShift,2)+' pts, worst '+f1(g.worstShift,2)+'.</div>'+
    '<table style="margin-top:6px"><thead><tr><th>coefficient</th><th class="n">value</th><th class="n">± (relative)</th><th>pinned down by your data?</th></tr></thead><tbody>'+f.names.map(function(n,i){return'<tr><td>'+esc(n)+'</td><td class="n">'+Number(f.x[i]).toPrecision(4)+'</td><td class="n">'+f1(f.relSe[i]*100,1)+'%</td><td>'+(f.identified[i]?'<span class="good">yes</span>':'<span class="warn">not yet</span>')+'</td></tr>'}).join('')+'</tbody></table>'+
    '<div class="mut" style="margin-top:6px">Other shapes tried (held-out carry / offline, yd): '+f.shapes.map(function(s){return esc(s.shape)+' '+f1(s.cvCarryRms/0.9144,2)+' / '+f1(s.cvOfflineRms/0.9144,2)}).join(' · ')+'</div>'+
    (L.change?'<div style="margin-top:6px">Change check on the '+L.change.n+' shots since the previous fit: '+(L.change.changed?'<b class="bad">simulator physics changed</b>':'<span class="good">no change</span>')+' (z='+f1(L.change.z,1)+')</div>':'');}
  h+='<div style="margin-top:8px"><button id="bLearn">fit now</button></div>';b.innerHTML=h;var bl=$('bLearn');if(bl)bl.onclick=function(){post('/api/physics/learn').then(function(){setTimeout(refreshPhysics,500)})};})}
$('bPorts').onclick=function(){post('/api/ports').then(refreshSystem)};
$('bRescan').onclick=function(){post('/api/rescan').then(refreshSystem)};
var es=new EventSource('/events');
es.onmessage=function(e){var ev=JSON.parse(e.data);line(ev);if(ev.kind==='learn'&&document.getElementById('t-sys').classList.contains('on'))refreshPhysics();if(ev.kind==='shot'||ev.kind==='exclude'||ev.kind==='plan'){if(document.getElementById('t-sess').classList.contains('on'))refreshSession()}};
setInterval(refreshSchema,1500);setInterval(refreshStats,1000);refreshSchema();refreshStats();
</script></body></html>`;

// ---------------------------------------------------------------- app API (the guided UI)

const CLUB_ORDER = ['DRIVER', 'DR', '1W', '2W', '3W', '4W', '5W', '7W', '9W', '2H', '3H', '4H', '5H', '6H', '1I', '2I', '3I', '4I', '5I', '6I', '7I', '8I', '9I', 'PW', 'AW', 'GW', 'SW', 'LW'];
function clubRank(club: string): number {
  const c = club.trim().toUpperCase();
  const i = CLUB_ORDER.indexOf(c);
  if (i >= 0) return i;
  const deg = c.match(/^(\d{2})$/);
  if (deg) return 23 + Number(deg[1]) / 100; // 46..64 degree wedges after PW
  return 100;
}

/** Compares the simulator's ball speed with the launch monitor's (mph) for the latest shot both saw. */
function unitsFromBallSpeed(f?: MapField): 'metric' | 'imperial' | 'unknown' {
  if (!f || f.src === 'LM') return 'unknown';
  const sims = recent[f.src].filter(s => typeof s.flat[f.path] === 'number').slice(-5);
  for (const s of sims.reverse()) {
    const lm = recent.LM.filter(x => typeof x.flat['BallData.Speed'] === 'number' && x.at <= s.at + 100 && s.at - x.at <= WINDOW_MS).sort((a, b) => b.at - a.at)[0];
    if (!lm) continue;
    const r = Number(s.flat[f.path]) / Number(lm.flat['BallData.Speed']);
    if (Math.abs(r - 1) < 0.03) return 'imperial';
    if (Math.abs(r - 1.609344) < 0.05) return 'metric';
  }
  return 'unknown';
}

function autoMapping(): { mapping: Config['mapping']; missing: string[] } {
  const fields = schemaDump().filter(e => e.src !== 'GS' && (e.types.includes('number') || e.min !== null));
  const srcOf = (e: any): Source => e.src === 'LM' ? 'LM' : e.src.startsWith('DB:') ? 'DB' : 'FILE';
  const keyOf = (e: any) => e.src.startsWith('DB:') ? `${e.src.slice(3)}.${e.path}` : e.src.startsWith('FILE:') ? `${e.src.slice(5)}.${e.path}` : e.path;
  const rank = (e: any) => (srcOf(e) === 'DB' ? 0 : srcOf(e) === 'FILE' ? 1 : 2);
  const pick = (re: RegExp, exclude?: RegExp) => fields.filter(e => re.test(e.path) && !(exclude && exclude.test(e.path)) && !(srcOf(e) === 'LM' && e.max === 0 && e.min === 0)).sort((a, b) => rank(a) - rank(b) || b.count - a.count)[0];
  // GSPro's LastShot row (ShotData JSON) uses Carry, TotalDistance, Offline and BallSpeed; other tools say
  // CarryDistance and so on. Exact names first, then looser ones; never the raw/echo copies (rawCarryLM is 0).
  const want: [keyof Config['mapping'], RegExp[], RegExp?][] = [
    ['carry', [/(^|\.)(Carry|CarryDistance)$/i, /carry/i], /raw|lm$/i], ['offline', [/(^|\.)Offline$/i, /offline|side.?dist|lateral/i], /raw/i],
    ['total', [/(^|\.)TotalDistance$/i, /total.?dist/i], /raw/i], ['ballSpeed', [/(^|\.)BallSpeed$/i, /ball.?speed$|BallData\.Speed$/i], /raw/i],
  ];
  const mapping: Config['mapping'] = {};
  const missing: string[] = [];
  for (const [k, res, ex] of want) {
    let e: any; for (const re of res) { e = pick(re, ex); if (e) break; }
    if (e) mapping[k] = { src: srcOf(e), path: keyOf(e), unit: k === 'ballSpeed' ? 'mph' : 'yd', ...(k === 'offline' ? { flip: cfg.mapping.offline?.flip ?? false } : {}) };
    else if (k === 'carry' || k === 'offline') missing.push(k);
  }
  // GSPro writes in the units it is showing. The launch monitor always sends mph, so the ratio of the two
  // ball speeds for the same shot says which: 1 is yards and mph, 1.609 is metres and km/h.
  const units = unitsFromBallSpeed(mapping.ballSpeed);
  if (units === 'metric') for (const k of ['carry', 'offline', 'total'] as const) if (mapping[k] && mapping[k]!.src !== 'LM') mapping[k]!.unit = 'm';
  if (units === 'metric' && mapping.ballSpeed && mapping.ballSpeed.src !== 'LM') mapping.ballSpeed.unit = 'kmh';
  return { mapping, missing, units } as any;
}

/** The most recent shot as the mapping would read it, recorded or not. Raw offline is before any sign flip. */
function preview() {
  const mp = cfg.mapping;
  if (!mp.carry) return null;
  const list = recent[mp.carry.src].filter(s => s.flat[mp.carry!.path] !== undefined);
  const anchor = list[list.length - 1];
  if (!anchor) return null;
  const parts: Partial<Record<Source, Sample>> = { [anchor.src]: anchor };
  for (const src of ['LM', 'DB', 'FILE'] as Source[]) if (src !== anchor.src) {
    const c = recent[src].filter(x => Math.abs(x.at - anchor.at) <= WINDOW_MS && (src !== 'LM' || x.at <= anchor.at + 100)).sort((a, b) => b.at - a.at)[0];
    if (c) parts[src] = c;
  }
  const carry = readField(mp.carry, parts), offRaw = readField(mp.offline, parts), total = readField(mp.total, parts), bs = readField(mp.ballSpeed, parts);
  const lm = parts.LM?.flat ?? {};
  return {
    at: anchor.at, ageS: (Date.now() - anchor.at) / 1000, ref: anchor.ref,
    carryYd: carry === null ? null : toM(carry, mp.carry.unit) / YD,
    offlineRawYd: offRaw === null ? null : toM(offRaw, mp.offline!.unit) / YD,
    offlineYd: offRaw === null ? null : (toM(offRaw, mp.offline!.unit) * (mp.offline!.flip ? -1 : 1)) / YD,
    totalYd: total === null ? null : toM(total, mp.total!.unit) / YD,
    ballMph: bs === null ? null : toMps(bs, mp.ballSpeed!.unit) / 0.44704,
    launch: { startLine: lm['BallData.HLA'] ?? null, launch: lm['BallData.VLA'] ?? null, spin: lm['BallData.TotalSpin'] ?? null, axis: lm['BallData.SpinAxis'] ?? null },
  };
}

function setPlayer(name: string, handed?: 'R' | 'L') {
  if (cfg.player !== name) {
    cfg.bags[cfg.player] = cfg.bag;
    cfg.player = name;
    cfg.bag = cfg.bags[name] ?? [];
    cfg.plan = { steps: [], index: 0, active: false };
    sessionId = 0;
  }
  if (handed) cfg.handed = handed;
  cfg.bags[cfg.player] = cfg.bag;
  saveConfig();
}

function playerSessions(): any[] {
  if (!store) return [];
  return store.all(`SELECT s.* FROM session s JOIN player p ON p.id=s.player_id WHERE p.name=? ORDER BY s.started_utc DESC, s.id DESC`, cfg.player);
}

/**
 * Every label in a set of sessions, scored, with its shots and pattern, for the results screen. Several
 * sessions (a whole evening, a week) pool their shots per club and target, so a club hit at 8:05 and again
 * at 8:13 is one pattern. Excluded shots come back too, marked, so they can be put back.
 */
/**
 * How this club is going today against its usual: the mean carry and stopping distance of these shots,
 * against every earlier full stock shot with the club (at least 5). "About usual" unless the difference is
 * more than twice its standard error.
 */
function usualFor(L: any, sids: number[], rs: any[]) {
  if (!store || L.domain === 'partial' || L.shape !== 'stock' || rs.length < 1) return null;
  const inQ = sids.map(() => '?').join(',');
  const before = store.all(`SELECT s.carry_m AS c, s.total_m AS t FROM shot s JOIN label l ON l.id=s.label_id JOIN session x ON x.id=s.session_id WHERE l.player_id=? AND l.club=? AND l.domain != 'partial' AND l.shape='stock' AND s.complete=1 AND s.excluded=0 AND s.session_id NOT IN (${inQ}) AND x.started_utc < (SELECT MIN(started_utc) FROM session WHERE id IN (${inQ}))`, L.player_id, L.club, ...sids, ...sids);
  if (before.length < 5) return null;
  const st = (v: number[]) => { const m = v.reduce((a, b) => a + b, 0) / v.length; return { m, sd: v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)) : 0, n: v.length }; };
  const cmp = (now: number[], then: number[]) => {
    if (!now.length || then.length < 5) return null;
    const a = st(now), b = st(then), se = Math.sqrt((a.n > 1 ? a.sd ** 2 / a.n : b.sd ** 2) + b.sd ** 2 / b.n);
    return { today: a.m / YD, usual: b.m / YD, diff: (a.m - b.m) / YD, real: Math.abs(a.m - b.m) > 2 * se, n: a.n, usualN: b.n };
  };
  return { carry: cmp(rs.map((r: any) => r.carry_m), before.map((r: any) => r.c)), stop: cmp(rs.filter((r: any) => r.total_m !== null).map((r: any) => r.total_m), before.filter((r: any) => r.t !== null).map((r: any) => r.t)) };
}

function resultsFor(sid: number | number[]) {
  const sids = (Array.isArray(sid) ? sid : [sid]).filter(Boolean);
  if (!store || !sids.length) return null;
  const inQ = sids.map(() => '?').join(',');
  const sessions = store.all(`SELECT * FROM session WHERE id IN (${inQ}) ORDER BY started_utc`, ...sids);
  if (!sessions.length) return null;
  const sess = sessions[sessions.length - 1];
  const labels = store.all(`SELECT DISTINCT l.* FROM label l JOIN shot s ON s.label_id=l.id WHERE s.session_id IN (${inQ})`, ...sids);
  const rows: any[] = [];
  // A wedge ladder step is a part swing: name it by its share of the full swing (25%, 50%, 75%), the nearest ladder step to target / full target.
  const swingOf = (L: any) => { if (L.domain !== 'partial') return null; const full = labels.find((x: any) => x.club === L.club && x.domain !== 'partial' && x.shape === 'stock'), b = cfg.bag.find(x => x.club === L.club); const fullYd = full ? full.target_m / YD : b ? targetFor(b) : 0; if (!fullYd) return null; const r = L.target_m / YD / fullYd; const f = WEDGE_FRACTIONS.reduce((a, c) => Math.abs(c - r) < Math.abs(a - r) ? c : a); return Math.round(f * 100) + '%'; };
  for (const L of labels) {
    const every = store.all(`SELECT id, struck_utc, offline_m, carry_m, total_m, rest_offline_m, excluded, exclude_why FROM shot WHERE session_id IN (${inQ}) AND label_id=? AND complete=1 ORDER BY struck_utc, id`, ...sids, L.id);
    const rs = every.filter((r: any) => !r.excluded);
    const list = every.map((r: any) => ({ id: r.id, at: r.struck_utc, carryYd: r.carry_m / YD, totalYd: r.total_m === null ? null : r.total_m / YD, offlineYd: r.offline_m / YD, depthYd: (pointOf(r, L.measure).y - L.target_m) / YD, excluded: !!r.excluded, why: r.exclude_why }));
    if (!rs.length) { rows.push({ id: L.id, club: L.club, swing: swingOf(L), clubClass: L.club_class, shape: L.shape, mode: L.mode, domain: L.domain, measure: L.measure, targetYd: L.target_m / YD, n: 0, shots: [], list }); continue; }
    const vsUsual = usualFor(L, sids, rs);
    const base = { id: L.id, club: L.club, swing: swingOf(L), vsUsual, clubClass: L.club_class, shape: L.shape, mode: L.mode, domain: L.domain, measure: L.measure, targetYd: L.target_m / YD, n: rs.length, list, shots: rs.map((r: any) => { const p = pointOf(r, L.measure); return { x: p.x / YD, carry: p.y / YD, landX: r.offline_m / YD, land: r.carry_m / YD }; }) };
    if (rs.length < 3) { rows.push(base); continue; }
    const sc = scoreSet(rs, L.target_m, L.mode, L.measure)!;
    const m = sc.metrics;
    rows.push({ ...base, outcomes: outcomesOf(rs, L), rating: m.rating, rd: m.rd, lo: m.ratingLo, hi: m.ratingHi, piQ: m.piQ, piB: m.piB, piS: m.piS, muXYd: m.muX / YD, muYYd: m.muY / YD, depthOffsetYd: m.depthOffset / YD,
      contours: sc.contours.map(c => ({ p: c.p, rx: c.ra / YD, ry: c.rb / YD, theta: c.thetaDeg, cx: c.cx / YD, cy: c.cy / YD, empirical: c.empirical })) });
  }
  // Ranked within each kind: accuracy for clubs with a known distance, consistency for the rest. The two never share a ranking.
  for (const mode of ['target', 'discovery']) {
    const scored = rows.filter(r => r.rating !== undefined && r.mode === mode);
    if (scored.length < 2) continue;
    const pr = E.practicePriority(scored.map(r => ({ id: String(r.id), player: cfg.player, D: r.targetYd * YD, rating: r.rating, rd: r.rd, domain: r.domain })), new Map());
    for (const p of pr) { const r = rows.find(x => String(x.id) === p.id); if (r) { r.tiedForLast = p.tiedForLast; r.rankFromBottom = pr.indexOf(p); } }
  }
  rows.sort((a, b) => clubRank(a.club) - clubRank(b.club) || b.targetYd - a.targetYd || a.shape.localeCompare(b.shape));
  return { session: sess, kind: sess.kind ?? '', sessions: sessions.map((s: any) => ({ id: s.id, started: s.started_utc })), rows };
}

/** Rating over time per label for the current player, filtered for drift when the data allow it. */
let historyMemo: { k: string; v: any } = { k: '', v: null };
function history() {
  if (!store) return { labels: [] };
  const c = store.all(`SELECT COUNT(*) AS n, COALESCE(SUM(excluded),0) AS x, COALESCE(MAX(id),0) AS m FROM shot`)[0];
  const k = `${c.n}|${c.x}|${c.m}|${cfg.player}|${Math.round(nowMs() / 3600000)}`;
  if (historyMemo.k === k) return historyMemo.v;
  historyMemo = { k, v: historyUncached() };
  return historyMemo.v;
}
function historyUncached() {
  if (!store) return { labels: [] };
  const pid = store.all(`SELECT id FROM player WHERE name=?`, cfg.player)[0]?.id;
  if (!pid) return { labels: [] };
  const labels = store.all(`SELECT * FROM label WHERE player_id=? AND mode='target'`, pid);
  const series: { L: any; obs: E.Obs[]; dates: string[]; pat: any[] }[] = [];
  for (const L of labels) {
    const sess = store.all(`SELECT s.id, s.started_utc FROM session s JOIN shot x ON x.session_id=s.id WHERE x.label_id=? GROUP BY s.id ORDER BY s.started_utc, s.id`, L.id);
    const obs: E.Obs[] = [], dates: string[] = [], pat: any[] = [];
    for (const s of sess) {
      const rs = store.all(`SELECT offline_m, carry_m, total_m, rest_offline_m FROM shot WHERE session_id=? AND label_id=? AND complete=1 AND excluded=0`, s.id, L.id);
      if (rs.length < 3) continue;
      const m = scoreSet(rs, L.target_m, 'target', L.measure)!.metrics;
      obs.push({ t: Date.parse(s.started_utc) / 86400000, rating: m.rating, rd: m.rd, n: rs.length });
      dates.push(s.started_utc);
      // Where the shots landed that session, in yards: center and spread, long/short and left/right.
      const ms = (v: number[]) => { const mu = v.reduce((a, b) => a + b, 0) / v.length; return { mu: mu / YD, sd: Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / (v.length - 1)) / YD }; };
      pat.push({ depth: ms(rs.map((r: any) => pointOf(r, L.measure).y - L.target_m)), offline: ms(rs.map((r: any) => pointOf(r, L.measure).x)), consistency: E.ratingFromPi(m.piS), piS: m.piS });
    }
    if (obs.length) series.push({ L, obs, dates, pat });
  }
  const fit = E.fitDrift(series.map(s => s.obs));
  const now = nowMs() / 86400000;
  const out = series.map(s => {
    const f = E.filterSeries(s.obs, fit, now);
    const tr = E.trend(s.obs);
    return { id: s.L.id, club: s.L.club, shape: s.L.shape, measure: s.L.measure, targetYd: s.L.target_m / YD, points: s.obs.map((o, i) => ({ date: s.dates[i], rating: o.rating, rd: o.rd, n: o.n, est: f.points[i].est, estRd: f.points[i].estRd, ...s.pat[i] })), now: f.now, nEffShots: f.nEffShots, totalShots: f.totalShots, staleness: f.staleness, filtered: f.filtered, trend: tr };
  }).sort((a, b) => clubRank(a.club) - clubRank(b.club) || b.targetYd - a.targetYd);
  return { labels: out, now: new Date(nowMs()).toISOString(), drift: { identified: fit.identified, perDay: fit.qTime } };
}

async function appApi(p: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (p === '/api/state') {
    const players = store ? store.all(`SELECT name, handed FROM player ORDER BY id`).map((r: any) => r.name) : [];
    if (!players.includes(cfg.player)) players.push(cfg.player);
    const step = cfg.plan.steps[cfg.plan.index];
    json(res, {
      demo: DEMO, scoreOn: cfg.scoreOn, fairwayYd: cfg.fairwayYd, player: cfg.player, handed: cfg.handed, players, bag: cfg.bag, onboarded: cfg.onboarded,
      lm: { connected: stats.liveConns > 0, seen: stats.msgsLM > 0, device: lastDevice },
      sim: { mode: stats.mode, upstream: stats.upstream, listening: stats.upstreamListening, check: stats.upstreamCheck },
      results: { files: dbWatches.length, rows: stats.dbRows + stats.dbUpdates, logs: tails.size },
      mapping: { set: !!(cfg.mapping.carry && cfg.mapping.offline), carry: cfg.mapping.carry ?? null, offline: cfg.mapping.offline ?? null },
      directionChecked: cfg.directionChecked, recording: cfg.recording, setup: cfg.setup,
      plan: { active: cfg.plan.active, index: cfg.plan.index, total: cfg.plan.steps.length, step: step ?? null },
      label: cfg.label, session: sessionId, store: !!store,
    });
    return true;
  }
  if (p === '/api/automap' && req.method === 'POST') {
    const r = autoMapping();
    if (!r.missing.length) { cfg.mapping = r.mapping; saveConfig(); }
    json(res, { ...r, applied: !r.missing.length });
    return true;
  }
  if (p === '/api/preview') { json(res, { preview: preview() }); return true; }
  if (p === '/api/direction' && req.method === 'POST') {
    const b = await body(req);
    const pv = preview();
    if (!pv || pv.offlineRawYd === null) { json(res, { ok: false, reason: 'No shot seen yet. Hit one ball first.' }); return true; }
    if (Math.abs(pv.offlineRawYd) < 2) { json(res, { ok: false, reason: 'That one finished almost on line. Hit one that clearly misses right, then tell us again.' }); return true; }
    const wentRight = b.went === 'right';
    const flip = wentRight ? pv.offlineRawYd < 0 : pv.offlineRawYd > 0;
    cfg.mapping.offline = { ...cfg.mapping.offline!, flip };
    cfg.directionChecked = true;
    saveConfig();
    json(res, { ok: true, flip });
    return true;
  }
  if (p === '/api/player' && req.method === 'POST') {
    const b = await body(req);
    const name = String(b.name ?? '').trim().slice(0, 40);
    if (!name) { json(res, { ok: false, reason: 'Enter a name.' }, 400); return true; }
    const from = cfg.bag.map(x => ({ club: x.club, clubClass: x.clubClass, stockYd: x.stockYd }));
    const isNew = !(name in cfg.bags) && name !== cfg.player;
    setPlayer(name, b.handed === 'L' ? 'L' : b.handed === 'R' ? 'R' : undefined);
    // Copied carries are only a starting guess: they are scored as unknown until this player's own shots measure them.
    if (isNew && b.copyBag && from.length) { cfg.bag = from; cfg.bags[name] = cfg.bag; saveConfig(); }
    if (store) playerId();
    json(res, { ok: true, player: cfg.player, bag: cfg.bag });
    return true;
  }
  if (p === '/api/setup' && req.method === 'POST') {
    const b = await body(req);
    const before = JSON.stringify(cfg.setup);
    cfg.setup = { ...cfg.setup, ...Object.fromEntries(Object.entries(b).filter(([k]) => ['sim', 'simVersion', 'conditions', 'deviceFw'].includes(k)).map(([k, v]) => [k, String(v).slice(0, 80)])) } as any;
    if (JSON.stringify(cfg.setup) !== before) sessionId = 0;
    saveConfig();
    json(res, { ok: true, setup: cfg.setup });
    return true;
  }
  if (p === '/api/bag' && req.method === 'POST') {
    const b = await body(req);
    const bag = (Array.isArray(b.bag) ? b.bag : []).map((x: any) => ({ club: String(x.club).trim().slice(0, 12), clubClass: String(x.clubClass || 'mid_iron'), stockYd: Math.round(Number(x.stockYd)) }))
      .filter((x: any) => x.club && x.stockYd > 0 && x.stockYd < 450);
    // A club keeps where it usually stops only while its carry is unchanged; a new carry makes that stale.
    for (const x of bag) { const old = cfg.bag.find(o => o.club === x.club); if (old && old.stockYd === x.stockYd) { if (old.totalYd) x.totalYd = old.totalYd; if (old.measured) x.measured = true; } }
    bag.sort((a: any, c: any) => clubRank(a.club) - clubRank(c.club));
    cfg.bag = bag; cfg.bags[cfg.player] = bag;
    saveConfig();
    json(res, { ok: true, bag });
    return true;
  }
  if (p === '/api/quit' && req.method === 'POST') {
    json(res, { ok: true });
    note('info', 'stopped from the Quit button');
    setTimeout(shutdown, 300);
    return true;
  }
  if (p === '/api/scoreon' && req.method === 'POST') {
    const b = await body(req);
    if (b.on) cfg.scoreOn = b.on === 'carry' ? 'carry' : 'finish';
    if (Number(b.fairwayYd) >= 10 && Number(b.fairwayYd) <= 80) cfg.fairwayYd = Math.round(Number(b.fairwayYd));
    saveConfig();
    json(res, { ok: true, scoreOn: cfg.scoreOn, fairwayYd: cfg.fairwayYd });
    return true;
  }
  if (p === '/api/onboarded' && req.method === 'POST') { cfg.onboarded = true; saveConfig(); json(res, { ok: true }); return true; }
  if (p === '/api/start' && req.method === 'POST') {
    const b = await body(req);
    const kind = String(b.kind ?? 'baseline');
    if (kind === 'free') {
      // Switching clubs in free practice: whatever was just hit teaches its club its distance first.
      if (sessionId) guard('learn distances', () => learnFromSession(sessionId));
      const club = cfg.bag.find(x => x.club === b.club) ?? cfg.bag[0];
      if (!club) { json(res, { ok: false, reason: 'Add clubs to your bag first.' }, 400); return true; }
      // A target you type on purpose (different from the bag number) is a real target; otherwise the bag number only
      // counts once it has been measured.
      const typed = Number(b.targetYd) > 0 && Math.round(Number(b.targetYd)) !== Math.round(targetFor(club));
      cfg.label = { club: club.club, clubClass: club.clubClass, shape: String(b.shape ?? 'stock'), domain: club.clubClass === 'driver' ? 'tee' : 'full', mode: club.measured || typed ? 'target' : 'discovery', targetYd: typed ? Number(b.targetYd) : targetFor(club), build: '', measure: cfg.scoreOn };
      cfg.plan = { steps: [], index: 0, active: false };
      cfg.recording = true;
      noteLabel(); saveConfig(); pushClubToLM();
      json(res, { ok: true });
      return true;
    }
    const steps = makePlan(kind, Math.max(1, Math.min(100, Math.round(Number(b.shots)) || (kind === 'discovery' ? 5 : kind === 'warmup' ? 3 : 10))), Array.isArray(b.clubs) ? b.clubs.map(String) : []);
    if (!steps.length) { json(res, { ok: false, reason: kind === 'ladder' ? 'Your bag has no wedges.' : 'Add clubs to your bag first.' }, 400); return true; }
    // A new plan is a new session (whatever was hit before teaches its clubs their distances first).
    if (sessionId) { const prev = sessionId; guard('learn distances', () => learnFromSession(prev)); sessionId = 0; }
    cfg.plan = { steps, index: 0, active: true };
    cfg.recording = true;
    if (store) { ensureSession(); try { store.run(`UPDATE session SET kind=? WHERE id=?`, kind, sessionId); } catch { /* older store */ } }
    saveConfig();
    applyStep();
    json(res, { ok: true, plan: cfg.plan });
    return true;
  }
  if (p === '/api/dev/clock' && req.method === 'POST' && DEMO_CLOCK) {
    const b = await body(req);
    clockShiftMs = Number(b.days ?? 0) * 86400000;
    json(res, { ok: true, now: new Date(nowMs()).toISOString() });
    return true;
  }
  if (p === '/api/stop' && req.method === 'POST') {
    // Ending a session closes it: the next shots start a new session, which is a new point in History.
    const ended = sessionId;
    cfg.plan.active = false; cfg.recording = false; saveConfig();
    guard('learn distances', () => learnFromSession(ended));
    emit({ kind: 'plan', done: true, ended });
    sessionId = 0;
    json(res, { ok: true, ended });
    return true;
  }
  if (p === '/api/shot/undo' && req.method === 'POST' && store) {
    const last = store.all(`SELECT id FROM shot WHERE session_id=? AND complete=1 AND excluded=0 ORDER BY id DESC LIMIT 1`, sessionId)[0];
    if (last) { store.run(`UPDATE shot SET excluded=1, exclude_why='undone' WHERE id=?`, last.id); emit({ kind: 'exclude', id: last.id, excluded: true, why: 'undone' }); }
    json(res, { ok: !!last, id: last?.id ?? null });
    return true;
  }
  if (p === '/api/results') {
    // scope: one session (default, or ?session=id), or every session started in [from, to) (ms; the page sends its own local day or week).
    const url = new URL(req.url ?? '/', 'http://x');
    const sessions = playerSessions();
    const summary = sessions.map((s: any) => { const c = store!.all(`SELECT l.club AS club, COUNT(*) AS n FROM shot x JOIN label l ON l.id=x.label_id WHERE x.session_id=? AND x.complete=1 AND x.excluded=0 GROUP BY l.club`, s.id); return { id: s.id, started: s.started_utc, clubs: c.map((r: any) => r.club), shots: c.reduce((a: number, r: any) => a + Number(r.n), 0) }; }).filter(s => s.shots > 0);
    const from = Number(url.searchParams.get('from')), to = Number(url.searchParams.get('to'));
    let sids: number[];
    if (Number.isFinite(from) && from > 0) sids = summary.filter(s => { const t0 = Date.parse(s.started); return t0 >= from && (!(to > 0) || t0 < to); }).map(s => s.id);
    else { const one = Number(url.searchParams.get('session')) || (summary.some(s => s.id === sessionId) ? sessionId : 0) || summary[0]?.id || 0; sids = one ? [one] : []; }
    json(res, { sessions: summary, results: resultsFor(sids) });
    return true;
  }
  if (p === '/api/data') {
    const pid = store ? store.all(`SELECT id FROM player WHERE name=?`, cfg.player)[0]?.id : null;
    const c = pid ? store!.all(`SELECT COUNT(DISTINCT s.id) AS sessions, COUNT(x.id) AS shots FROM session s LEFT JOIN shot x ON x.session_id=s.id WHERE s.player_id=?`, pid)[0] : { sessions: 0, shots: 0 };
    json(res, { player: cfg.player, sessions: Number(c.sessions), shots: Number(c.shots) });
    return true;
  }
  const delShot = p.match(/^\/api\/shot\/(\d+)\/delete$/);
  if (delShot && req.method === 'POST' && store) {
    // Gone for good from the scores. The raw bytes stay in the capture file, as always.
    store.run(`DELETE FROM shot WHERE id=?`, Number(delShot[1]));
    emit({ kind: 'exclude', id: Number(delShot[1]), deleted: true });
    json(res, { ok: true });
    return true;
  }
  const delSess = p.match(/^\/api\/session\/(\d+)\/delete$/);
  if (delSess && req.method === 'POST' && store) {
    const id = Number(delSess[1]);
    store.run(`DELETE FROM shot WHERE session_id=?`, id);
    store.run(`DELETE FROM session WHERE id=?`, id);
    if (id === sessionId) { sessionId = 0; cfg.plan.active = false; cfg.recording = false; saveConfig(); }
    emit({ kind: 'plan', deleted: id });
    json(res, { ok: true });
    return true;
  }
  if (p === '/api/player/reset' && req.method === 'POST' && store) {
    // Start this player over: every session and shot goes; labels with no shots left go too. Other players are untouched.
    const b = await body(req);
    const pid = store.all(`SELECT id FROM player WHERE name=?`, cfg.player)[0]?.id;
    if (pid) {
      store.run(`DELETE FROM shot WHERE session_id IN (SELECT id FROM session WHERE player_id=?)`, pid);
      store.run(`DELETE FROM session WHERE player_id=?`, pid);
      store.run(`DELETE FROM label WHERE player_id=? AND id NOT IN (SELECT DISTINCT label_id FROM shot)`, pid);
    }
    sessionId = 0; cfg.plan = { steps: [], index: 0, active: false }; cfg.recording = false;
    if (b.bag) for (const x of cfg.bag) { delete x.totalYd; delete x.measured; }
    cfg.bags[cfg.player] = cfg.bag; saveConfig();
    historyMemo = { k: '', v: null };
    note('info', `reset: removed every session and shot for ${cfg.player}${b.bag ? ', and the measured bag numbers' : ''}`);
    emit({ kind: 'plan', reset: true });
    json(res, { ok: true });
    return true;
  }
  if (p === '/api/history') { json(res, history()); return true; }
  if (p === '/api/version') {
    let latest: string | null = null, err = '';
    try { latest = String((await latestRelease())?.tag_name ?? '') || null; } catch (e: any) { err = e.message; }
    json(res, { current: `v${APP_VERSION}`, latest, updateAvailable: !DEMO && !!latest && newer(latest, APP_VERSION), compiled: COMPILED, error: err });
    return true;
  }
  if (p === '/api/update' && req.method === 'POST') {
    try { json(res, await selfUpdate()); } catch (e: any) { json(res, { ok: false, reason: e.message }); }
    return true;
  }
  if (p.startsWith('/fonts/')) {
    const f = FONTS[p.slice(7)];
    if (!f) { res.writeHead(404); res.end(); return true; }
    res.writeHead(200, { 'Content-Type': f.mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.end(Buffer.from(f.b64, 'base64'));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- updates from GitHub releases

function semver(v: string): number[] { return String(v).replace(/^v/, '').split(/[.-]/).slice(0, 3).map(x => Number(x) || 0); }
function newer(a: string, b: string): boolean { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; }

const ASSET = process.platform === 'win32' ? 'golf-tap.exe' : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'golf-tap-macos-arm64' : 'golf-tap-macos-x64') : 'golf-tap-linux-x64';
let latestCache: { at: number; rel: any } | null = null;

async function latestRelease(): Promise<any | null> {
  if (latestCache && Date.now() - latestCache.at < 10 * 60 * 1000) return latestCache.rel;
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': 'golf-tap-updater', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  const rel = await r.json();
  latestCache = { at: Date.now(), rel };
  return rel;
}

/** An app window (Edge or Chrome with --app) has no tabs or address bar, so it reads as a program; F11 or the app's button makes it full screen. */
function appWindowBrowser(): string | null {
  const env = process.env;
  const c = IS_WIN
    ? [`${env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`, `${env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`, `${env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`, `${env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`, `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`]
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] : [];
  return c.find(p => { try { return !p.includes('undefined') && fs.existsSync(p); } catch { return false; } }) ?? null;
}
function openBrowser(url: string) {
  try {
    const app = flag('browser-tab') ? null : appWindowBrowser();
    if (app) { spawn(app, [`--app=${url}`, '--window-size=1440,900'], { detached: true, stdio: 'ignore' }).on('error', () => { /* fall through below next time */ }).unref(); return; }
    if (IS_WIN) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).on('error', () => { /* no desktop */ }).unref();
  } catch { /* the console prints the address anyway */ }
}

/** The previous exe is renamed during an update; remove it once the new one is running. */
function cleanupAfterUpdate() {
  if (!COMPILED) return;
  const old = process.execPath.replace(/(\.exe)?$/i, '.old$1');
  for (let i = 0; i < 10; i++) { try { if (fs.existsSync(old)) fs.unlinkSync(old); break; } catch { /* still locked for a moment */ } }
}

/**
 * Download the latest release's executable, check its SHA-256 against the
 * published checksum, swap it in place of this one and restart. Shots, config
 * and captures live beside the exe and are not touched.
 */
async function selfUpdate(): Promise<{ ok: boolean; reason?: string; version?: string }> {
  if (!COMPILED) return { ok: false, reason: 'Running from source: update with "git pull" in the golf-tap folder, then restart.' };
  const rel = await latestRelease();
  const tag = String(rel?.tag_name ?? '');
  if (!newer(tag, APP_VERSION)) return { ok: false, reason: `Already on the newest version (${APP_VERSION}).` };
  const asset = (rel.assets ?? []).find((a: any) => a.name === ASSET);
  const sum = (rel.assets ?? []).find((a: any) => a.name === `${ASSET}.sha256`);
  if (!asset || !sum) return { ok: false, reason: `Release ${tag} has no ${ASSET} with a checksum.` };
  const exe = process.execPath;
  const fresh = exe.replace(/(\.exe)?$/i, '.new$1');
  const old = exe.replace(/(\.exe)?$/i, '.old$1');
  note('info', `updating to ${tag}: downloading ${asset.name} (${Math.round(asset.size / 1e6)} MB)`);
  const bin = Buffer.from(await (await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'golf-tap-updater' }, redirect: 'follow' })).arrayBuffer());
  const want = (await (await fetch(sum.browser_download_url, { headers: { 'User-Agent': 'golf-tap-updater' }, redirect: 'follow' })).text()).trim().split(/\s+/)[0].toLowerCase();
  const { createHash } = await import('node:crypto');
  const got = createHash('sha256').update(bin).digest('hex');
  if (got !== want) return { ok: false, reason: `Download did not match its checksum; nothing was changed.` };
  fs.writeFileSync(fresh, bin, { mode: 0o755 });
  try { if (fs.existsSync(old)) fs.unlinkSync(old); } catch { /* */ }
  fs.renameSync(exe, old);       // allowed on Windows even while running
  fs.renameSync(fresh, exe);
  note('info', `installed ${tag}; restarting`);
  setTimeout(() => {
    try { logStream.end(); store?.close(); } catch { /* */ }
    const child = spawn(exe, process.argv.slice(2), { cwd: DATA_DIR, detached: true, stdio: 'ignore', env: { ...process.env, GOLF_TAP_RESTARTED: '1' } });
    child.unref();
    process.exit(0);
  }, 400);
  return { ok: true, version: tag };
}

// ---------------------------------------------------------------- the built-in demo

let demoMonitor: Demo.DemoMonitor | null = null;
const demoJob = { running: false, what: '', done: 0, total: 0, error: '' };
let demoChild: ReturnType<typeof spawn> | null = null;
const DEMO_UI_PORT = 8090;

async function startDemoWorld() {
  const sql = await openSql(path.join(DEMO_GSPRO_DIR, 'GSPro.db'), false).catch(async () => { fs.mkdirSync(DEMO_GSPRO_DIR, { recursive: true }); return openSql(path.join(DEMO_GSPRO_DIR, 'GSPro.db'), false); });
  await new Promise<void>((res) => Demo.startFakeGspro(UP_PORT, DEMO_GSPRO_DIR, sql, () => res(), { metric: flag('demo-metric') }));
  demoMonitor = new Demo.DemoMonitor(LISTEN_PORT);
  note('info', 'demo: pretend GSPro and launch monitor are running; nothing real is touched');
}

/** Waits until the app has filed one more complete shot, or gives up after a few seconds. */
async function untilShotSaved(before: number, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (stats.shotsSaved > before) return true; await new Promise(r => setTimeout(r, 60)); }
  return false;
}

/** The club the screen is asking for right now, and how hard to swing it. */
function demoSwing(): { club: string; partial: number } {
  const st = cfg.plan.active ? cfg.plan.steps[cfg.plan.index] : null;
  const club = st ? st.club : cfg.label.club;
  const partial = st && st.domain === 'partial' ? st.targetYd / Demo.prof(club).trueYd : 1;
  return { club, partial };
}

async function demoHit(n: number, push: boolean) {
  for (let i = 0; i < n; i++) {
    const before = stats.shotsSaved, sw = demoSwing();
    await demoMonitor!.send(demoMonitor!.golfer.shot(sw.club, { push, partial: sw.partial }));
    await untilShotSaved(before);
    demoJob.done++;
    if (i < n - 1) await new Promise(r => setTimeout(r, 450));
  }
}

/** Weeks of earlier practice, dated in the past, so History has something to show. The golfer gets steadier over time. */
async function demoWeeks() {
  const keep = { label: { ...cfg.label }, plan: cfg.plan, recording: cfg.recording };
  const clubs = ['7i', 'PW', 'Driver'].map(c => cfg.bag.find(b => b.club.toLowerCase() === c.toLowerCase())).filter(Boolean).slice(0, 3) as any[];
  if (!clubs.length && cfg.bag[0]) clubs.push(cfg.bag[0]);
  const days = [-44, -40, -33, -29, -22, -15, -11, -6, -2];
  demoJob.total = clubs.length * days.length * 8; demoJob.done = 0;
  sessionId = 0;
  for (let si = 0; si < days.length; si++) {
    clockShiftMs = days[si] * 86400000 + (si % 3) * 3600000;
    const spread = 1.45 - 0.6 * (si / (days.length - 1)) + 0.12 * Math.sin(si * 2.1);
    for (const c of clubs) {
      cfg.label = { club: c.club, clubClass: c.clubClass, shape: 'stock', domain: c.clubClass === 'driver' ? 'tee' : 'full', mode: 'target', targetYd: targetFor(c), build: '', measure: cfg.scoreOn };
      cfg.plan = { steps: [], index: 0, active: false }; cfg.recording = true;
      noteLabel();
      await new Promise(r => setTimeout(r, 30));
      for (let i = 0; i < 8; i++) {
        const before = stats.shotsSaved;
        await demoMonitor!.send(demoMonitor!.golfer.shot(c.club, { spread }));
        await untilShotSaved(before);
        demoJob.done++;
      }
    }
    sessionId = 0;
  }
  clockShiftMs = 0;
  cfg.label = keep.label; cfg.plan = { ...keep.plan, active: false }; cfg.recording = false;
  noteLabel(); saveConfig();
  emit({ kind: 'plan', done: true });
}

async function demoApi(p: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (p === '/api/demo/start' && req.method === 'POST' && !DEMO) {
    // A second copy of this program, in demo mode, on its own ports and folder. Real data is never touched.
    const up = await fetch(`http://127.0.0.1:${DEMO_UI_PORT}/api/state`).then(r => r.ok).catch(() => false);
    if (!up) {
      const self = process.argv[1] ?? '';
      const args = !COMPILED && /\.(ts|js|mjs)$/i.test(self) ? [...process.execArgv, self, '--demo', '--no-browser'] : ['--demo', '--no-browser'];
      demoChild = spawn(process.execPath, args, { cwd: BASE_DIR, stdio: 'ignore', windowsHide: true });
      const t0 = Date.now();
      while (Date.now() - t0 < 15000) { if (await fetch(`http://127.0.0.1:${DEMO_UI_PORT}/api/state`).then(r => r.ok).catch(() => false)) break; await new Promise(r => setTimeout(r, 200)); }
    }
    json(res, { ok: true, url: `http://localhost:${DEMO_UI_PORT}/` });
    return true;
  }
  if (!DEMO || !p.startsWith('/api/demo/')) return false;
  if (p === '/api/demo/status') { json(res, demoJob); return true; }
  if (req.method !== 'POST') return false;
  if (demoJob.running) { json(res, { ok: false, reason: 'Still busy with the last request.' }, 409); return true; }
  const b = await body(req);
  const job = p === '/api/demo/hit' ? () => demoHit(Math.max(1, Math.min(50, Number(b.n) || 1)), !!b.push) : p === '/api/demo/weeks' ? demoWeeks : p === '/api/demo/hello' ? async () => { await demoMonitor!.connect(); } : null;
  if (!job) return false;
  Object.assign(demoJob, { running: true, what: p.split('/').pop(), done: 0, total: p === '/api/demo/hit' ? Math.max(1, Math.min(50, Number(b.n) || 1)) : 0, error: '' });
  job().catch((e: any) => { demoJob.error = e.message; }).finally(() => { demoJob.running = false; emit({ kind: 'demo', ...demoJob }); });
  json(res, { ok: true });
  return true;
}

// ---------------------------------------------------------------- boot

// ---------------------------------------------------------------- one copy, tied to its window
// The program and its window are separate: closing the window used to leave the program running and holding
// its ports, so the next click found them taken. Now the program stops on its own once its last window has
// been closed for a while (long enough to survive a page reload), and a second click just opens the window.
let everWindow = false, lastWindowGone = 0;
const EXIT_WITH_WINDOW = (COMPILED || flag('exit-with-window')) && !flag('keep-running');
function watchWindows() {
  setInterval(() => {
    if (!EXIT_WITH_WINDOW || !everWindow || sse.size || !lastWindowGone) return;
    if (Date.now() - lastWindowGone > 20000) { note('info', 'the Pattern window was closed; stopping'); shutdown(); }
  }, 2000);
}
/** If golf-tap is already running on this computer, open its window and leave. */
async function handOffToRunningCopy(): Promise<boolean> {
  if (process.env.GOLF_TAP_RESTARTED) return false;
  const v = await fetch(`http://127.0.0.1:${UI_PORT}/api/version`, { signal: AbortSignal.timeout(1200) }).then(r => r.json()).catch(() => null);
  if (!v || !v.current) return false;
  console.log(`\n  golf-tap ${v.current} is already running. Opening its window: http://localhost:${UI_PORT}\n`);
  if (!flag('no-browser')) openBrowser(`http://localhost:${UI_PORT}`);
  return true;
}

async function main() {
  cleanupAfterUpdate();
  if (!DEMO && await handOffToRunningCopy()) { setTimeout(() => process.exit(0), 1500); return; }
  watchWindows();
  if (DEMO) await startDemoWorld();
  if (!DB_ONLY) startProxy();
  await new Promise<void>((res) => listenRetry(ui, UI_PORT, UI_HOST, 'page', () => res()));
  if (COMPILED && !process.env.GOLF_TAP_RESTARTED && !flag('no-browser')) openBrowser(`http://localhost:${UI_PORT}`);
  // After an update the old window reloads itself onto the new version; if it was closed, open a new one.
  if (COMPILED && process.env.GOLF_TAP_RESTARTED && !flag('no-browser')) setTimeout(() => { if (!sse.size) openBrowser(`http://localhost:${UI_PORT}`); }, 10000);
  const bar = '─'.repeat(64);
  console.log(`\n${bar}\n  SQE Wire Tap   ${VERSION}\n${bar}`);
  if (DB_ONLY) console.log(`  mode         db-only: no TCP, watching GSPro files only`);
  else {
    console.log(`  listening    :${LISTEN_PORT}   ${INLINE ? '(inline: GSPro API must be on 922)' : '(point the launch monitor connector here)'}`);
    console.log(`  forwarding   ${NO_UP ? 'nothing (capture only)' : `${UP_HOST}:${UP_PORT}`}`);
  }
  console.log(`  open         http://localhost:${UI_PORT}`);
  if (UI_HOST !== '127.0.0.1') for (const u of lanUrls()) console.log(`               ${u}`);
  console.log(`  capture      ${LOG_PATH}`);
  console.log(`${bar}\n  Press "probe" in the page to test the pipe before anyone swings.\n  Ctrl-C to stop. Nothing you do here can change GSPro's files.\n`);
  emit({ kind: 'note', level: 'info', msg: 'started', stats });
  await openStore();
  noteLabel();
  await rescanFiles();
  if (!dbWatches.length) note('warn', `No GSPro data files found yet. Searched: ${gsproRoots().join(', ') || '(no GSPro folders)'}. Use --gsprodb <path> or --watch <dir>.`);
  setInterval(() => { pollDbs().catch(e => note('error', `db poll: ${e.message}`)); }, POLL_MS);
  setInterval(() => guard('tail', pollTails), 500);
  setInterval(() => { rescanFiles().catch(() => { /* */ }); }, 30000);
  const health = () => checkUpstream().catch(e => note('warn', `health check: ${e.message}`));
  health();
  setInterval(health, 15000);
}

function shutdown() {
  try { demoChild?.kill(); } catch { /* */ }
  try { fs.writeFileSync(SCHEMA_PATH, JSON.stringify(schemaDump(), null, 2)); } catch { /* */ }
  console.log(`\n  ${seq} events -> ${LOG_PATH}\n  ${schema.size} fields -> ${SCHEMA_PATH}\n  ${stats.shotsSaved} shots saved\n`);
  try { logStream.end(); } catch { /* */ }
  try { store?.close(); } catch { /* */ }
  for (const w of dbWatches) { try { w.sql?.close(); } catch { /* */ } }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => { console.error(`  uncaught (relay unaffected): ${e?.stack ?? e}`); });
process.on('unhandledRejection', (e: any) => { console.error(`  unhandled (relay unaffected): ${e?.stack ?? e}`); });

main().catch((e) => { console.error(e); process.exit(1); });
