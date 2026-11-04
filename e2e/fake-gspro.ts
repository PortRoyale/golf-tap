/** Stand-alone pretend GSPro for the e2e run: node fake-gspro.ts <port> <dir>. The logic lives in demo.ts. */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFakeGspro } from '../demo.ts';
const PORT = Number(process.argv[2] || 9921), DIR = process.argv[3];
fs.mkdirSync(DIR, { recursive: true });
const file = path.join(DIR, 'GSPro.db');
try { fs.unlinkSync(file); } catch { /* */ }
const db = new DatabaseSync(file);
startFakeGspro(PORT, DIR, { run: (q, ...p) => db.prepare(q).run(...p), exec: (q) => db.exec(q) }, () => console.log(`fake GSPro on ${PORT}, db ${file}${process.env.METRIC ? ' (metric)' : ''}`), { metric: !!process.env.METRIC });
