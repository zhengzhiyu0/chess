// Actual browser engines, no AI mocks. Uses original public engine/model files
// read-only, so this test also works before the Flutter asset-copy/build step.
import assert from 'node:assert/strict';
import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../web/node_modules/playwright/index.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const golden = JSON.parse(readFileSync(resolve(repo, 'web/test/golden.json'), 'utf8'));
const requests = [];
const errors = [];
const model = process.env.MAIA_MODEL ?? '5m';
const lite = process.env.STOCKFISH_LITE !== 'false';
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cache-Control', 'no-store');
  const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (path.includes('..')) { response.writeHead(403).end(); return; }
  if (path === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html><head><base href="/"><link rel="icon" href="data:,"></head><body><script type="module">await import("/engine/bridge.js");</script></body></html>');
    return;
  }
  const file = path.startsWith('/engine/')
    ? resolve(repo, 'flutter_app/web', `.${path}`)
    : resolve(repo, 'web/public', `.${path}`);
  try {
    const info = await stat(file);
    response.writeHead(200, { 'Content-Type': { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' }[extname(file)] ?? 'application/octet-stream', 'Content-Length': info.size });
    createReadStream(file).pipe(response);
  } catch { response.writeHead(404).end(path); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
try {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  page.on('console', message => {
    if (message.type() === 'error') console.error('browser:', message.text());
    else if (message.text().startsWith('[engine/')) console.log(message.text());
  });
  await page.goto(origin);
  await page.waitForFunction(() => !!globalThis.maiaFlutter);
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  const state = await page.evaluate(async ({ model, lite }) => {
    const options = JSON.stringify({ model, threads: 2, hash: 16, lite });
    const [a, b] = await Promise.all([maiaFlutter.initialize(options), maiaFlutter.initialize(options)]);
    return { a: JSON.parse(a), b: JSON.parse(b) };
  }, { model, lite });
  assert.equal(state.a.maiaReady, true);
  assert.equal(state.a.stockfishReady, true);
  const inference = await page.evaluate(async fen => JSON.parse(await maiaFlutter.predict(JSON.stringify({ fen, selfElo: 1500, opponentElo: 1500 }))), start);
  const expected = golden.cases.find(c => c.name === 'startpos' && c.model === model);
  assert.equal(inference.moves.length, 20);
  assert.equal(inference.moves[0].uci, expected.top[0].uci);
  assert.ok(Math.abs(inference.moves[0].p - expected.top[0].p) < 0.002);
  inference.wdl.forEach((p, i) => assert.ok(Math.abs(p - expected.wdl[i]) < 0.002));
  for (const name of ['white promotion fen', 'black promotion fen']) {
    const c = golden.cases.find(c => c.name === name && c.model === model);
    const result = await page.evaluate(async fen => JSON.parse(await maiaFlutter.predict(JSON.stringify({ fen, selfElo: 1500, opponentElo: 1500 }))), c.fen);
    assert.ok(result.moves.some(m => m.uci.length === 5));
    assert.equal(result.moves[0].uci, c.top[0].uci);
  }
  const analysis = await page.evaluate(async fen => JSON.parse(await maiaFlutter.analyse(JSON.stringify({ fen, milliseconds: 150, multipv: 3 }))), start);
  assert.ok(analysis.bestmove);
  assert.equal(analysis.lines.length, 3);
  assert.ok(analysis.lines.every(line => line.depth > 0 && line.pv.length));
  const cancel = await page.evaluate(async fen => {
    const first = maiaFlutter.analyse(JSON.stringify({ fen, milliseconds: 10000, multipv: 1 }));
    await new Promise(resolve => setTimeout(resolve, 100));
    const stopping = maiaFlutter.stop();
    const second = maiaFlutter.analyse(JSON.stringify({ fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', startFen: fen, moves: ['e2e4'], milliseconds: 100, multipv: 2 }));
    await stopping;
    return { first: JSON.parse(await first), second: JSON.parse(await second) };
  }, start);
  assert.equal(cancel.first.bestmove, null);
  assert.ok(cancel.second.bestmove);
  assert.equal(cancel.second.bestmove[1], '7');
  assert.equal(cancel.second.lines.length, 2);
  const reloaded = await page.evaluate(async ({ fen, model, lite }) => {
    await maiaFlutter.unloadMaia();
    const unloaded = JSON.parse(maiaFlutter.state());
    await maiaFlutter.initialize(JSON.stringify({ model, threads: 2, hash: 16, lite }));
    const prediction = JSON.parse(await maiaFlutter.predict(JSON.stringify({ fen, selfElo: 1500, opponentElo: 1500 })));
    await maiaFlutter.suspend();
    const suspended = JSON.parse(maiaFlutter.state());
    await maiaFlutter.initialize(JSON.stringify({ model, threads: 2, hash: 16, lite }));
    const resumed = JSON.parse(maiaFlutter.state());
    await maiaFlutter.dispose();
    return { unloaded, prediction, suspended, resumed, disposed: JSON.parse(maiaFlutter.state()) };
  }, { fen: start, model, lite });
  assert.equal(reloaded.unloaded.maiaReady, false);
  assert.equal(reloaded.prediction.moves[0].uci, 'e2e4');
  assert.equal(reloaded.suspended.maiaReady, false);
  assert.equal(reloaded.resumed.maiaReady, true);
  assert.equal(reloaded.disposed.stockfishReady, false);
  assert.equal(reloaded.disposed.maiaReady, false);
  assert.ok(requests.some(url => url.includes('.wasm')));
  assert.ok(requests.some(url => url.includes(`models/maia3-${model}/part`)));
  assert.ok(requests.every(url => url.startsWith(origin)));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, model, lite, inference: { top: inference.moves[0], wdl: inference.wdl, ms: inference.ms }, analysis: { bestmove: analysis.bestmove, depth: analysis.lines[0].depth }, requests: requests.length }, null, 2));
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
