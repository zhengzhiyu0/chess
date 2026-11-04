// Start Vite first, then run: node scripts/back-gesture-browser-check.mjs
// Engine stubs keep these navigation/board checks independent of model downloads.
import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';

const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:4186';
for (const browserType of [chromium, webkit]) {
  const browser = await browserType.launch(browserType === chromium ? { channel: 'chromium' } : {});
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    });
    const errors = [];
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);
    page.on('pageerror', (e) => { errors.push(e.message); console.error(`${browserType.name()} runtime error: ${e.message}`); });
    await page.route('**/src/app/engines.ts', (route) => route.fulfill({ contentType: 'text/javascript', body: `
      export class Engines {
        maia = null;
        sf = { alive: true, lite: true, analyse: () => new Promise(() => {}), terminate() {} };
        readyForGame() { return true; } async prepareGame() {} async warmup() {}
        async getSf() { return this.sf; } async getMaia() { return new Promise(() => {}); }
        unloadSf() {} unloadMaia() {}
      }
    ` }));
    await page.addInitScript(() => {
      const now = performance.now.bind(performance);
      performance.now = () => window.__gestureTime ?? now();
      localStorage.setItem('maia-coach.settings', JSON.stringify({ autoOffline: false, sound: false, haptics: false }));
      localStorage.setItem('maia-coach.game', JSON.stringify({
        id: 'gesture-test', date: 100,
        startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        tree: {}, userColor: 'w', result: '', mode: 'play', tc: 'none',
      }));
      window.__touch = (type, x, y, extra = false) => {
        const target = type === 'touchstart' ? document.elementFromPoint(x, y) : window.__touchTarget;
        if (type === 'touchstart') window.__touchTarget = target;
        const point = { identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y };
        const touches = type === 'touchend' || type === 'touchcancel' ? [] : extra ? [point, { ...point, identifier: 2 }] : [point];
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, { touches: { value: touches }, targetTouches: { value: touches }, changedTouches: { value: [point] } });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
    });
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#home.active');
    await page.waitForFunction(() => document.querySelector('#home-elo-val')?.textContent.trim());
    await page.locator('#btn-play').evaluate((el) => el.click());
    await page.waitForSelector('#game.active');
    await page.waitForTimeout(400);
    console.log(`${browserType.name()}: game ready`);
    const screenCount = await page.locator('.screen').count();

    let time = 10000;
    const touch = async (type, x, y, dt = 20, extra = false) => {
      time += dt;
      return page.evaluate(({ type, x, y, time, extra }) => {
        window.__gestureTime = time;
        return window.__touch(type, x, y, extra);
      }, { type, x, y, time, extra });
    };
    const settle = () => page.waitForFunction(() => !document.querySelector('.edge-swipe, .edge-swipe-settling, .edge-swipe-preview, .edge-swipe-cleanup'));
    const active = async (id) => assert.equal(await page.locator(`#${id}`).evaluate((el) => el.classList.contains('active')), true);
    const openSettings = async () => {
      await page.locator('#btn-settings').evaluate((el) => el.click());
      await page.waitForTimeout(300);
      await active('settings');
    };
    const swipe = async (y, points) => {
      await touch('touchstart', 6, y);
      for (const [x, dt = 20] of points) await touch('touchmove', x, y, dt);
      const departed = await page.locator('.screen.active').getAttribute('id');
      // Do not force style/layout during cleanup: that would hide the one-frame flash.
      await page.evaluate((id) => {
        const el = document.getElementById(id);
        window.__backFrames = [];
        window.__backFrameDone = new Promise((resolve) => {
          let remaining = 24;
          const sample = () => {
            if (el.classList.contains('active') || el.classList.contains('edge-swipe-cleanup')) {
              if (--remaining > 0) requestAnimationFrame(sample);
              else resolve();
              return;
            }
            const style = getComputedStyle(el);
            const home = getComputedStyle(document.getElementById('home'));
            window.__backFrames.push({ visibility: style.visibility, opacity: style.opacity, homeOpacity: home.opacity, homeTransform: home.transform });
            if (--remaining > 0) requestAnimationFrame(sample);
            else resolve();
          };
          requestAnimationFrame(sample);
        });
      }, departed);
      await touch('touchend', points.at(-1)[0], y);
      await settle();
      await page.evaluate(() => window.__backFrameDone);
      const frames = await page.evaluate(() => window.__backFrames);
      for (const f of frames) {
        assert.equal(f.visibility, 'hidden', `departed page flashed after return: ${JSON.stringify(f)}`);
        assert.equal(f.opacity, '0');
        assert.equal(f.homeOpacity, '1');
        assert.ok(f.homeTransform === 'none' || f.homeTransform === 'matrix(1, 0, 0, 1, 0, 0)');
      }
    };

    // Missed grabs on empty edge squares, pieces, and just outside the board.
    const board = await page.locator('#board').boundingBox();
    assert.ok(board && board.x <= 28, 'portrait board must overlap the back-gesture strip');
    for (const y of [board.y + board.height * 0.45, board.y + board.height * 0.94, board.y - 8]) {
      await touch('touchstart', 6, y);
      await touch('touchmove', 200, y);
      assert.equal(await page.locator('.edge-swipe').count(), 0, 'board touch must not start navigation');
      await touch('touchend', 200, y);
      await settle();
      await active('game');
    }
    console.log(`${browserType.name()}: board miss protection passed`);

    // Actual board input still moves a2-a4.
    const x = board.x + board.width / 16;
    await page.touchscreen.tap(x, board.y + board.height * 6.5 / 8);
    await page.touchscreen.tap(x, board.y + board.height * 4.5 / 8);
    await page.waitForFunction(() => document.querySelector('#moves')?.textContent.includes('a4'), null, { timeout: 8000 });
    await active('game');

    // Non-board edge retains a working slow return.
    await swipe(board.y - 30, [[70, 140], [160, 140]]);
    await active('home');
    console.log(`${browserType.name()}: board misses/moves protected; non-board return passed`);

    await openSettings();
    await touch('touchstart', 6, 150);
    await touch('touchmove', 65, 150, 180);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await page.locator('#settings').evaluate((el) => getComputedStyle(el).opacity), '1');
    assert.equal(await page.locator('.edge-swipe-preview').count(), 1);
    await touch('touchend', 65, 150, 160);
    await settle();
    await active('settings');

    // Short flick commits; slow short movement does not.
    await swipe(150, [[35], [75]]);
    await active('home');
    await openSettings();
    await swipe(150, [[90, 180]]);
    await active('settings');
    await swipe(150, [[180, 40], [130, 20], [90, 20]]);
    await active('settings');

    // Vertical intent, multitouch and cancellation cannot navigate.
    await touch('touchstart', 6, 150);
    await touch('touchmove', 12, 195);
    await touch('touchmove', 220, 195);
    await touch('touchend', 220, 195);
    await settle();
    await active('settings');
    for (const cancel of ['touchcancel', 'multitouch']) {
      await touch('touchstart', 6, 150);
      await touch('touchmove', 170, 150);
      if (cancel === 'multitouch') await touch('touchmove', 180, 150, 20, true);
      else await touch('touchcancel', 170, 150);
      await settle();
      await active('settings');
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await swipe(150, [[160, 180]]);
    await active('home');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    console.log(`${browserType.name()}: flick, short/vertical/reversed/cancelled gestures, multitouch, reduced motion passed`);

    await page.locator('#btn-continue').evaluate((el) => el.click());
    await page.waitForSelector('#game.active');
    await page.waitForTimeout(300);
    await page.locator('[data-tab="review"]').evaluate((el) => el.click());
    await page.locator('#btn-report-free').evaluate((el) => el.click());
    const y = (await page.locator('#board').boundingBox()).y - 30;
    await swipe(y, [[160, 180]]);
    await active('game');
    assert.equal(await page.locator('#report').evaluate((el) => el.classList.contains('hidden')), false);
    assert.equal(await page.locator('.screen').count(), screenCount, 'report preview must be removed');

    // Dialog dismissal must not slide the page behind the modal.
    await page.evaluate(() => document.querySelector('#dlg-menu').showModal());
    await touch('touchstart', 6, 150);
    await touch('touchmove', 160, 150, 180);
    assert.equal(await page.locator('.edge-swipe, .edge-swipe-preview').count(), 0);
    await touch('touchend', 160, 150);
    await settle();
    assert.equal(await page.locator('#dlg-menu').evaluate((el) => el.open), false);
    await active('game');
    assert.deepEqual(errors, []);
    console.log(`${browserType.name()}: report return, modal dismissal, preview cleanup, no runtime errors passed`);
  } finally {
    await browser.close();
  }
}
