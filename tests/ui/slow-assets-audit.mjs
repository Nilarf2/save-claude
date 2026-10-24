// Focused slow-network regression. Serve the repository root on port 8137.
// No story files are changed: test fixtures substitute stage metadata in memory.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.AUDIT_URL || 'http://127.0.0.1:8137/web/index.html';
const out = process.env.AUDIT_OUT || resolve('build/slow-assets-audit');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const results = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(name, task, viewport = { width: 1440, height: 900 }) {
  if (process.env.AUDIT_FILTER && !name.includes(process.env.AUDIT_FILTER)) return;
  const context = await browser.newContext({ viewport });
  const page = await context.newPage(), errors = [], network = [];
  page.on('pageerror', e => errors.push(e.message));
  const start = Date.now();
  page.on('response', r => { if (/\/(bg|char-redrawn)\//.test(r.url())) network.push({ path: new URL(r.url()).pathname, status: r.status(), ms: Date.now() - start }); });
  try {
    const detail = await task(page, context);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${out}/${name}.png` });
    results.push({ name, passed: true, detail, network });
  } catch (e) {
    results.push({ name, passed: false, error: e.stack, errors, network });
    await page.screenshot({ path: `${out}/${name}-failed.png` });
  } finally { await context.close(); }
}
async function boot(page) {
  await page.goto(base);
  await page.waitForFunction(() => !document.querySelector('#btn-start').disabled);
}
async function fixture(context, sameScene = false) {
  await context.route('**/story.json', async route => {
    const response = await route.fetch(), story = await response.json();
    const lines = story.nodes.find(n => n.id === 'A00:s0').lines;
    for (const [index, cid, bg] of [[0, 'claude', 'church_nave'], sameScene ? [1, 'claude', 'church_nave'] : [1, 'deepseek', 'sanctuary_hub']]) {
      lines[index].stage = { ...lines[index].stage, present: [cid], slots: { left: cid }, expressions: { [cid]: cid === 'claude' ? 'tea' : '' }, focus: cid, background: bg };
    }
    await route.fulfill({ response, json: story });
  });
}
async function delay(context, milliseconds, portraits = true) {
  await context.route('**/assets/**/*.webp', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.endsWith('/bg/church_nave.webp') && !(portraits && path.includes('/char-redrawn/claude/'))) return route.continue();
    const response = await route.fetch();
    await sleep(path.includes('/char-redrawn/claude/') && typeof portraits === 'number' ? portraits : milliseconds);
    await route.fulfill({ response });
  });
}
async function firstText(page) { await page.waitForFunction(() => !!document.querySelector('#text').textContent, null, { timeout: 18000 }); }
async function finishLine(page) {
  // Read and skip in the same browser task. A slow test runner may otherwise
  // let natural typing finish between the check and a pointer click.
  await page.locator('#textbox').evaluate(box => {
    if (!document.querySelector('#next-indicator').classList.contains('show')) box.click();
  });
  await page.locator('#next-indicator.show').waitFor();
}
async function nextLine(page, index) {
  await finishLine(page);
  await page.locator('#textbox').click();
  await page.waitForFunction(index => JSON.parse(localStorage.getItem('saveclaude:1.1.0:auto'))?.snapshot.state.lineIndex === index, index);
  await firstText(page);
}
async function visualState(page) {
  return page.evaluate(() => ({
    backgrounds: [...document.querySelectorAll('.bg')].map(n => ({ image: n.style.backgroundImage, opacity: n.style.opacity })),
    sprites: [...document.querySelectorAll('#chars .sprite')].map(n => ({ tag: n.tagName, cid: n.dataset.character, ready: n.tagName === 'IMG' && n.naturalWidth > 0, text: n.textContent })),
    status: document.querySelector('#asset-loading')?.hidden === false ? document.querySelector('#asset-loading').textContent : '',
  }));
}
await Promise.all([
  check('cold-10s-background-before-dialogue', async (page, context) => {
    await delay(context, 10500, false); await boot(page);
    const start = Date.now(); await page.locator('#btn-start').click();
    await page.locator('#asset-loading').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#text').textContent(), '');
    await firstText(page); const ms = Date.now() - start, state = await visualState(page);
    assert.ok(ms >= 10500 && ms < 12500, `first dialogue at ${ms}ms`);
    assert.ok(state.backgrounds.some(b => b.image.includes('church_nave') && b.opacity === '1'));
    assert.equal(state.status, '');
    return { ms, state };
  }),
  check('late-background-and-portrait-recover', async (page, context) => {
    await fixture(context, true); await delay(context, 16000, 13000); await boot(page);
    const start = Date.now(); await page.locator('#btn-start').click();
    await firstText(page); const ms = Date.now() - start, timedOut = await visualState(page);
    assert.ok(ms >= 11900 && ms < 13500, `bounded dialogue at ${ms}ms`);
    assert.match(timedOut.status, /可继续阅读/);
    assert.equal(timedOut.sprites[0]?.tag, 'DIV'); assert.match(timedOut.sprites[0].text, /正在加载/);
    await page.screenshot({ path: `${out}/mobile-loading-feedback.png` });
    const feedbackBox = await page.locator('#asset-loading').boundingBox();
    assert.ok(feedbackBox.x >= 0 && feedbackBox.x + feedbackBox.width <= 390);
    // One resource is now ready, while the background has already timed out.
    await page.waitForFunction(() => !!document.querySelector('#chars img[data-character="claude"]')?.naturalWidth, null, { timeout: 6000 });
    const startedNextLine = Date.now(); await nextLine(page, 1);
    assert.ok(Date.now() - startedNextLine < 1200, 'same pending image must not restart the deadline');
    await page.waitForFunction(() => !!document.querySelector('#chars img[data-character="claude"]')?.naturalWidth, null, { timeout: 6000 });
    await page.waitForFunction(() => document.querySelector('#asset-loading').hidden);
    const recovered = await visualState(page);
    assert.equal(recovered.sprites.length, 1);
    assert.ok(recovered.backgrounds.some(b => b.image.includes('church_nave') && b.opacity === '1'));
    // Loading feedback must fit a small mobile viewport.
    return { ms, timedOut, recovered };
  }, { width: 390, height: 844 }),
  check('late-old-scene-and-character-do-not-return', async (page, context) => {
    await fixture(context); await delay(context, 14200); await boot(page);
    await page.locator('#btn-start').click(); await firstText(page);
    await nextLine(page, 1);
    await page.waitForFunction(() => !!document.querySelector('#chars img[data-character="deepseek"]')?.naturalWidth);
    await page.waitForTimeout(2700); const state = await visualState(page);
    assert.deepEqual(state.sprites.map(s => s.cid), ['deepseek']);
    assert.ok(state.backgrounds.some(b => b.image.includes('sanctuary_hub') && b.opacity === '1'));
    assert.ok(!state.backgrounds.some(b => b.image.includes('church_nave') && b.opacity === '1'));
    assert.equal(state.status, '');
    return state;
  }),
  check('return-to-title-cancels-loading-effects', async (page, context) => {
    await fixture(context); await delay(context, 1800); await boot(page);
    await page.locator('#btn-start').click(); await page.locator('#asset-loading').waitFor({ state: 'visible' });
    await page.locator('#btn-menu').click(); await page.locator('#btn-tomenu').click();
    await page.waitForTimeout(2200); const state = await visualState(page);
    assert.equal(await page.locator('#title').isVisible(), true);
    assert.equal(await page.locator('#text').textContent(), '');
    assert.deepEqual(state.sprites, []); assert.equal(state.status, '');
    assert.ok(state.backgrounds.every(b => !b.image));
    return state;
  }),
  check('real-404s-use-fallback-without-hanging', async (page, context) => {
    await fixture(context);
    await context.route('**/assets/**/*.webp', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/bg/church_nave.webp') || path.includes('/char-redrawn/claude/')) return route.fulfill({ status: 404, body: 'missing' });
      return route.continue();
    });
    await boot(page); const start = Date.now(); await page.locator('#btn-start').click(); await firstText(page);
    const state = await visualState(page); assert.ok(Date.now() - start < 3000);
    assert.equal(state.status, ''); assert.match(state.sprites[0]?.text, /图像暂不可用/);
    return state;
  }),
]);
await browser.close();
await writeFile(`${out}/results.json`, JSON.stringify({ base, results }, null, 2));
console.log(JSON.stringify(results.map(({ name, passed, error, detail }) => ({ name, passed, error, ms: detail?.ms })), null, 2));
if (results.some(r => !r.passed)) process.exitCode = 1;
