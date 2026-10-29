// Run against the dev server: node test/rating-settings.browser.mjs http://127.0.0.1:5198
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright';

const baseURL = process.argv[2] ?? 'http://127.0.0.1:5173';
const settings = {
  elo: 1500, playerElo: 1500, ratingDeviation: 80, ratingStreak: 2, ratedGames: 20,
  autoElo: true, gameType: 'normal', model: '5m', autoOffline: false,
  sound: false, opponentTalk: false, sfLite: true, sfThreads: 1, sfHash: 16,
};
const game = {
  id: 'rating-settings-live', date: 1,
  startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  tree: { c: [{ u: 'e2e4', c: [{ u: 'e7e5' }] }] },
  userColor: 'w', result: '', elo: 1500, playerElo: 1500,
  ratingDeviation: 80, ratingStreak: 2, autoElo: true, temperature: 1, model: '5m', tc: 'none',
};
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
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
    await page.goto(baseURL);
    await page.locator('#btn-settings').click();
    const input = page.locator('[name="playerElo"]');
    assert.equal(await input.isEnabled(), true, 'An unfinished game must not disable the starting-rating input');
    await input.fill('900');
    await page.locator('#dlg-settings button[value="ok"]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('maia-coach.settings')).playerElo === 900);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('maia-coach.settings')));
    assert.deepEqual(
      { player: saved.playerElo, opponent: saved.elo, deviation: saved.ratingDeviation, streak: saved.ratingStreak, games: saved.ratedGames },
      { player: 900, opponent: 1500, deviation: 350, streak: 0, games: 20 },
    );
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('maia-coach.game'))), game, 'Editing the next starting rating must preserve the live game snapshot');
    await page.reload();
    await page.locator('#btn-settings').click();
    assert.equal(await input.inputValue(), '900', 'The saved starting rating must survive a reload');
    await input.fill('1000');
    await input.press('Escape');
    await page.locator('#dlg-settings').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('maia-coach.settings')).playerElo), 900, 'Cancelling must not save an edit');
    assert.deepEqual(errors, []);
    console.log(`PASS: ${mobile ? 'iPhone' : 'desktop'} starting-rating edit, persistence, cancellation and live snapshot`);
    await context.close();
  }
} finally {
  await browser.close();
}
