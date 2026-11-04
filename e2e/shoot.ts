/**
 * Walks the app from first launch to the end like a new user, screenshotting every screen,
 * checks that no screen ever scrolls (at three window sizes and on a phone), then checks the
 * shot database for misfiled shots.
 *   node --no-warnings e2e/shoot.ts <outDir> <consoleFile> <sqeDbPath>
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const [OUT, CONSOLE, DB] = [process.argv[2], process.argv[3], process.argv[4]];
fs.mkdirSync(OUT, { recursive: true });
const UI = 'http://127.0.0.1:8080';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const api = async (p: string) => (await fetch(UI + p)).json();
const postApi = async (p: string, b: any = {}) => (await fetch(UI + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
const log = (s: string) => console.log(`[shoot] ${s}`);
async function until(what: string, f: () => Promise<boolean>, ms = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await f()) return; await sleep(300); }
  throw new Error(`timed out waiting for ${what}`);
}
function connector(mode: string, arg = '', env: Record<string, string> = {}) {
  const ch = spawn(process.execPath, ['--no-warnings', path.resolve('e2e/connector.ts'), '9211', '8080', mode, arg], { env: { ...process.env, ...env }, stdio: 'inherit' });
  return new Promise<void>(r => ch.on('close', () => r()));
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
const page = await ctx.newPage();
page.on('pageerror', (e: any) => log('PAGE ERROR ' + e.message));
page.on('dialog', (d: any) => { log('DIALOG ' + d.message()); d.dismiss(); });

// No screen may scroll: the document must fit the window, and nothing inside the view may run past it.
const scrollProblems: string[] = [];
async function noScroll(p: any, name: string) {
  const r = await p.evaluate(() => {
    const de = document.documentElement, H = window.innerHeight, W = window.innerWidth;
    const out: string[] = [];
    if (de.scrollHeight > H + 1) out.push(`page is ${de.scrollHeight}px tall in a ${H}px window`);
    if (de.scrollWidth > W + 1) out.push(`page is ${de.scrollWidth}px wide in a ${W}px window`);
    const v = document.querySelector('main');
    if (v) {
      const vb = v.getBoundingClientRect();
      for (const el of Array.from(v.querySelectorAll('*')) as HTMLElement[]) {
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || el.closest('[data-tab-hidden="1"]')) continue;
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        if (b.bottom > vb.bottom + 1.5 || b.right > vb.right + 1.5) { out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className).split(' ')[0]} ends at ${Math.round(b.bottom)}x${Math.round(b.right)}, view ends ${Math.round(vb.bottom)}x${Math.round(vb.right)}`); if (out.length > 4) break; }
      }
    }
    return out;
  });
  if (r.length) { scrollProblems.push(`${name}: ${r.join('; ')}`); log(`SCROLL ${name}: ${r.join('; ')}`); }
}
let n = 0;
const shot = async (name: string) => { await noScroll(page, name); const f = path.join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`); await page.screenshot({ path: f }); log(f); };
const settle = (ms = 900) => sleep(ms);

// Terminal on launch.
const term = fs.readFileSync(CONSOLE, 'utf8').split('\n').slice(0, 16).join('\n').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
await page.setContent(`<html><body style="margin:0;background:#0c0c0c"><div style="margin:24px;border:1px solid #333;border-radius:8px;overflow:hidden;width:1160px"><div style="background:#1f1f1f;color:#bbb;font:13px system-ui;padding:8px 12px">Terminal (demo run in a Linux workspace; on Windows this is the golf-tap.exe window)</div><pre style="margin:0;padding:16px;color:#d8d8d8;font:14px/1.5 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all">$ golf-tap\n${term}</pre></div></body></html>`);
await page.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-terminal-on-launch.png`) });

// 1. First launch: setup, nothing connected yet.
await page.goto(UI);
await settle(1500);
await shot('setup-1-connect-waiting');
await connector('hello');
await settle(2200);
await shot('setup-1-connect-ready');
await page.click('#next');
await settle();
await shot('setup-2-test-shot-waiting');

// 2. Test shot.
await connector('one');
await until('test shot readout', async () => (await page.$('.readout')) !== null, 30000);
await settle(600);
await shot('setup-2-test-shot-readout');
await page.click('#next');
await settle();

// 3. Direction.
await shot('setup-3-direction-waiting');
await connector('one', 'right');
await until('direction buttons', async () => (await page.$('[data-went]')) !== null, 30000);
await settle(500);
await shot('setup-3-direction-ask');
await page.click('[data-went="right"]');
await settle(600);
await shot('setup-3-direction-done');
await page.click('#next');
await settle();

// 4. You.
await page.fill('#pname', 'Tyler');
await page.fill('#sver', '3.49.11.13 (demo)');
await page.fill('#sfw', '4.50 (demo)');
await shot('setup-4-you');
await page.click('#next');
await settle();

// 5. Bag: guesses, deliberately a bit off from the golfer's real numbers.
await shot('setup-5-bag-empty');
const guess: Record<string, number> = { Driver: 265, '5i': 185, '7i': 160, '9i': 135, PW: 120, GW: 100, SW: 85, LW: 70 };
for (const c of Object.keys(guess)) await page.click(`.chip[data-club="${c}"]`);
for (const [c, y] of Object.entries(guess)) await page.fill(`[data-yd="${c}"]`, String(y));
await page.dispatchEvent('[data-yd="LW"]', 'input');
await settle(400);
await shot('setup-5-bag-filled');
await page.click('#savebag');
await settle();

// 6. Pick a session.
await shot('setup-6-pick-session');
await page.click('[data-kind="discovery"]');
await settle(1500);
await shot('practice-discovery-start-ball-on-tee');

// Discovery: 5 shots per club. Pause partway through the 7 iron for a look.
await connector('plan', '', { UNTIL: '7i:3' });
await settle(9000);
await shot('practice-discovery-7i-range');
await page.click('#vsel [data-v="above"]');
await settle(500);
await shot('practice-discovery-7i-from-above');
await page.click('#vsel [data-v="range"]');
await connector('plan');
await until('discovery finished', async () => !(await api('/api/state')).plan.active);
await page.goto(UI + '/#/results');
await settle(1500);
await shot('results-your-numbers');

// Bag check, measured against the numbers just learned.
await page.goto(UI + '/#/practice');
await settle(1200);
await shot('practice-ready-chooser');
await page.click('[data-kind="baseline"]');
await settle(1000);
await connector('plan', '', { UNTIL: '7i:8' });
await settle(9000);
await shot('practice-bag-check-7i-range');
// The flight itself: freeze the animation partway through the next shot.
await page.evaluate(() => { (window as any).PATTERN_FREEZE_AT = 0.32; });
await connector('plan', '', { UNTIL: '7i:9' });
await settle(2500);
await shot('practice-bag-check-7i-ball-rising');
await page.evaluate(() => { (window as any).PATTERN_FREEZE_AT = 0.62; (window as any).RANGE.draw(); });
await settle(300);
await shot('practice-bag-check-7i-ball-coming-down');
await page.evaluate(() => { (window as any).PATTERN_FREEZE_AT = undefined; (window as any).RANGE.anim = null; (window as any).RANGE.cam = 1; (window as any).RANGE.draw(); });
await connector('plan', '', { UNTIL: '5i:9' });
await settle(9000);
await shot('practice-bag-check-5i-weak');
await page.click('#listbtn');
await settle(400);
await shot('practice-shot-list');
await page.keyboard.press('Escape');
await connector('plan');
await until('bag check finished', async () => !(await api('/api/state')).plan.active);
await page.goto(UI + '/#/results');
await settle(1800);
await shot('results-bag-check');

// A second session on the weakest club.
const drill = await page.$('#drill');
if (drill) { await drill.click(); await settle(1000); }
await connector('label', '12');
await settle(9000);
await page.goto(UI + '/#/practice');
await settle(1500);
await shot('practice-drill-weakest');
// The drawn flight must leave on the launch monitor's start line and land exactly where GSPro said.
{
  const sv = await api('/api/session');
  let worst = 0, worstLand = 0, k = 0;
  for (const sh of sv.shots) {
    const fl = sh.flight; if (!fl) continue;
    const q = fl.path.find((r: number[]) => r[0] >= 3) ?? fl.path[2], end = fl.path[fl.path.length - 1];
    worst = Math.max(worst, Math.abs(Math.atan2(q[1], q[0]) * 180 / Math.PI - fl.launch.startLine));
    worstLand = Math.max(worstLand, Math.hypot(end[0] - sh.carryYd, end[1] - sh.offlineYd)); k++;
  }
  log(`flight check: ${k} shots, worst start-line error ${worst.toFixed(2)} deg, worst landing error ${worstLand.toFixed(2)} yd`);
  if (!k || worst > 0.2 || worstLand > 0.05) scrollProblems.push('drawn flight does not match the launch monitor and GSPro');
}
await page.click('#end');
await settle(1500);

// Earlier weeks of 7 iron practice, dated in the past (demo clock), so History has real gaps to draw.
// The golfer is looser early on and steadier later.
const days = [-44, -40, -33, -29, -22, -15, -11, -6, -2];
for (let i = 0; i < days.length; i++) {
  await postApi('/api/dev/clock', { days: days[i] });
  await postApi('/api/start', { kind: 'free', club: '7i' });
  await connector('label', '8', { SPREAD: String(1.45 - 0.6 * (i / (days.length - 1)) + 0.12 * Math.sin(i * 2.1)), PACE: '500', SEED: String(100 + i) });
  await postApi('/api/stop');
}
await postApi('/api/dev/clock', { days: 0 });
await page.goto(UI + '/#/history');
await settle(1800);
await shot('history-7i-score-terrain');
await page.click('#axsel [data-a="offline"]');
await settle(800);
await shot('history-7i-left-right');
await page.goto(UI + '/#/bag');
await settle(1200);
await shot('bag-after-measuring');
await page.goto(UI + '/debug');
await settle(1500);
await page.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-debug-page.png`) });
const dbgScroll = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 1);
if (dbgScroll) scrollProblems.push('debug page scrolls');

// The built-in demo, started from the app like a user would.
await page.goto(UI + '/#/practice');
await settle(800);
const dr = await postApi('/api/demo/start');
const demo = await ctx.newPage();
await demo.goto(dr.url.replace('localhost', '127.0.0.1'));
await sleep(1500);
await demo.click('[data-demo="hello"]');
await sleep(1500);
await noScroll(demo, 'demo-first-launch');
await demo.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-demo-first-launch.png`) });
await demo.close();

// Every screen at other window sizes: a 1366x768 laptop, a 1080p screen, a phone.
const screens = ['#/practice', '#/results', '#/history', '#/bag', '#/setup/1', '#/setup/5', '#/setup/6'];
for (const [w, h, tag, mobile] of [[1366, 768, 'laptop', false], [1920, 1080, '1080p', false], [390, 844, 'phone', true]] as const) {
  const c2 = await browser.newContext(mobile ? { viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const p2 = await c2.newPage();
  for (const s of screens) {
    await p2.goto(UI + '/' + s);
    await sleep(1300);
    await noScroll(p2, `${tag} ${s}`);
    if (tag !== '1080p' || s === '#/practice') await p2.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-${tag}-${s.replace(/[#/]+/g, '-').replace(/^-|-$/g, '')}.png`) });
  }
  await c2.close();
}
await browser.close();

// Integrity: every shot must be filed under the club the launch monitor said was hit.
const db = new DatabaseSync(DB, { readOnly: true });
const CODE: Record<string, string> = { DRIVER: 'DR', '5I': 'I5', '7I': 'I7', '9I': 'I9', PW: 'PW', GW: 'GW', SW: 'SW', LW: 'LW' };
let total = 0, wrong = 0;
for (const r of db.prepare(`SELECT s.raw_json, l.club FROM shot s JOIN label l ON l.id=s.label_id WHERE s.complete=1`).all() as any[]) {
  const sent = JSON.parse(r.raw_json)?.LM?.data?.Club;
  if (!sent) continue;
  total++;
  if (CODE[String(r.club).toUpperCase()] !== sent) wrong++;
}
log(`integrity: ${total} shots checked, ${wrong} filed under the wrong club`);
log(`no-scroll: ${scrollProblems.length ? scrollProblems.length + ' problems' : 'every screen fits'}`);
for (const s of scrollProblems) log('  ' + s);
log('done');
if (wrong || scrollProblems.length) process.exitCode = 1;
