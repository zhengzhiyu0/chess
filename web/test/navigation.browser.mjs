// Run against the dev server: node test/navigation.browser.mjs http://127.0.0.1:5173
// Deterministic engines keep this focused on navigation and persistence.
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright';

const baseURL = process.argv[2] ?? 'http://127.0.0.1:5173';
const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const serialize = (moves) => moves.reduceRight((next, u) => ({ c: [{ u, ...next }] }), {});
const live = {
  id: 'live-navigation', date: 3, startFen,
  tree: serialize(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6']),
  userColor: 'w', result: '', elo: 1500, tc: '5+3', clock: [200000, 210000], peak: 3,
};
const games = [
  { id: 'history-mate', date: 2, startFen, tree: serialize(['f2f3', 'e7e5', 'g2g4', 'd8h4']), userColor: 'w', result: '0-1', elo: 1500 },
  { id: 'history-draw', date: 1, startFen, tree: serialize(['d2d4', 'd7d5']), userColor: 'w', result: '1/2-1/2', elo: 1500 },
];
const fakeEngines = `
import { Chess } from '/node_modules/chess.js/dist/esm/chess.js';
const uci = m => m.from + m.to + (m.promotion ?? '');
const maia = {
  alive: true,
  async evaluate(c) {
    const moves = c.moves({verbose:true}).map(m => ({uci:uci(m), p:1}));
    return { moves: moves.map(m => ({...m,p:1/moves.length})), wdl:[.3,.4,.3], ms:1 };
  },
  async evaluateMany(jobs) { return Promise.all(jobs.map(job => this.evaluate(job.chess))); },
};
const sf = {
  alive: true, lite: true,
  async analyse(fen, opts = {}) {
    const c = new Chess(fen);
    for (const m of opts.moves ?? []) c.move({from:m.slice(0,2),to:m.slice(2,4),promotion:m[4]});
    const move = c.moves({verbose:true})[0];
    const bestmove = move ? uci(move) : null;
    const whiteCp = (opts.moves ?? []).includes('f2f3') ? -500 : 0;
    const lines = bestmove ? [{multipv:1,depth:18,cp:c.turn()==='w'?whiteCp:-whiteCp,pv:[bestmove]}] : [];
    return {lines,bestmove};
  },
};
export class Engines {
  maia = maia; sf = sf;
  readyForGame() { return true; }
  async prepareGame() {}
  async warmup() {}
  async getMaia() { return maia; }
  async getSf() { return sf; }
  unloadMaia() {}
  unloadSf() {}
}`;

const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
let activePage;
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext(mobile ? devices['iPhone 13'] : { viewport: { width: 1280, height: 900 } });
    await context.route('**/src/app/engines.ts*', route => route.fulfill({ contentType: 'application/javascript', body: fakeEngines }));
    await context.route('**/src/coach/book.ts*', route => route.fulfill({ contentType: 'application/javascript', body: 'export const bookReady = () => true; export const inBook = () => false; export const loadBook = async () => {};' }));
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(12000);
    const openMenu = async () => {
      if (!mobile && await page.locator('#report:not(.hidden)').isVisible()) await page.locator('#btn-report-start').click();
      await page.locator('#btn-menu-top:visible, #btn-menu:visible').first().click();
    };
    const errors = [];
    const dialogs = [];
    page.on('pageerror', err => errors.push(err.message));
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await context.addInitScript(({ live, games }) => {
      if (localStorage.getItem('navigation-seeded')) return;
      localStorage.clear();
      localStorage.setItem('navigation-seeded', 'true');
      localStorage.setItem('maia-coach.game', JSON.stringify(live));
      localStorage.setItem('maia-coach.history', JSON.stringify(games));
      localStorage.setItem('maia-coach.settings', JSON.stringify({
        elo:1500, autoElo:true, ratedGames:20, color:'w', gameType:'normal',
        autoOffline:false, thinkDelay:false, sound:false, opponentTalk:true, sfLite:true, coachAvatar:3,
      }));
    }, { live, games });
    await page.goto(baseURL);
    assert.deepEqual(errors, []);
    assert.equal(await page.locator('#btn-continue').isEnabled(), true, JSON.stringify(await page.evaluate(() => ({saved:localStorage.getItem('maia-coach.game'),sub:document.querySelector('#continue-sub').textContent}))));
    await page.locator('#btn-continue').click();
    await openMenu();
    await page.locator('#btn-menu-history').click();
    await page.locator('[data-id="history-mate"]').click();
    await page.locator('[data-learning-jump]').first().waitFor();
    const explanation = page.locator('.learning-issue > p').first();
    assert.ok(await explanation.locator('b').count() > 0, 'SAN in the explanation should render in bold');
    assert.doesNotMatch(await page.locator('#learning-report-summary').textContent(), /<\/?b>/, 'Learning insights should not display raw markup');
    const activeSaved = () => page.evaluate(() => JSON.parse(localStorage.getItem('maia-coach.game')));
    assert.equal((await activeSaved()).id, live.id);
    assert.equal((await activeSaved()).result, '');
    assert.deepEqual((await activeSaved()).tree, live.tree);

    // Learning-summary drilldown returns to the same report, for both back mechanisms.
    for (const back of ['button', 'browser', ...(mobile ? ['gesture'] : [])]) {
      await page.locator('[data-learning-jump]').first().click();
      await page.locator('#report.hidden').waitFor({ state: 'attached' });
      assert.equal(await page.locator('#btn-back').getAttribute('aria-label'), '返回复盘结果');
      if (back === 'button') await page.locator('#btn-back').click();
      else if (back === 'browser') await page.goBack();
      else await page.evaluate(() => {
        const target = document.querySelector('#game');
        const touch = x => new Touch({ identifier:1, target, clientX:x, clientY:200 });
        target.dispatchEvent(new TouchEvent('touchstart', {bubbles:true,touches:[touch(5)]}));
        target.dispatchEvent(new TouchEvent('touchmove', {bubbles:true,cancelable:true,touches:[touch(180)]}));
        target.dispatchEvent(new TouchEvent('touchend', {bubbles:true,touches:[],changedTouches:[touch(180)]}));
      });
      await page.locator('#report:not(.hidden)').waitFor();
      assert.equal(await page.locator('#game.active').count(), 1);
    }

    // Opening another record must not replace the suspended game either.
    await openMenu();
    await page.locator('#btn-menu-history').click();
    await page.locator('[data-id="history-draw"]').click();
    assert.equal((await activeSaved()).id, live.id);
    await page.locator('#btn-back').click();
    await page.locator('#home.active').waitFor();
    assert.equal(await page.locator('#continue-title').textContent(), '继续对局');
    await page.locator('#btn-continue').click();
    assert.equal(await page.locator('#game').getAttribute('data-mode'), 'play');
    assert.equal(await page.locator('#moves .mv').count(), 6);
    const saved = await activeSaved();
    assert.equal(saved.id, live.id);
    assert.equal(saved.result, '');
    assert.ok(saved.clock[0] > 190000);
    assert.equal(saved.clock[1], live.clock[1]);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('maia-coach.history')).map(g => ({id:g.id,result:g.result,tree:g.tree}))), games.map(({id,result,tree}) => ({id,result,tree})));

    // Make a legal move and check that the reply uses the player's opponent portrait.
    const bounds = await page.locator('#board cg-board').boundingBox();
    const square = (file, rank) => ({ x:bounds.x+(file+.5)*bounds.width/8, y:bounds.y+(8-rank+.5)*bounds.height/8 });
    await page.mouse.click(square(3, 2).x, square(3, 2).y);
    await page.mouse.click(square(3, 3).x, square(3, 3).y);
    await page.locator('#opponent-dialogue.show .avatar.coach').waitFor();
    if (process.env.NAVIGATION_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.NAVIGATION_SCREENSHOT_DIR}/opponent-${mobile ? 'iphone' : 'desktop'}.png`, animations: 'disabled' });
    const portrait = await page.locator('#opponent-dialogue .avatar').innerHTML();
    assert.equal(portrait, await page.locator('#player-top .avatar').innerHTML());
    assert.ok((await page.locator('.opponent-line').textContent()).length > 0);
    assert.equal(await page.locator('#opponent-dialogue').evaluate(el => getComputedStyle(el, '::before').content), 'none');

    // Refreshing during history review resumes the original live game.
    await openMenu();
    await page.locator('#btn-menu-history').click();
    await page.locator('[data-id="history-mate"]').click();
    await page.reload();
    await page.locator('#game[data-mode="play"]').waitFor();
    assert.equal((await activeSaved()).id, live.id);
    assert.equal((await activeSaved()).result, '');
    assert.deepEqual(dialogs, []);
    assert.deepEqual(errors, []);
    console.log(mobile ? 'PASS: iPhone navigation, resume, report back and portrait' : 'PASS: desktop navigation, resume, report back and portrait');
    await context.close();
  }
} catch (err) {
  console.error(await activePage?.evaluate(() => ({ summary:document.querySelector('#learning-report-summary')?.outerHTML, hint:document.querySelector('#report-hint')?.textContent, status:document.querySelector('#status')?.textContent })));
  throw err;
} finally {
  await browser.close();
}
