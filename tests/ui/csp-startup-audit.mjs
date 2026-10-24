// Self-contained browser check of Halion's actual CSP/sandbox and normal saves.
// PLAYWRIGHT_MODULE / CHROMIUM_PATH select existing installs; no new dependency.
// RELEASE_DIR adds a built release; RELEASE_ENTRY defaults to vibehub/index.html.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const out = resolve(process.env.AUDIT_OUT || resolve(repo, 'build/csp-startup-audit'));
const CSP = "sandbox allow-scripts allow-pointer-lock allow-downloads; default-src 'self' data: blob: https: http:; connect-src 'self' https:; object-src 'none'; base-uri 'none'; form-action 'none'";
const targets = [{ name: 'source', root: repo, entry: 'web/index.html', release: false }];
if (process.env.RELEASE_DIR) targets.push({ name: 'release', root: resolve(process.env.RELEASE_DIR), entry: process.env.RELEASE_ENTRY || 'vibehub/index.html', release: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.txt': 'text/plain' };
const requests = [];
await mkdir(out, { recursive: true });

// Only this process's temporary loopback server is started and stopped.
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (u.pathname === '/__frame') {
      const entry = u.searchParams.get('entry');
      if (!entry?.startsWith('/strict/')) { res.writeHead(400).end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/__frame.css"><iframe id="game" title="游戏" src="' + entry.replaceAll('&', '&amp;').replaceAll('"', '&quot;') + '" sandbox="allow-scripts allow-pointer-lock allow-downloads" allow="fullscreen; autoplay" referrerpolicy="no-referrer"></iframe>');
      return;
    }
    if (u.pathname === '/__frame.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('html,body{margin:0;width:100%;height:100%;background:#000}iframe{display:block;border:0;width:100%;height:100%}');
      return;
    }
    const match = /^\/(strict|plain)\/([^/]+)\/(.*)$/.exec(decodeURIComponent(u.pathname));
    const target = match && targets.find(t => t.name === match[2]);
    if (!target) { res.writeHead(404).end(); return; }
    const file = resolve(target.root, match[3]);
    if (!file.startsWith(target.root + sep) || match[3].split('/').some(s => s.startsWith('.'))) { res.writeHead(403).end(); return; }
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'Content-Type': mime[extname(file)] || 'application/octet-stream' };
    if (match[1] === 'strict') headers['Content-Security-Policy'] = CSP;
    try {
      if (!(await stat(file)).isFile()) throw new Error('not a file');
      const body = await readFile(file);
      requests.push({ path: u.pathname, status: 200, type: headers['Content-Type'] });
      res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : body);
    } catch {
      requests.push({ path: u.pathname, status: 404 });
      res.writeHead(404, headers).end('not found');
    }
  } catch { res.writeHead(500).end('server error'); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const results = [];

async function finishLine(frame) {
  // Check/skip atomically: natural typing may end before a separate click.
  await frame.locator('#textbox').evaluate(box => {
    if (!document.querySelector('#next-indicator').classList.contains('show')) box.click();
  });
  await frame.locator('#next-indicator.show').waitFor();
}
async function nextLine(frame) {
  await finishLine(frame);
  const before = await frame.locator('#text').innerText();
  await frame.locator('#textbox').click();
  await frame.waitForFunction(old => {
    const text = document.querySelector('#text').textContent;
    return text.length > 0 && text !== old;
  }, before);
}
async function inspectMap(frame, target) {
  const data = await frame.evaluate(() => {
    const inert = document.querySelector('#release-assets');
    return {
      map: inert ? JSON.parse(inert.textContent) : {},
      inertType: inert?.type,
      importmaps: document.querySelectorAll('script[type="importmap"]').length,
      inlineExecutable: [...document.scripts].filter(s => !s.src && (!s.type || s.type === 'module' || /(?:java|ecma)script/i.test(s.type))).length,
    };
  });
  assert.equal(data.importmaps, 0, 'no inline importmap required');
  assert.equal(data.inlineExecutable, 0, 'all executable code is external');
  if (target.release) {
    assert.equal(data.inertType, 'application/json');
    for (const key of ['story.json', 'character-portraits.json', 'assets/bg/church_nave.webp', 'assets/char-redrawn/claude/tea.webp']) {
      assert.match(data.map[key] || '', /\.[a-f0-9]{16}\.[^.]+$/, `${key} has a hashed release target`);
    }
    assert.ok(Object.values(data.map).every(v => typeof v === 'string'), 'flat logical-name map');
  }
  const jsonChecks = await frame.evaluate(async map => {
    const results = [];
    for (const logical of ['story.json', 'character-portraits.json']) {
      const response = await fetch(map[logical] || logical);
      const value = await response.json();
      results.push({ logical, status: response.status, type: response.headers.get('content-type'), object: !!value && typeof value === 'object' });
    }
    return results;
  }, data.map);
  for (const json of jsonChecks) { assert.equal(json.status, 200); assert.match(json.type, /json/); assert.ok(json.object); }
  return { ...data, jsonChecks };
}
async function check(target, strict) {
  const name = `${target.name}-${strict ? 'strict-sandbox' : 'normal-save-load'}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (!strict) await context.addInitScript(() => {
    for (const key of ['saveclaude:auto', 'saveclaude:slot0', 'saveclaude:1.0.0:auto', 'saveclaude:v1.0.0:slot5']) localStorage.setItem(key, 'old');
    localStorage.setItem('saveclaude:1.1.0:slot5', 'current-marker');
    localStorage.setItem('saveclaude:audio', JSON.stringify({ musicOn: false, musicVolume: .21 }));
    localStorage.setItem('unrelated-app-key', 'keep');
  });
  const page = await context.newPage(), errors = [], policyErrors = [], responses = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => {
    if (/Content Security Policy|violat.*directive|Failed to resolve module specifier/i.test(message.text())) policyErrors.push(message.text());
  });
  page.on('response', response => responses.push({ url: response.url(), status: response.status(), type: response.headers()['content-type'] || '', csp: response.headers()['content-security-policy'] }));
  try {
    const path = `/${strict ? 'strict' : 'plain'}/${target.name}/${target.entry}`;
    await page.goto(strict ? `${base}/__frame?entry=${encodeURIComponent(path)}` : base + path, { waitUntil: 'domcontentloaded' });
    const frame = strict ? page.frames().find(f => f.parentFrame()) : page.mainFrame();
    assert.ok(frame, 'game frame exists');
    await frame.locator('#btn-start:not(:disabled)').waitFor({ timeout: 30000 });
    assert.equal((await frame.locator('#btn-start').innerText()).replace(/\s/g, ''), '开始游戏');
    const assets = await inspectMap(frame, target);
    const storageNotice = await frame.locator('.title-version').innerText();
    if (strict) assert.match(storageNotice, /当前环境无法保存进度/);
    else {
      const retained = await frame.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])));
      for (const key of ['saveclaude:auto', 'saveclaude:slot0', 'saveclaude:1.0.0:auto', 'saveclaude:v1.0.0:slot5']) assert.equal(retained[key], undefined, 'old game save removed');
      assert.equal(retained['saveclaude:1.1.0:slot5'], 'current-marker');
      assert.equal(retained['unrelated-app-key'], 'keep');
      assert.equal(JSON.parse(retained['saveclaude:audio']).musicVolume, .21);
    }
    await frame.locator('#btn-start').click();
    await frame.waitForFunction(() => !!document.querySelector('#text').textContent, null, { timeout: 30000 });
    for (let i = 0; i < 3; i++) await nextLine(frame);
    await frame.waitForFunction(() => !!document.querySelector('#chars img[data-character="claude"]')?.naturalWidth);
    const stage = await frame.evaluate(() => ({
      backgrounds: [...document.querySelectorAll('.bg')].map(n => ({ image: n.style.backgroundImage, opacity: n.style.opacity })),
      portrait: document.querySelector('#chars img[data-character="claude"]').src,
    }));
    const bg = assets.map['assets/bg/church_nave.webp'] || 'assets/bg/church_nave.webp';
    const portrait = assets.map['assets/char-redrawn/claude/tea.webp'] || 'assets/char-redrawn/claude/tea.webp';
    assert.ok(stage.backgrounds.some(b => b.image.includes(bg) && b.opacity === '1'), 'decoded correct background is visible');
    assert.ok(stage.portrait.endsWith(portrait), 'authored Claude pose uses the resolved image');
    await frame.evaluate(() => document.fonts.ready.then(() => true));
    const expectedMedia = ['assets/fonts/story-serif.woff2'];
    if (strict) expectedMedia.push('assets/bgm/sanctuary_cold.mp3', 'assets/sfx/click.mp3');
    for (const logical of expectedMedia) {
      const resolved = assets.map[logical] || logical;
      assert.ok(responses.some(r => new URL(r.url).pathname.endsWith('/' + resolved) && [200, 206].includes(r.status)), `${logical} fetched through its correct mapping`);
    }
    const runtime = responses.filter(r => /\/engine-runtime(?:\.[a-f0-9]{16})?\.js$/.test(new URL(r.url).pathname));
    assert.ok(runtime.length > 0, 'external engine bundle was fetched');
    for (const response of runtime) { assert.equal(response.status, 200); assert.match(response.type, /(?:java|ecma)script/); }
    assert.ok(!responses.some(r => /\/engine\/packages\/.*\/dist\//.test(r.url)), 'browser does not depend on engine dist paths');
    if (strict) {
      assert.equal(responses.find(r => new URL(r.url).pathname === path)?.csp, CSP, 'real document response carries the exact platform policy');
      const storageError = await frame.evaluate(() => { try { void localStorage.length; return null; } catch (e) { return e.name; } });
      assert.equal(storageError, 'SecurityError', 'opaque sandbox origin has no localStorage');
      // Halion also omits allow-modals: alert() is suppressed by the browser.
      // The visible title notice is the reliable warning, not a dialog event.
      await frame.locator('#btn-save').click(); await frame.locator('#slots .slot').first().click();
      assert.ok(await frame.locator('#slots').isVisible());
      await frame.locator('[data-close="slots"]').click();
      await nextLine(frame);
      assert.ok(await frame.locator('#textbox').isVisible(), 'storage denial does not prevent play');
    } else {
      await finishLine(frame);
      const saved = await frame.evaluate(() => JSON.parse(localStorage.getItem('saveclaude:1.1.0:auto')));
      await frame.locator('#btn-save').click(); await frame.locator('#slots .slot').first().click();
      await frame.locator('[data-close="slots"]').click();
      await nextLine(frame);
      await frame.locator('#btn-load').click(); await frame.locator('#slots .slot').first().click();
      await frame.waitForFunction(expected => {
        const actual = JSON.parse(localStorage.getItem('saveclaude:1.1.0:auto'))?.snapshot.state;
        return actual?.nodeId === expected.nodeId && actual?.lineIndex === expected.lineIndex;
      }, saved.snapshot.state);
      const slot = await frame.evaluate(() => JSON.parse(localStorage.getItem('saveclaude:1.1.0:slot0')));
      assert.equal(slot.snapshot.state.lineIndex, saved.snapshot.state.lineIndex);
      assert.deepEqual(slot.stage, saved.stage);
    }
    assert.deepEqual(policyErrors, []); assert.deepEqual(errors, []);
    await page.screenshot({ path: resolve(out, `${name}.png`) });
    results.push({ name, passed: true, assets, stage, runtime, storageNotice, storage: strict ? 'sandbox denial handled without interrupting play' : 'manual save/load restored the authored stage and line' });
  } catch (error) {
    results.push({ name, passed: false, error: error.stack, errors, policyErrors, responses });
    await page.screenshot({ path: resolve(out, `${name}-failed.png`) });
  } finally { await context.close(); }
}

try {
  browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox'] });
  await Promise.all(targets.flatMap(target => [check(target, true), check(target, false)]));
} finally {
  await browser?.close();
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  await writeFile(resolve(out, 'results.json'), JSON.stringify({ csp: CSP, releaseIncluded: targets.some(t => t.release), results, requests }, null, 2) + '\n');
  console.log(JSON.stringify({ releaseIncluded: targets.some(t => t.release), results: results.map(({ name, passed, error }) => ({ name, passed, error })) }, null, 2));
}
if (results.some(r => !r.passed)) process.exitCode = 1;
