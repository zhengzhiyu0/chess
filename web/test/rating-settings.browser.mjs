// Run against the dev server: node test/rating-settings.browser.mjs http://127.0.0.1:5198
import assert from 'node:assert/strict';
import { chromium, webkit, devices } from 'playwright';

const baseURL = process.argv[2] ?? 'http://127.0.0.1:5173';
const settings = {
  elo: 1810, playerElo: 1500, ratingDeviation: 80, ratingStreak: 2, ratedGames: 20,
  autoElo: false, model: '5m', autoOffline: false,
  sound: false, opponentTalk: false, sfLite: true, sfThreads: 1, sfHash: 16,
};
const game = {
  id: 'rating-settings-live', date: 1,
  startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  tree: { c: [{ u: 'e2e4', c: [{ u: 'e7e5' }] }] },
  userColor: 'w', result: '', elo: 1810, playerElo: 1500,
  ratingDeviation: 80, ratingStreak: 2, autoElo: false, temperature: 1, model: '5m', tc: 'none',
};
const engine = process.env.PLAYWRIGHT_ENGINE === 'webkit' ? webkit : chromium;
const browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext(mobile ? devices['iPhone 13'] : { viewport: { width: 1280, height: 900 } });
    await context.addInitScript(({ settings, game }) => {
      if (localStorage.getItem('rating-settings-seeded')) return;
      localStorage.setItem('rating-settings-seeded', '1');
      localStorage.setItem('maia-coach.settings', JSON.stringify(settings));
      localStorage.setItem('maia-coach.game', JSON.stringify(game));
    }, { settings, game });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.locator('#home-elo').press('End');
    await page.locator('#btn-settings').click();
    const input = page.locator('[name="playerElo"]');
    assert.equal(await input.isEnabled(), true, 'An unfinished game must not disable the starting-rating input');
    await page.locator('#btn-rating-reset').click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('maia-coach.settings')).playerElo), 1500, 'Reset must not alter rating while a standard game is active');
    await input.fill('900');
    if (mobile) {
      const viewport = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, scale: visualViewport?.scale ?? 1 }));
      assert.ok(viewport.documentWidth <= viewport.width, `Settings must not shift horizontally after focusing player rating: ${JSON.stringify(viewport)}`);
      assert.ok(viewport.scale <= 1.01, `iOS must not auto-zoom the focused rating field: ${JSON.stringify(viewport)}`);
    }
    await page.locator('#settings .appbar #btn-settings-save').waitFor({ state: 'visible' });
    await page.locator('#settings .appbar #btn-settings-save').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('maia-coach.settings')).playerElo === 900);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('maia-coach.settings')));
    assert.deepEqual(
      { player: saved.playerElo, opponent: saved.elo, deviation: saved.ratingDeviation, streak: saved.ratingStreak, games: saved.ratedGames },
      { player: 900, opponent: 2600, deviation: 350, streak: 0, games: 20 },
    );
    const liveSnapshot = await page.evaluate(() => JSON.parse(localStorage.getItem('maia-coach.game')));
    assert.deepEqual(
      { id: liveSnapshot.id, tree: liveSnapshot.tree, result: liveSnapshot.result, elo: liveSnapshot.elo, playerElo: liveSnapshot.playerElo, ratingDeviation: liveSnapshot.ratingDeviation, ratingStreak: liveSnapshot.ratingStreak },
      { id: game.id, tree: game.tree, result: game.result, elo: game.elo, playerElo: game.playerElo, ratingDeviation: game.ratingDeviation, ratingStreak: game.ratingStreak },
      'Editing the next starting rating must preserve the live game snapshot',
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#btn-settings').click();
    const reloadInput = page.locator('[name="playerElo"]');
    assert.equal(await reloadInput.inputValue(), '900', 'The saved starting rating must survive a reload');
    await reloadInput.fill('1000');
    await page.locator('#btn-settings-back').click();
    await page.locator('#settings').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('maia-coach.settings')).playerElo), 900, 'Cancelling must not save an edit');
    await page.locator('#btn-continue').click();
    await page.locator('#btn-menu-top:visible, #btn-menu:visible').first().click();
    page.on('dialog', dialog => dialog.accept());
    await page.locator('#btn-resign').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('maia-coach.game')).result === '0-1');
    const unchanged = await page.evaluate(() => JSON.parse(localStorage.getItem('maia-coach.settings')));
    assert.equal(unchanged.playerElo, 900, 'An old game must not overwrite a newly entered starting estimate');
    assert.equal(unchanged.elo, 2600, 'An old game must not change the fixed next-game opponent');
    assert.equal(unchanged.ratedGames, 20);
    assert.deepEqual(errors, []);
    console.log(`PASS: ${mobile ? 'iPhone' : 'desktop'} starting-rating edit, persistence, cancellation and live snapshot`);
    await context.close();
  }
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const seedSettings = { ...settings, elo: 1900, playerElo: 1765, ratingDeviation: 92, ratingStreak: -2, ratedGames: 23 };
    await context.addInitScript(settings => localStorage.setItem('maia-coach.settings', JSON.stringify(settings)), seedSettings);
    const page = await context.newPage();
    page.on('dialog', dialog => dialog.accept());
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.locator('#btn-settings').click();
    await page.locator('#btn-rating-reset').click();
    await page.waitForFunction(() => {
      const s = JSON.parse(localStorage.getItem('maia-coach.settings'));
      return s.playerElo === 1500 && s.ratingDeviation === 350 && s.ratingStreak === 0 && s.ratedGames === 0;
    });
    const reset = await page.evaluate(() => JSON.parse(localStorage.getItem('maia-coach.settings')));
    assert.equal(reset.elo, 1900, 'Reset must preserve the Maia opponent level');
    assert.equal(await page.locator('[name="playerElo"]').inputValue(), '1500', 'The settings form must reflect the persisted reset');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#btn-settings').click();
    assert.equal(await page.locator('[name="playerElo"]').inputValue(), '1500', 'The reset rating must persist across reloads');
    await context.close();
  }
  for (const scenario of ['legacy-disabled', 'legacy-no-player-snapshot', 'assisted', 'nonstandard', 'imported']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const seedSettings = { ...settings, elo: 1500, ratingStreak: 0 };
    const seedGame = { ...game, id: scenario, elo: 1500, ratingStreak: 0 };
    if (scenario === 'legacy-no-player-snapshot') delete seedGame.playerElo;
    if (scenario === 'assisted') seedGame.assists = { undo: 0, hint: 1 };
    if (scenario === 'nonstandard') seedGame.startFen = game.startFen.replace(' 0 1', ' 0 2');
    if (scenario === 'imported') seedGame.imported = true;
    await context.addInitScript(({ settings, game }) => {
      if (localStorage.getItem('rating-scenario-seeded')) return;
      localStorage.setItem('rating-scenario-seeded', '1');
      localStorage.setItem('maia-coach.settings', JSON.stringify(settings));
      localStorage.setItem('maia-coach.game', JSON.stringify(game));
    }, { settings: seedSettings, game: seedGame });
    const page = await context.newPage();
    page.on('dialog', dialog => dialog.accept());
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.locator('#btn-continue').click();
    if (scenario === 'imported') {
      await page.locator('#game[data-mode="review"] #tab-review').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#btn-resign').isVisible(), false, 'Imported review must not offer an action that changes the game result');
      const unchanged = await page.evaluate(() => ({ settings: JSON.parse(localStorage.getItem('maia-coach.settings')), game: JSON.parse(localStorage.getItem('maia-coach.game')) }));
      assert.equal(unchanged.settings.ratedGames, 20);
      assert.equal(unchanged.settings.playerElo, 1500);
      assert.equal(unchanged.game.rating, undefined);
      console.log('PASS: imported review preserves rating and offers no resignation');
      if (await page.locator('#btn-report-free').isVisible()) await page.locator('#btn-report-free').click();
      await page.waitForFunction(() => Math.abs(document.querySelector('#game').getBoundingClientRect().left) < 0.5);
      for (const [width, height] of [[360, 640], [390, 844], [430, 740], [390, 640]]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const visibility = await page.locator('#board cg-board').evaluate(board => {
          const bounds = board.getBoundingClientRect();
          const side = document.querySelector('.side').getBoundingClientRect();
          const panel = document.querySelector('.panel').getBoundingClientRect();
          const safeBottom = parseFloat(getComputedStyle(document.querySelector('.side')).paddingBottom);
          const covered = [];
          for (const row of [0, 3, 7]) for (const file of [0, 3, 7]) {
            const x = bounds.left + (file + 0.5) * bounds.width / 8;
            const y = bounds.top + (row + 0.5) * bounds.height / 8;
            if (!document.elementFromPoint(x, y)?.closest('#board')) covered.push([file, row]);
          }
          return { offset: bounds.left + bounds.width / 2 - innerWidth / 2,
            bottom: bounds.bottom, top: bounds.top, sideTop: side.top, sideBottom: side.bottom,
            panelBottom: panel.bottom, safeBottom, viewportHeight: innerHeight, covered };
        });
        assert.ok(Math.abs(visibility.offset) <= 2, `Review board must stay centered at ${width}x${height}; offset ${visibility.offset}px`);
        assert.ok(visibility.top >= 0 && visibility.bottom <= visibility.viewportHeight, `Whole board must fit the viewport: ${JSON.stringify(visibility)}`);
        assert.ok(visibility.sideTop >= visibility.bottom, `Review panel must start below the board: ${JSON.stringify(visibility)}`);
        assert.deepEqual(visibility.covered, [], `All board regions must remain visible and touchable at ${width}x${height}`);
        assert.ok(Math.abs(visibility.sideBottom - height) <= 1, `Review must not reserve space for a hidden toolbar: ${JSON.stringify(visibility)}`);
        assert.ok(Math.abs(visibility.panelBottom + visibility.safeBottom - height) <= 1, `Analysis scroll area must reach the bottom safe area: ${JSON.stringify(visibility)}`);
      }
      console.log('PASS: mobile free-review board stays centered across viewport and browser-height changes');
      await context.close();
      continue;
    }
    await page.locator('#btn-menu-top:visible, #btn-menu:visible').first().click();
    await page.locator('#btn-resign').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('maia-coach.game')).result === '0-1');
    const settled = await page.evaluate(() => ({ settings: JSON.parse(localStorage.getItem('maia-coach.settings')), game: JSON.parse(localStorage.getItem('maia-coach.game')) }));
    const rated = scenario === 'legacy-disabled' || scenario === 'legacy-no-player-snapshot' || scenario === 'assisted';
    assert.equal(settled.settings.elo, 1500, `${scenario}: the fixed opponent must never move after a result`);
    assert.equal(settled.settings.ratedGames, rated ? 21 : 20);
    assert.equal(Boolean(settled.game.rating), rated);
    if (rated) assert.ok(settled.settings.playerElo < 1500, `${scenario}: an eligible game must update the player estimate`);
    if (scenario === 'assisted') assert.ok(settled.game.rating?.calculation?.evidence, 'Assisted games still settle with observable assistance evidence');
    else assert.equal(settled.settings.playerElo, 1500, `${scenario}: assisted/nonstandard games must not rate`);
    console.log(`PASS: ${scenario} rating eligibility and fixed opponent`);
    await context.close();
  }
} finally {
  await browser.close();
}
