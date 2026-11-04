// Run after a release Web build and `node scripts/serve.mjs`.
// All storage is isolated in a disposable browser context; no user data is read.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../web/node_modules/playwright/index.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = process.env.FLUTTER_PREVIEW_URL ?? 'http://127.0.0.1:5290';
const output = resolve(app, 'reports');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
const errors = [], external = [], checks = [];
await context.route('**/*', route => {
  const url = route.request().url();
  if (url.startsWith('http') && new URL(url).origin !== new URL(origin).origin) {
    external.push(url);
    return route.abort();
  }
  return route.continue();
});
await context.addInitScript(() => {
  if (!localStorage.getItem('smoke-seeded')) {
    localStorage.setItem('flutter.maia-coach.settings', JSON.stringify(JSON.stringify({
      model: '5m', sfLite: true, sfHash: 16, sfMovetime: 200,
      sound: false, haptics: false, thinkDelay: false,
    })));
    localStorage.setItem('smoke-seeded', '1');
  }
});
const page = await context.newPage();
page.setDefaultTimeout(30000);
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => {
  if (m.text().includes('[engine/')) console.log(m.text());
  if (m.type() === 'error' && /overflow|exception|error|failed/i.test(m.text())) errors.push(m.text());
});
const text = () => page.locator('body').innerText();
const click = (name) => page.getByRole('button', { name, exact: typeof name === 'string' }).dispatchEvent('click');
const state = () => page.evaluate(() => JSON.parse(JSON.parse(localStorage.getItem('flutter.maia-coach.flutter.domain.v1')))?.data);
const mark = message => { checks.push(message); console.log(`PASS ${message}`); };
async function semantics() {
  await page.waitForSelector('flt-semantics-placeholder');
  await page.evaluate(() => {
    const node = document.querySelector('flt-semantics-placeholder');
    node.click();
    for (const type of ['pointerdown', 'pointerup']) {
      node.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: 'mouse' }));
    }
  });
  await page.getByRole('heading', { name: /MAIA COACH/ }).waitFor();
}
async function square(from, to) {
  await click(new RegExp(`^${from}，`));
  await click(new RegExp(`^${to}，.*合法目标`));
}
async function importFen(fen) {
  await click('对局菜单');
  await click('导入 PGN / FEN');
  await page.getByRole('textbox').fill(fen);
  await click('导入');
}
try {
  await page.goto(origin);
  console.log('UI loaded, enabling semantics');
  await semantics();
  console.log('Semantics ready, waiting for engines');
  await page.waitForFunction(() => {
    const s = JSON.parse(globalThis.maiaFlutter.state());
    return s.maiaReady && s.stockfishReady;
  }, {}, { timeout: 120000 });
  assert.match(await text(), /下一步，更进一步/);
  await page.screenshot({ path: resolve(output, 'home-mobile.png') });
  mark('mobile home and real engines ready with external network blocked');

  await click(/开始对局/);
  await square('e2', 'e4');
  await page.waitForFunction(() => document.body.innerText.includes('轮到你走棋'));
  const played = await state();
  assert.equal(played.currentGame.result, '');
  await page.screenshot({ path: resolve(output, 'play-mobile.png') });
  mark('e2e4 and real Maia reply committed');

  await click('提示');
  await click('继续');
  await page.waitForFunction(() => document.body.innerText.includes('建议：'));
  assert.equal((await state()).currentGame.assists.aids, true);
  await click('悔棋');
  await page.waitForFunction(() => !document.body.innerText.includes('1. e4'));
  mark('hint converts to practice and undo restores the opening');

  await click('认输');
  await click('继续');
  await page.getByRole('button', { name: '开始复盘', exact: true }).waitFor();
  assert.equal((await state()).history.length, 1);
  await click('开始复盘');
  await page.getByRole('heading', { name: '自由复盘', exact: true }).waitFor();
  const durable = JSON.stringify((await state()).currentGame);
  await square('d2', 'd4');
  await click('返回首页');
  assert.equal(JSON.stringify((await state()).currentGame), durable);
  mark('resign saves history; review exploration does not change the stored game');

  await click(/开始对局/);
  await importFen('8/P7/8/8/8/8/8/k6K w - - 0 1');
  await square('a7', 'a8');
  for (const role of ['后', '车', '象', '马']) {
    await page.getByRole('button', { name: `升变为${role}`, exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: `升变为${role}`, exact: true }).count(), 1);
  }
  await page.screenshot({ path: resolve(output, 'promotion-mobile.png') });
  await click('升变为后');
  await page.waitForFunction(() => document.body.innerText.includes('a8=Q+'));
  mark('all four promotion images and queen promotion');

  await click('返回首页');
  await page.getByRole('tab', { name: '训练', exact: true }).dispatchEvent('click');
  await click('综合战术练习');
  await page.waitForFunction(() => document.body.innerText.includes('找出最佳着法'));
  await click('显示提示');
  await page.waitForFunction(() => document.body.innerText.includes('参考着法：'));
  assert.equal((await state()).puzzles.failed, 1);
  await page.screenshot({ path: resolve(output, 'training-mobile.png') });
  mark('offline puzzle database, hint and training persistence');

  await click('返回首页');
  await click('设置');
  // Use Flutter semantics' native select role, exposed as a button.
  const themeButton = page.getByRole('button', { name: /界面主题/ });
  if (await themeButton.count()) {
    await themeButton.dispatchEvent('click');
    await page.getByRole('menuitem', { name: '浅色', exact: true }).dispatchEvent('click');
    await page.waitForFunction(() => {
      const data = JSON.parse(JSON.parse(localStorage.getItem('flutter.maia-coach.flutter.domain.v1'))).data;
      return data.settings.theme === 'light';
    });
    mark('light theme persists');
  }
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: resolve(output, 'home-desktop.png') });
  mark('1280x800 responsive layout');

  await page.reload();
  await semantics();
  await page.getByRole('button', { name: /继续对局/ }).waitFor();
  assert.equal((await state()).history.length, 1);
  mark('reload keeps the unfinished game, history and puzzle progress');
  assert.deepEqual(external, [], 'Runtime must not request external fonts or resources');
  assert.deepEqual(errors, [], 'Browser must not report errors or layout overflows');
  await writeFile(resolve(output, 'ui-smoke.json'), JSON.stringify({ checks, errors, external, viewport: [390, 844] }, null, 2));
  console.log(`${checks.length} UI checks passed.`);
} catch (error) {
  console.error('Errors:', errors, 'External:', external);
  await page.screenshot({ path: resolve(output, 'ui-smoke-failure.png') }).catch(() => {});
  console.error((await text()).slice(-7000));
  throw error;
} finally {
  await context.close();
  await browser.close();
}
