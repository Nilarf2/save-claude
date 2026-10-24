// Finite browser audit. Start a static server at 8137; no app test hooks required.
// PLAYWRIGHT_MODULE and CHROMIUM_PATH may point to an existing installation.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const CONTENT_VERSION = '1.1.0';
const SAVE_PREFIX = `saveclaude:${CONTENT_VERSION}:`;
const base = process.env.AUDIT_URL || 'http://127.0.0.1:8137/web/index.html';
const out = process.env.AUDIT_OUT || resolve('build/ui-audit');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox'] });
const results = [];
async function check(name, task, options = {}) {
  if (process.env.AUDIT_FILTER && !name.includes(process.env.AUDIT_FILTER)) return;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  await context.addInitScript(prefix => { window.__auditSavePrefix = prefix; }, SAVE_PREFIX);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try { await task(page, context); assert.deepEqual(errors, []); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message }); await page.screenshot({ path: `${out}/failure-${results.length}.png` }); }
  finally { await context.close(); }
}
async function boot(page) { await page.goto(base); await page.locator('#btn-start').waitFor({ state: 'visible' }); await page.waitForFunction(() => !document.querySelector('#btn-start').disabled); }
async function saved(page) { return page.evaluate(() => JSON.parse(localStorage.getItem(window.__auditSavePrefix + 'auto'))); }
async function settled(page) {
  await page.waitForFunction(() => {
    const choice = document.querySelector('#choices');
    return !document.querySelector('#ending').classList.contains('hidden') || !choice.classList.contains('hidden') || !!document.querySelector('#text').textContent;
  });
  if (await page.locator('#choices').evaluate(n => n.classList.contains('hidden'))) {
    if (await page.locator('#textbox').evaluate(n => !n.classList.contains('hidden'))) {
      if (!await page.locator('#next-indicator').evaluate(n => n.classList.contains('show'))) await page.locator('#textbox').click();
      await page.locator('#next-indicator.show').waitFor();
    }
  }
}
async function step(page, option = 0, useKeyboard = false) {
  await settled(page);
  const before = await saved(page);
  const sig = JSON.stringify(before?.snapshot.state);
  if (await page.locator('#choices').evaluate(n => !n.classList.contains('hidden'))) {
    if (useKeyboard) await page.keyboard.press(String.fromCharCode(65 + option));
    else await page.locator('.choice:not(:disabled)').nth(option).click();
  }
  else await page.locator('#textbox').click();
  await page.waitForFunction(old => {
    const raw = localStorage.getItem(window.__auditSavePrefix + 'auto');
    return raw && JSON.stringify(JSON.parse(raw).snapshot.state) !== old || !document.querySelector('#ending').classList.contains('hidden');
  }, sig);
  await settled(page);
}
await check('real opening, stage snapshots, speaker focus, keyboard, manual save/load, current and corrupt saves', async page => {
  const failures = [];
  page.on('requestfailed', req => failures.push(req.url().split('/').at(-1)));
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    window.__audioAttempts = [];
    HTMLMediaElement.prototype.play = function () { window.__audioAttempts.push(this.src); return play.call(this); };
  });
  await boot(page);
  assert.equal(await page.locator('#btn-continue').isVisible(), false);
  await page.locator('#btn-start').click(); await settled(page);
  const first = await saved(page);
  await page.keyboard.press('Space');
  await page.waitForFunction(index => JSON.parse(localStorage.getItem(window.__auditSavePrefix + 'auto')).snapshot.state.lineIndex !== index, first.snapshot.state.lineIndex);
  await settled(page);
  assert.ok((await page.evaluate(() => window.__audioAttempts)).some(src => src.includes('sanctuary_cold.mp3')), 'BGM requested from engine audio state');
  const story = await page.evaluate(async () => (await fetch('story.json')).json());
  const stageChecks = [];
  for (let i = 0; i < 75; i++) {
    const data = await saved(page), state = data.snapshot.state;
    const source = story.nodes.find(n => n.id === state.nodeId);
    const stage = source.lines?.[state.lineIndex]?.stage;
    if (stage) {
      const actual = await page.locator('#chars .sprite').evaluateAll(nodes => nodes.map(n => ({ side: n.dataset.slot, cid: n.dataset.character, dim: n.classList.contains('dim'), filter: getComputedStyle(n).filter, ready: n.tagName !== 'IMG' || n.naturalWidth > 0 })));
      assert.deepEqual(Object.fromEntries(actual.map(n => [n.side, n.cid])), stage.slots);
      for (const sprite of actual) { assert.equal(sprite.ready, true); assert.ok(!sprite.filter.includes('blur(')); assert.equal(sprite.dim, sprite.cid !== stage.focus); }
      stageChecks.push({ node: state.nodeId, line: state.lineIndex, slots: stage.slots });
    }
    if (state.nodeId.startsWith('A03:')) break;
    await step(page, 0, true);
  }
  assert.ok(stageChecks.some(s => Object.keys(s.slots).length === 2));
  assert.ok(stageChecks.at(-1).node.startsWith('A03:'), 'actual choices reach A03');
  const before = await saved(page);
  await page.locator('#btn-save').click(); await page.locator('#slots .slot').first().click(); await page.keyboard.press('Escape');
  await step(page);
  await page.locator('#btn-load').click(); await page.locator('#slots .slot').first().click(); await settled(page);
  const after = await saved(page);
  assert.equal(after.snapshot.state.nodeId, before.snapshot.state.nodeId);
  assert.equal(after.snapshot.state.lineIndex, before.snapshot.state.lineIndex);
  assert.deepEqual(after.transcript, before.transcript);
  assert.deepEqual(after.stage, before.stage);
  await page.locator('#btn-log').click(); assert.equal(await page.locator('#log-body > div').count(), before.transcript.length); await page.keyboard.press('Escape');
  await page.evaluate(() => localStorage.setItem(window.__auditSavePrefix + 'slot1', '{broken'));
  await page.locator('#btn-load').click(); assert.match(await page.locator('#slots .slot').nth(1).innerText(), /无法读取/);
  page.once('dialog', d => d.accept()); await page.locator('#slots .slot').nth(1).click();
  assert.equal(await page.evaluate(() => localStorage.getItem(window.__auditSavePrefix + 'slot1')), '{broken');
  await page.keyboard.press('Escape');
  // Optional display metadata can be absent in a current-version save.
  await page.evaluate(() => { const data = JSON.parse(localStorage.getItem(window.__auditSavePrefix + 'slot0')); delete data.stage; delete data.transcript; localStorage.setItem(window.__auditSavePrefix + 'slot2', JSON.stringify(data)); });
  await page.locator('#btn-load').click(); await page.locator('#slots .slot').nth(2).click(); await settled(page);
  assert.equal((await saved(page)).snapshot.state.nodeId, before.snapshot.state.nodeId);
  // Malformed current-version transcript entries are ignored rather than crashing logs.
  await page.evaluate(() => { const data = JSON.parse(localStorage.getItem(window.__auditSavePrefix + 'slot0')); data.transcript = [null, {}, { kind: 'narr', text: '旧日志' }]; localStorage.setItem(window.__auditSavePrefix + 'slot3', JSON.stringify(data)); });
  await page.locator('#btn-load').click(); await page.locator('#slots .slot').nth(3).click(); await settled(page); await page.locator('#btn-log').click();
  assert.match(await page.locator('#log-body').innerText(), /旧日志/); await page.keyboard.press('Escape');
  await page.screenshot({ path: `${out}/desktop-stage.png` });
  await writeFile(`${out}/opening-stage-checks.json`, JSON.stringify(stageChecks, null, 2));
  assert.deepEqual(failures, []);
});
await check('responsive title, portraits, controls, menus and rotation', async (page, context) => {
  await boot(page);
  const sizes = [[1440,900],[390,844],[844,390],[1024,768],[320,568],[568,320]];
  for (const [width,height] of sizes) {
    await page.setViewportSize({width,height});
    await page.screenshot({path:`${out}/title-${width}x${height}.png`});
    const start = await page.locator('#btn-start').boundingBox(); assert.ok(start.x >= 0 && start.y >= 0 && start.y + start.height <= height);
    const art = await page.locator('.title-art').boundingBox(); assert.ok(art.x >= 0 && art.y >= 0 && art.x + art.width <= width && art.y + art.height <= height);
  }
  await page.setViewportSize({width:390,height:844}); await page.locator('#btn-start').click(); await settled(page);
  for (let i=0;i<5;i++) await step(page);
  for (const [width,height] of sizes) {
    await page.setViewportSize({width,height}); await page.waitForTimeout(100);
    const boxes = await page.locator('#chars .sprite').evaluateAll(nodes => nodes.map(n => { const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; }));
    for(const r of boxes) assert.ok(r.left>=-1 && r.right<=width+1 && r.top>=-1 && r.bottom<=height+1,JSON.stringify({width,height,r}));
    await page.screenshot({path:`${out}/stage-${width}x${height}.png`});
    await page.locator('#btn-menu').click();
    await page.locator('#music-volume').fill('52');
    await page.locator('#music-on').uncheck();
    await page.screenshot({path:`${out}/menu-${width}x${height}.png`});
    await page.keyboard.press('Escape');
  }
  const audio = await page.evaluate(()=>JSON.parse(localStorage.getItem('saveclaude:audio'))); assert.equal(audio.musicVolume,.52); assert.equal(audio.musicOn,false);
  await page.locator('#btn-auto').click();
  const state = (await saved(page)).snapshot.state;
  await page.waitForFunction(revision => JSON.parse(localStorage.getItem(window.__auditSavePrefix + 'auto')).snapshot.state.revision > revision, state.revision, { timeout:9000 });
  await page.locator('#btn-auto').click();
  await page.locator('#btn-menu').click(); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>!!document.activeElement.closest('#menu-panel')),true);
  await page.locator('#btn-tomenu').click(); assert.equal(await page.locator('#title').evaluate(n=>!n.classList.contains('hidden')),true);
  await page.locator('#btn-continue').click(); await settled(page);
});
await check('slow resource cancellation and clean restart', async page => {
  await page.route('**/assets/bg/**', async route => { await new Promise(r=>setTimeout(r,450)); await route.continue().catch(()=>{}); });
  await boot(page); await page.locator('#btn-start').click();
  await page.locator('#btn-menu').click(); await page.locator('#btn-tomenu').click();
  await page.waitForTimeout(850);
  assert.equal(await page.locator('#textbox').evaluate(n=>n.classList.contains('hidden')),true);
  assert.equal(await page.locator('#chars .sprite').count(),0);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#btn-start').click(); await settled(page);
  assert.equal((await saved(page)).snapshot.state.nodeId,'A00:s0');
});
await check('missing portrait and background never block dialogue', async page => {
  await page.route('**/assets/char*/**', route => route.abort());
  await page.route('**/assets/bg/**', route => route.abort());
  await boot(page); await page.locator('#btn-start').click(); await settled(page);
  for(let i=0;i<5;i++) await step(page);
  assert.ok((await page.locator('#text').innerText()).length>0);
  assert.ok(await page.locator('.portrait-missing').count()>0);
});
await check('story loading error remains understandable', async page => {
  await page.route('**/story.json', route=>route.fulfill({status:503,body:'unavailable'}));
  await page.goto(base); await page.waitForFunction(()=>document.querySelector('.title-tagline').textContent.includes('载入失败'));
  assert.equal(await page.locator('#btn-start').isDisabled(),true);
});
await check('focused regression: touch rotation, first-letter resources, audio gesture and visibility', async page => {
  await page.addInitScript(() => {
    const nativePlay = HTMLMediaElement.prototype.play;
    const nativeDecode = HTMLImageElement.prototype.decode;
    window.__media = []; window.__decoded = new Set(); window.__firstLetters = [];
    let blocked = false;
    HTMLMediaElement.prototype.play = function () {
      if (!window.__media.includes(this)) window.__media.push(this);
      if (this.src.includes('/bgm/') && !blocked) { blocked = true; return Promise.reject(new DOMException('Gesture required', 'NotAllowedError')); }
      return nativePlay.call(this);
    };
    HTMLImageElement.prototype.decode = async function () { await nativeDecode.call(this); window.__decoded.add(this.src); };
    window.addEventListener('DOMContentLoaded', () => {
      const text = document.querySelector('#text'); let hadText = false;
      new MutationObserver(() => {
        if (text.textContent && !hadText) {
          const imgs = [...document.querySelectorAll('#chars img')];
          const bg = [...document.querySelectorAll('.bg')].find(n => n.style.opacity === '1');
          const match = bg?.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/);
          const src = match ? new URL(match[1], location.href).href : null;
          window.__firstLetters.push({ ready: imgs.every(img => img.complete && img.naturalWidth > 0 && window.__decoded.has(img.src)), background: !!src && window.__decoded.has(src) });
        }
        hadText = !!text.textContent;
      }).observe(text, { childList: true, characterData: true, subtree: true });
    });
  });
  await page.route('**/assets/char*/**', async route => { await new Promise(resolve => setTimeout(resolve, 250)); await route.continue(); });
  await page.route('**/assets/bg/**', async route => { await new Promise(resolve => setTimeout(resolve, 250)); await route.continue(); });
  await page.setViewportSize({ width: 390, height: 844 }); await boot(page);
  await page.locator('#btn-start').click(); await settled(page);
  // The first play was rejected; the next real pointer gesture must resume it.
  await page.locator('#textbox').click(); await settled(page);
  await page.waitForFunction(() => window.__media.some(media => media.src.includes('/bgm/') && !media.paused));
  for (let i = 0; i < 4; i++) await step(page);
  for (const [width, height] of [[390,844],[844,390],[568,320]]) {
    await page.setViewportSize({width,height}); await page.locator('#btn-menu').click();
    for (const selector of ['#menu button','.audio-row label','.audio-row input[type="range"]','.panel-head .close']) {
      const heights = await page.locator(selector).evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().height).filter(height => height > 0));
      assert.ok(heights.length && heights.every(value => value >= 44), `${selector} touch target`);
    }
    await page.locator('#btn-stats').scrollIntoViewIfNeeded(); await page.locator('#btn-stats').click();
    await page.screenshot({path:`${out}/touch-menu-${width}x${height}.png`}); await page.keyboard.press('Escape');
  }
  const letters = await page.evaluate(() => window.__firstLetters);
  assert.ok(letters.length >= 5); assert.ok(letters.every(line => line.ready && line.background), JSON.stringify(letters));
  await page.locator('#btn-auto').click();
  await page.evaluate(() => { window.__auditHidden = true; Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__auditHidden }); document.dispatchEvent(new Event('visibilitychange')); });
  const paused = await saved(page);
  assert.equal(await page.evaluate(() => window.__media.every(media => media.paused)), true);
  await page.waitForTimeout(1800);
  assert.equal((await saved(page)).snapshot.state.revision, paused.snapshot.state.revision);
  await page.evaluate(() => { window.__auditHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => window.__media.some(media => media.src.includes('/bgm/') && !media.paused));
  await page.waitForFunction(revision => JSON.parse(localStorage.getItem(window.__auditSavePrefix + 'auto')).snapshot.state.revision > revision, paused.snapshot.state.revision, {timeout:9000});
}, { isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
await check('ending UI regression: load a manual save and return to title', async page => {
  await boot(page); await page.locator('#btn-start').click(); await settled(page);
  // This prepares an ending screen for UI checks, not a claim of route coverage.
  await page.evaluate(async () => {
    const data = JSON.parse(localStorage.getItem(window.__auditSavePrefix + 'auto'));
    localStorage.setItem(window.__auditSavePrefix + 'slot0', JSON.stringify(data));
    const story = await (await fetch('story.json')).json();
    const end = story.nodes.find(node => node.type === 'end');
    data.snapshot.state.nodeId = end.id;
    data.snapshot.state.awaiting = 'ended';
    data.snapshot.state.lineIndex = 0;
    data.snapshot.state.ending = end.ending;
    localStorage.setItem(window.__auditSavePrefix + 'slot5', JSON.stringify(data));
  });
  await page.locator('#btn-load').click(); await page.locator('#slots .slot').nth(5).click(); await page.locator('#ending:not(.hidden)').waitFor();
  await page.locator('#btn-ending-load').click(); await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-ending-load');
  await page.locator('#btn-ending-load').click(); await page.locator('#slots .slot').first().click(); await settled(page);
  assert.equal((await saved(page)).snapshot.state.nodeId, 'A00:s0');
  await page.locator('#btn-menu').click(); await page.locator('#btn-tomenu').click();
  const original = await page.evaluate(() => localStorage.getItem(window.__auditSavePrefix + 'auto'));
  page.once('dialog', dialog => dialog.dismiss()); await page.locator('#btn-start').click();
  assert.equal(await page.evaluate(() => localStorage.getItem(window.__auditSavePrefix + 'auto')), original);
  assert.equal(await page.locator('#title').evaluate(node => !node.classList.contains('hidden')), true);
  await page.locator('#btn-continue').click(); await settled(page);
  await page.locator('#btn-load').click(); await page.locator('#slots .slot').nth(5).click(); await page.locator('#ending:not(.hidden)').waitFor();
  for (const [width,height] of [[390,844],[844,390],[568,320]]) {
    await page.setViewportSize({width,height});
    await page.locator('#btn-ending-title').scrollIntoViewIfNeeded();
    await page.screenshot({path:`${out}/ending-${width}x${height}.png`});
  }
  await page.locator('#btn-ending-title').click();
  await page.locator('#title:not(.hidden)').waitFor();
  assert.equal(await page.locator('#btn-continue').isVisible(),false);
});
await check('save namespace regression: discard old story saves and preserve current progress/preferences', async page => {
  await boot(page);
  const fixtures = await page.evaluate(prefix => {
    const outdated = [];
    for (const namespace of ['saveclaude:', 'saveclaude:0.9.0:', 'saveclaude:1.0.0:', 'saveclaude:v0.8.0:']) {
      for (const name of ['auto', ...Array.from({ length: 6 }, (_, i) => 'slot' + i)]) {
        const key = namespace + name;
        outdated.push(key);
        localStorage.setItem(key, 'discard-old-story');
      }
    }
    const keep = {
      [prefix + 'auto']: '{"current":"keep"}',
      [prefix + 'slot5']: '{broken-current',
      'saveclaude:audio': JSON.stringify({ musicOn: false, musicVolume: .17, sfxOn: true, sfxVolume: .29 }),
      'saveclaude:1.0.0:audio': 'old-version-audio-preference',
      'saveclaude:slot6': 'outside-official-slot-range',
      'saveclaude:profile:auto': 'not-a-versioned-story-save',
      'saveclaude:notes': 'unrelated-game-metadata',
      'another-app:progress': 'other-app-progress',
      'another-app:saveclaude:auto': 'other-app-near-match',
    };
    for (const [key, value] of Object.entries(keep)) localStorage.setItem(key, value);
    return { outdated, keep };
  }, SAVE_PREFIX);
  await page.reload(); await page.waitForFunction(() => !document.querySelector('#btn-start').disabled);
  const read = keys => page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), keys);
  const removed = await read(fixtures.outdated);
  assert.ok(Object.values(removed).every(value => value === null), 'only old story save keys are removed');
  assert.deepEqual(await read(Object.keys(fixtures.keep)), fixtures.keep);
  page.once('dialog', dialog => dialog.accept()); await page.locator('#btn-start').click(); await settled(page);
  const current = await saved(page); assert.equal(current.snapshot.contentVersion, CONTENT_VERSION);
  await page.locator('#btn-save').click(); await page.locator('#slots .slot').first().click(); await page.keyboard.press('Escape');
  const currentKeys = [SAVE_PREFIX + 'auto', SAVE_PREFIX + 'slot0', SAVE_PREFIX + 'slot5'];
  const beforeReload = await read(currentKeys);
  await page.reload(); await page.waitForFunction(() => !document.querySelector('#btn-start').disabled);
  assert.deepEqual(await read(currentKeys), beforeReload, 'refresh preserves all current-version data');
  assert.equal(await page.locator('#btn-continue').isVisible(), true);
  await page.locator('#btn-continue').click(); await settled(page);
  assert.equal((await saved(page)).snapshot.state.lineIndex, current.snapshot.state.lineIndex);
  await step(page);
  await page.locator('#btn-load').click(); await page.locator('#slots .slot').first().click(); await settled(page);
  assert.equal((await saved(page)).snapshot.state.lineIndex, current.snapshot.state.lineIndex);
  await page.locator('#btn-load').click();
  page.once('dialog', dialog => dialog.accept()); await page.locator('#slots .slot').nth(5).click();
  assert.equal((await read([SAVE_PREFIX + 'slot5']))[SAVE_PREFIX + 'slot5'], fixtures.keep[SAVE_PREFIX + 'slot5']);
  await page.screenshot({ path: `${out}/current-version-save-slots.png` }); await page.keyboard.press('Escape');
  await page.locator('#btn-menu').click();
  assert.equal(await page.locator('#music-on').isChecked(), false);
  assert.equal(await page.locator('#music-volume').inputValue(), '17');
  const protectedKeys = Object.keys(fixtures.keep).filter(key => !key.startsWith(SAVE_PREFIX));
  assert.deepEqual(await read(protectedKeys), Object.fromEntries(protectedKeys.map(key => [key, fixtures.keep[key]])));
  assert.ok(Object.values(await read(fixtures.outdated)).every(value => value === null));
});
await browser.close();
await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
if(results.some(r=>!r.passed))process.exitCode=1;
