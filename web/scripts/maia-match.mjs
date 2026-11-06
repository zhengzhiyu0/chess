#!/usr/bin/env node
// Real full games; no engine move override, opening book, or evaluation adjudication.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Chess } from 'chess.js';
import * as ort from 'onnxruntime-node';
import { buildTokens, FEAT, legalMoveIndices } from '../src/maia/encode.ts';
import { softmaxMoves, sampleMove } from '../src/maia/sample.ts';
import { terminalOf } from '../src/game/rules.ts';
import { seededRandom } from './human-bench-data.mjs';
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => i % 2 ? a : [...a, [v.replace(/^--/, ''), all[i + 1]]], []));
if (process.argv.includes('--help')) {
    console.log('node scripts/maia-match.mjs --model-root public/models --pairs 600:800,800:1000,600:1500 --repeats 2 --max-plies 1000 --out ../tmp/maia-match');
    process.exit(0);
}
const allowed = ['model-root', 'pairs', 'repeats', 'max-plies', 'out', 'seed'];
if (process.argv.slice(2).length % 2 || Object.keys(args).some(k => !allowed.includes(k)))
    throw Error('Unknown or missing argument');
const pairs = (args.pairs ?? '600:800,800:1000,600:1500').split(',').map(p => p.split(':').map(Number));
const repeats = Number(args.repeats ?? 2), maxPlies = Number(args['max-plies'] ?? 1000), seed = Number(args.seed ?? 20261106);
if (!Number.isInteger(repeats) || repeats < 1 || !Number.isInteger(maxPlies) || maxPlies < 1 || !Number.isInteger(seed) || pairs.some(p => p.length !== 2 || p[0] >= p[1] || p.some(r => !Number.isInteger(r) || r < 600 || r > 2600)))
    throw Error('Invalid match options');
const output = resolve(args.out ?? '../tmp/maia-match');
await mkdir(dirname(output), { recursive: true });
const modelDir = resolve(args['model-root'] ?? 'public/models', 'maia3-79m');
const manifest = JSON.parse(await readFile(join(modelDir, 'manifest.json'), 'utf8'));
const bytes = Buffer.concat(await Promise.all(manifest.parts.map(p => readFile(join(modelDir, p)))));
const hash = createHash('sha256').update(bytes).digest('hex');
if (hash !== manifest.sha256 || bytes.length !== manifest.size)
    throw Error('Model integrity failure');
const implementation = {};
for (const f of ['scripts/maia-match.mjs', 'src/maia/encode.ts', 'src/maia/sample.ts', 'src/game/rules.ts'])
    implementation[f] = createHash('sha256').update(await readFile(f)).digest('hex');
const config = { modelHash: hash, modelRoot: modelDir, pairs, repeats, maxPlies, seed, temperature: 1, topP: 1, history: false, threads: 1, timeControl: 'none', implementation };
const signature = createHash('sha256').update(JSON.stringify(config)).digest('hex');
let games = [];
try {
    const old = JSON.parse(await readFile(output + '.json', 'utf8'));
    if (old.signature !== signature && JSON.stringify({ ...old.config, repeats }) !== JSON.stringify(config))
        throw Error('Resume configuration mismatch');
    games = old.games.map(g => ({ ...g, implementation: g.implementation ?? old.config.implementation }));
}
catch (e) {
    if (e.code !== 'ENOENT')
        throw e;
}
function scoreFor(game, rating) {
    return game.result === '1/2-1/2' ? 0.5 : Number((game.result === '1-0') === (game.white === rating));
}
function sideScore(rows, high) {
    return rows.length ? rows.reduce((sum, game) => sum + scoreFor(game, high), 0) / rows.length : null;
}
function summary() {
    return pairs.map(([low, high]) => {
        const rows = games.filter(game => game.low === low && game.high === high);
        const complete = rows.filter(game => game.result !== '*');
        const scores = complete.map(game => scoreFor(game, high));
        return {
            low, high, games: rows.length, completed: complete.length, censored: rows.length - complete.length,
            highWins: scores.filter(score => score === 1).length,
            draws: scores.filter(score => score === 0.5).length,
            highLosses: scores.filter(score => score === 0).length,
            highScore: sideScore(complete, high),
            highWhiteScore: sideScore(complete.filter(game => game.white === high), high),
            highBlackScore: sideScore(complete.filter(game => game.white !== high), high),
        };
    });
}
async function checkpoint() {
    const report = { signature, config, runtime: { node: process.version, ort: ort.env.versions, platform: process.platform },
        generatedAt: new Date().toISOString(), games, summary: summary() };
    await writeFile(output + '.json', JSON.stringify(report, null, 2) + '\n');
    await writeFile(output + '.pgn', games.map(game => game.pgn).join('\n\n') + '\n');
    const lines = [
        '# Maia 79M 完整对局实验', '', `模型 SHA-256: ${hash}`,
        `每组 ${repeats} 对交替执色；temperature=1, topP=1, history=off, 不限时。`,
        '只按产品终局规则结束，不使用 Stockfish 裁判；达到半回合上限标为未完成，不记和棋。',
        '这是档位相对强度的探索样本，不能校准真人 Elo，也不构成显著性或精度保证。',
        '小样本可能受开局、执色和随机性影响；应扩大样本后再调整档位。', '',
        '|低档|高档|完成|高档胜/和/负|高档得分率|未完成|', '|---|---|---|---|---|---|',
        ...summary().map(row => `|${row.low}|${row.high}|${row.completed}|${row.highWins}/${row.draws}/${row.highLosses}|${row.highScore === null ? '—' : (100 * row.highScore).toFixed(1) + '%'}|${row.censored}|`), '',
        '每局完整着法、双方等级、seed、终局原因及 PGN 见同名 JSON/PGN。', '',
        'Windows ONNX CPU 实验；fp16 来源不等于已验证 iPhone CoreML 实机行为。',
    ];
    await writeFile(output + '.md', lines.join('\n'));
}
console.log('Loading real 79M', hash);
const session = await ort.InferenceSession.create(bytes, { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential', graphOptimizationLevel: 'all' });
try {
    for (const [low, high] of pairs)
        for (let repeat = 0; repeat < repeats; repeat++)
            for (let swap = 0; swap < 2; swap++) {
                const id = `${low}-${high}-${repeat}-${swap}`;
                if (games.some(g => g.id === id))
                    continue;
                const white = swap ? high : low, black = swap ? low : high, gameSeed = (seed + Math.imul(low, 31) + Math.imul(high, 131) + Math.imul(repeat + 1, 0x9e3779b1)) >>> 0;
                const random = seededRandom(gameSeed), board = new Chess(), fens = [board.fen()], moves = [];
                const start = performance.now();
                let end = null;
                while (!(end = terminalOf(fens)) && moves.length < maxPlies) {
                    const self = board.turn() === 'w' ? white : black, oppo = board.turn() === 'w' ? black : white;
                    const out = await session.run({ tokens: new ort.Tensor('float32', buildTokens([board.fen()]), [1, 64, FEAT]), self_elo: new ort.Tensor('float32', Float32Array.of(self), [1]), oppo_elo: new ort.Tensor('float32', Float32Array.of(oppo), [1]) });
                    const legal = legalMoveIndices(board).map(m => ({ uci: m.uci, logit: Number(out.logits_move.data[m.index]) }));
                    if (!legal.length || legal.some(m => !Number.isFinite(m.logit)))
                        throw Error('Invalid legal policy');
                    const uci = sampleMove(softmaxMoves(legal), 1, 1, random).uci;
                    board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
                    moves.push(uci);
                    fens.push(board.fen());
                    if (moves.length % 100 === 0)
                        console.log(id, 'ply', moves.length);
                }
                const result = end?.result ?? '*', reason = end?.reason ?? 'max-plies';
                board.setHeader('White', `Maia79M ${white}`);
                board.setHeader('Black', `Maia79M ${black}`);
                board.setHeader('Result', result);
                board.setHeader('TimeControl', '-');
                board.setHeader('Termination', reason);
                const pgn = board.pgn();
                const replay = new Chess();
                replay.loadPgn(pgn);
                if (replay.fen() !== board.fen())
                    throw Error('PGN roundtrip failure');
                games.push({ implementation, id, low, high, white, black, seed: gameSeed, result, reason, plies: moves.length, ms: performance.now() - start, moves, finalFen: board.fen(), pgn });
                await checkpoint();
                console.log(id, result, reason, moves.length, 'plies');
            }
}
finally {
    await session.release();
}
console.log('Saved', output + '.md');
