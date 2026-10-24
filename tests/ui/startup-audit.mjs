// Check the actual served release, including a recoverable module-load failure.
// AUDIT_URL must point to index.html (or the directory containing it).
// PLAYWRIGHT_MODULE and CHROMIUM_PATH can select an existing browser install.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.env.AUDIT_URL || 'http://127.0.0.1:8137/web/index.html';
const out = resolve(process.env.AUDIT_OUT || 'build/startup-audit');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  args: ['--no-sandbox'],
});
const results = [];

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('#btn-start:not(:disabled)').waitFor({ timeout: 30000 });
  assert.equal((await page.locator('#btn-start').innerText()).replace(/\s/g, ''), '开始游戏');
  const imports = await page.evaluate(() => {
    const map = JSON.parse(document.querySelector('script[type="importmap"]').textContent);
    return Object.fromEntries(Object.entries(map.imports).map(([name, path]) => [name, new URL(path, location.href).href]));
  });
  const modules = [];
  for (const [name, moduleUrl] of Object.entries(imports)) {
    const response = await context.request.get(moduleUrl);
    assert.equal(response.status(), 200, name + ' exists on this host');
    const type = response.headers()['content-type'] || '';
    assert.match(type, /(?:application|text)\/(?:javascript|ecmascript)/i, name + ' is served as JavaScript');
    modules.push({ name, status: response.status(), contentType: type });
  }
  await page.locator('#btn-start').click();
  await page.waitForFunction(() => document.querySelector('#text').textContent.length > 0, null, { timeout: 30000 });
  assert.deepEqual(errors, []);
  await page.screenshot({ path: resolve(out, 'opening.png') });
  results.push({ name: 'served release starts and all engine modules have a JavaScript MIME type', passed: true, modules });
  await context.close();

  const failureContext = await browser.newContext();
  const failurePage = await failureContext.newPage();
  const coreUrl = imports['@text-adventure/core'];
  assert.ok(coreUrl, 'core module is declared');
  let blocked = 0;
  await failurePage.route(coreUrl, async route => {
    if (blocked++ === 0) {
      await route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not found</h1>' });
    } else {
      await route.continue();
    }
  });
  await failurePage.goto(url, { waitUntil: 'domcontentloaded' });
  await failurePage.getByRole('alert').filter({ hasText: '游戏文件未能加载' }).waitFor();
  assert.equal(blocked, 1);
  assert.equal(await failurePage.locator('#btn-start').isEnabled(), true);
  assert.equal(await failurePage.locator('#btn-start').innerText(), '重新加载');
  await failurePage.screenshot({ path: resolve(out, 'missing-module.png') });
  await failurePage.locator('#btn-start').click();
  await failurePage.waitForFunction(() => {
    const button = document.querySelector('#btn-start');
    return button && !button.disabled && button.textContent.replace(/\s/g, '') === '开始游戏';
  }, null, { timeout: 30000 });
  assert.ok(blocked >= 2, 'retry requests the missing module again');
  results.push({ name: 'missing module shows a retry action and reload recovers', passed: true });
  await failureContext.close();
} catch (error) {
  results.push({ passed: false, error: error.stack });
  process.exitCode = 1;
} finally {
  await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
}
