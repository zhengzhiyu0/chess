// Smoke-check the generated local preview and actual M4A media, without API calls.
import assert from 'node:assert/strict';
import { chromium, devices } from '../web/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const root = new URL('../ChessCoachResources/Cast/', import.meta.url);
const catalog = JSON.parse(readFileSync(new URL('coach_lines.json', root), 'utf8'));
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext(mobile ? devices['iPhone 13'] : { viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(new URL('preview.html', root).href);
    assert.equal(await page.locator('.person').count(), 8);
    assert.equal(await page.locator('.row').count(), 121);
    assert.equal(await page.locator('#category option').count(), 31);
    for (const role of catalog.roles) {
      await page.locator(`.person[data-role="${role.id}"]`).click();
      assert.equal(await page.locator('.row').count(), 121);
      await page.selectOption('#category', 'player_brilliant');
      assert.equal(await page.locator('.row').count(), 5);
      await page.locator('.row button').first().click();
      await page.waitForFunction(() => document.querySelector('audio').readyState >= 2);
      assert.equal(await page.locator('audio').evaluate(audio => audio.error?.message ?? null), null);
      assert.ok(await page.locator('audio').evaluate(audio => audio.duration > .2));
      await page.selectOption('#category', '');
    }
    await page.locator('#compare').click();
    assert.equal(await page.locator('.row').count(), 40);
    await page.locator('.row input').first().check();
    await page.locator('#marked').click();
    assert.match(await page.locator('#export').textContent(), /lia_player_brilliant/);
    await page.locator('#search').fill('找不到的台词');
    assert.equal(await page.locator('.row').count(), 0);
    await page.locator('#search').fill('');
    assert.equal(await page.locator('.row').count(), 40);
    await page.selectOption('#category', '');
    await page.locator('.person[data-role="oscar"]').click();
    await page.locator('audio').evaluate(audio => audio.pause());
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    assert.deepEqual(errors, []);
    if (!mobile) await page.screenshot({ path: new URL('preview-desktop.png', root).pathname.replace(/^\/(\w:)/, '$1'), fullPage: false });
    else await page.screenshot({ path: new URL('preview-mobile.png', root).pathname.replace(/^\/(\w:)/, '$1'), fullPage: false });
    console.log(`PASS: ${mobile ? 'phone' : 'desktop'}: 8 roles, 30 categories, filters, comparison, marks, seven real M4As decode`);
    await context.close();
  }
} finally { await browser.close(); }
