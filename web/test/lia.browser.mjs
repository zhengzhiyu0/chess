// Browser integration: real bundled recordings with deterministic chess engines.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium, devices } from 'playwright';

const baseURL = process.argv[2] ?? 'http://127.0.0.1:5173';
const fixture = readFileSync(new URL('./navigation.browser.mjs', import.meta.url), 'utf8').match(/const fakeEngines = `([\s\S]*?)`;/)[1];
const catalog = JSON.parse(readFileSync(new URL('../src/lia/lines.json', import.meta.url), 'utf8'));
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext(mobile ? devices['iPhone 13'] : {});
    await context.route('**/src/app/engines.ts*', route => route.fulfill({ contentType: 'application/javascript', body: fixture }));
    await context.route('**/src/coach/book.ts*', route => route.fulfill({ contentType: 'application/javascript', body: 'export const bookReady=()=>true; export const inBook=()=>false; export const loadBook=async()=>{};' }));
    await context.addInitScript(() => {
      if (!localStorage.getItem('lia-browser-seeded')) {
        localStorage.clear();
        localStorage.setItem('lia-browser-seeded', '1');
        localStorage.setItem('maia-coach.settings', JSON.stringify({ gameType: 'normal', coachAvatar: 0, opponentTalk: true, opponentVoice: true, sound: false, autoOffline: false, thinkDelay: false, sfLite: true }));
        localStorage.setItem('maia-coach.game', JSON.stringify({ id: 'lia-browser', date: 1, startFen: '4k3/8/8/8/8/q7/8/R3K3 b - - 0 1', tree: { c: [{ u: 'a3a2' }] }, userColor: 'w', result: '', coachAvatar: 0, peak: 0 }));
      }
      window.liaPlayed = [];
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        window.liaPlayed.push(this.src);
        window.liaCurrentPlayer = this;
        return play.apply(this, args);
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseURL);
    await page.locator('#btn-continue').click();
    await page.locator('#game:not([aria-busy="true"])').waitFor();
    const bounds = await page.locator('#board cg-board').boundingBox();
    const square = rank => ({ x: bounds.x + bounds.width / 16, y: bounds.y + (8 - rank + .5) * bounds.height / 8 });
    await page.mouse.click(square(1).x, square(1).y);
    await page.mouse.click(square(2).x, square(2).y);
    await page.locator('#opponent-dialogue.show .opponent-cn').waitFor();
    const spoken = await page.locator('.opponent-cn').textContent();
    const clip = catalog.find(clip => clip.text === spoken);
    assert.equal(clip.category, 'player_loses_queen');
    assert.equal(await page.locator('.opponent-en').count(), 0);
    await page.waitForFunction(file => window.liaPlayed.some(url => url.endsWith(file)), clip.file);
    await page.waitForFunction(() => window.liaCurrentPlayer.readyState >= 2);
    assert.equal(await page.evaluate(() => window.liaCurrentPlayer.error), null);
    await page.locator('#btn-back').click();
    await page.locator('#home.active').waitFor();
    assert.equal(await page.evaluate(() => window.liaCurrentPlayer.paused), true);
    assert.deepEqual(errors, []);
    console.log(`PASS: ${mobile ? 'iPhone layout' : 'desktop'} Lia bubble/recording agree, M4A decodes, leaving stops playback`);
    await context.close();
  }
} finally { await browser.close(); }
