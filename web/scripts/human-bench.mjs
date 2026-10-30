#!/usr/bin/env node
// Requires Node >=22.18 (native TypeScript type stripping). No transpiled encoder copy.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { buildTokens, FEAT, legalMoveIndices } from '../src/maia/encode.ts';
import { samplingDistribution, sampleMove, softmaxMoves } from '../src/maia/sample.ts';
import { sha256, seededRandom, loadHumanGames, humanPositions, loadOpeningFamilies, identifyOpening, summarizeRollouts } from './human-bench-data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policies = [
  { name: 'baseline', temperature: 1, topP: 1 },
  { name: 'nucleus95', temperature: 1, topP: 0.95 },
  { name: 'sharp', temperature: 0.5, topP: 0.9 },
];
const usage = `真实 Maia 人类下一着与开局采样评测（非 Elo 校准）
用法：npm run bench:human -- [选项]
  --smoke                 小规模端到端：6 个真人局面、每策略 2 条 4 半回合开局
  --history               显式开启历史输入研究模式；默认关闭，与产品 useHistory=false 一致
  --models 5m,23m,79m      默认全部；可指定子集
  --positions 96          随机不放回的人类下一着局面数（最多为数据可用数）
  --rollouts 24            每模型、等级、策略的开局条数
  --plies 16              每条开局半回合数，默认 8 个完整回合
  --elos 1500             逗号分隔；开局双方等级输入相同，人类评测用原 PGN 双方等级
  --seed 20261030         uint32，固定 PRNG 和样本顺序
  --threads 1             ONNX Runtime CPU 线程数
  --model-root PATH       含 maia3-{size}/manifest.json 的目录，默认 public/models
  --out PATH              JSON/Markdown 输出前缀，默认 reports/human-bench
  --help                  显示帮助
策略固定比较 1/1、1/.95、.5/.9；Top-P 保留跨阈值的着法，复用应用同一实现。`;

function options(argv) {
  const allowed = new Set(['models', 'positions', 'rollouts', 'plies', 'elos', 'seed', 'threads', 'model-root', 'out']);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--smoke') args.smoke = true;
    else if (arg === '--history') args.history = true;
    else if (arg === '--help') args.help = true;
    else {
      const key = arg.slice(2);
      if (!arg.startsWith('--') || !allowed.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`未知或缺少值的参数：${arg}`);
      args[key] = argv[++i];
    }
  }
  const integer = (key, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
    const value = args[key] === undefined ? fallback : Number(args[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`--${key} 必须为 ${min}..${max} 整数`);
    return value;
  };
  const models = [...new Set((args.models ?? '5m,23m,79m').split(','))];
  if (!models.length || models.some((size) => !['5m', '23m', '79m'].includes(size))) throw new Error('--models 只支持 5m,23m,79m');
  const elos = [...new Set((args.elos ?? '1500').split(',').map(Number))];
  if (!elos.length || elos.some((elo) => !Number.isInteger(elo) || elo < 400 || elo > 3000)) throw new Error('--elos 必须为 400..3000 整数列表');
  return {
    help: !!args.help, smoke: !!args.smoke, history: !!args.history, models, elos,
    positions: integer('positions', args.smoke ? 6 : 96),
    rollouts: integer('rollouts', args.smoke ? 2 : 24),
    plies: integer('plies', args.smoke ? 4 : 16),
    seed: integer('seed', 20261030, 0, 0xffffffff), threads: integer('threads', 1),
    modelRoot: resolve(args['model-root'] ?? join(root, 'public/models')),
    out: resolve(args.out ?? join(root, 'reports/human-bench')),
  };
}

function tally() {
  return { count: 0, top1Hits: 0, top3Hits: 0, nllSum: 0, zeroSupport: 0 };
}

function addScore(total, rank, nll) {
  total.count++;
  if (rank === 1) total.top1Hits++;
  if (rank > 0 && rank <= 3) total.top3Hits++;
  if (nll === Infinity) total.zeroSupport++;
  else total.nllSum += nll;
}

function finishScore(total) {
  return {
    count: total.count,
    top1: total.top1Hits / total.count,
    top3: total.top3Hits / total.count,
    // A zero probability human move makes the true mean NLL infinite. Do not clip it.
    meanNllNats: total.zeroSupport ? null : total.nllSum / total.count,
    meanNllIsInfinite: total.zeroSupport > 0,
    zeroSupportCount: total.zeroSupport,
    supportCoverage: 1 - total.zeroSupport / total.count,
    meanNllOnSupportedOnly: total.count === total.zeroSupport ? null : total.nllSum / (total.count - total.zeroSupport),
  };
}

function eloBand(elo) {
  if (elo < 1200) return '<1200';
  if (elo < 1600) return '1200-1599';
  if (elo < 2000) return '1600-1999';
  return '>=2000';
}

async function loadModel(ort, size, opts) {
  const directory = join(opts.modelRoot, `maia3-${size}`);
  const manifestBytes = await readFile(join(directory, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const bytes = Buffer.allocUnsafe(manifest.size);
  let offset = 0;
  for (const part of manifest.parts) {
    const data = await readFile(join(directory, part));
    if (offset + data.length > bytes.length) throw new Error(`模型分片超出清单大小：${size}`);
    bytes.set(data, offset);
    offset += data.length;
  }
  const hash = sha256(bytes);
  if (offset !== manifest.size || hash !== manifest.sha256) throw new Error(`模型大小或 SHA-256 不符：${size}`);
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['cpu'], intraOpNumThreads: opts.threads, interOpNumThreads: 1,
    executionMode: 'sequential', graphOptimizationLevel: 'all',
  });
  return { session, metadata: { size, sha256: hash, bytes: bytes.length, manifestSha256: sha256(manifestBytes), executionProvider: 'cpu' } };
}

// Match main.ts maiaFens: the encoder repeats the current FEN when history is off.
const inputFens = (fens, history) => history ? fens.slice(-8) : [fens.at(-1)];

async function infer(ort, session, board, fens, selfElo, oppoElo) {
  const output = await session.run({
    tokens: new ort.Tensor('float32', buildTokens(fens), [1, 64, FEAT]),
    self_elo: new ort.Tensor('float32', Float32Array.of(selfElo), [1]),
    oppo_elo: new ort.Tensor('float32', Float32Array.of(oppoElo), [1]),
  });
  const logits = output.logits_move.data;
  if (logits.length !== 4352) throw new Error('Maia logits_move 维度不符');
  const legal = legalMoveIndices(board).map(({ uci, index }) => ({ uci, logit: Number(logits[index]) }));
  if (!legal.length || legal.some((move) => !Number.isFinite(move.logit))) throw new Error('Maia 未返回有效合法着法 logits');
  return softmaxMoves(legal);
}

async function evaluateHumans(ort, session, positions, opts) {
  const totals = Object.fromEntries(policies.map((policy) => [policy.name, tally()]));
  const byElo = {};
  const records = [];
  for (const position of positions) {
    const board = new Chess(position.fens.at(-1));
    const moves = await infer(ort, session, board, inputFens(position.fens, opts.history), position.selfElo, position.oppoElo);
    const actual = moves.find((move) => move.uci === position.humanUci);
    if (!actual) throw new Error(`人类下一着非法：${position.site} ply ${position.ply}`);
    // Stable log-softmax for the raw untruncated policy, including very small probabilities.
    const max = moves[0].logit;
    const rawNll = max - actual.logit + Math.log(moves.reduce((sum, move) => sum + Math.exp(move.logit - max), 0));
    const band = eloBand(position.selfElo);
    byElo[band] ??= Object.fromEntries(policies.map((policy) => [policy.name, tally()]));
    const scores = {};
    for (const policy of policies) {
      const pool = samplingDistribution(moves, policy.temperature, policy.topP);
      const index = pool.findIndex((move) => move.uci === actual.uci);
      const probability = index < 0 ? 0 : pool[index].p;
      const nll = policy.name === 'baseline' ? rawNll : probability > 0 ? -Math.log(probability) : Infinity;
      addScore(totals[policy.name], index + 1, nll);
      addScore(byElo[band][policy.name], index + 1, nll);
      scores[policy.name] = { rank: index < 0 ? null : index + 1, probability, nllNats: nll === Infinity ? null : nll, nllIsInfinite: nll === Infinity, retainedMoves: pool.length };
    }
    records.push({ gameIndex: position.gameIndex, site: position.site, ply: position.ply, fen: board.fen(), humanUci: actual.uci, selfElo: position.selfElo, oppoElo: position.oppoElo, scores });
  }
  return {
    count: positions.length,
    gamesRepresented: new Set(positions.map((position) => position.gameIndex)).size,
    policies: Object.fromEntries(Object.entries(totals).map(([name, total]) => [name, finishScore(total)])),
    bySelfRating: Object.fromEntries(Object.entries(byElo).map(([band, scores]) => [band, Object.fromEntries(Object.entries(scores).map(([name, total]) => [name, finishScore(total)]))])),
    records,
  };
}

async function evaluateOpenings(ort, session, book, opts) {
  const results = [];
  // Reuse identical prefix inference across strategies/rollouts, never substitute cached moves.
  const cache = new Map();
  for (const elo of opts.elos) {
    for (const policy of policies) {
      const paths = [];
      for (let trial = 0; trial < opts.rollouts; trial++) {
        // Common random numbers across policies and models, with independent trial streams.
        const trialSeed = (opts.seed + Math.imul(trial + 1, 0x9e3779b1) + Math.imul(elo, 0x85ebca6b)) >>> 0;
        const rng = seededRandom(trialSeed);
        const board = new Chess();
        const fens = [board.fen()];
        const moves = [];
        for (let ply = 0; ply < opts.plies && !board.isGameOver(); ply++) {
          // Cache exactly the FEN input passed to the encoder in the selected mode.
          const encodedFens = inputFens(fens, opts.history);
          const key = `${elo}|${encodedFens.join('|')}`;
          let distribution = cache.get(key);
          if (!distribution) {
            distribution = await infer(ort, session, board, encodedFens, elo, elo);
            cache.set(key, distribution);
          }
          const selected = sampleMove(distribution, policy.temperature, policy.topP, rng);
          board.move({ from: selected.uci.slice(0, 2), to: selected.uci.slice(2, 4), promotion: selected.uci[4] });
          moves.push(selected.uci);
          fens.push(board.fen());
        }
        paths.push({ trial, seed: trialSeed, moves, finalFen: board.fen(), endedBeforeLimit: moves.length < opts.plies, opening: identifyOpening(fens, book) });
      }
      results.push({ selfElo: elo, oppoElo: elo, ...policy, ...summarizeRollouts(paths) });
    }
  }
  return results;
}

const pct = (value) => `${(value * 100).toFixed(2)}%`;
const nll = (score) => score.meanNllIsInfinite ? '∞（存在零支持着法）' : score.meanNllNats.toFixed(4);

function markdown(report) {
  const lines = [
    '# Maia 真实人类下一着与开局采样评测', '',
    `模式：${report.options.smoke ? '**smoke，仅检查链路，不作拟人结论**' : '小样本描述性评测，非普适拟人/棋力结论'}。`, '',
    `Seed：${report.options.seed}；人类局面：${report.data.selectedPositions}/${report.data.availablePositions}；原始棋谱：${report.data.games}。`,
    `人类 PGN SHA-256：\`${report.data.sha256}\``,
    `人类清单 SHA-256：\`${report.data.manifestSha256}\``,
    `开局清单 SHA-256：\`${report.openingData.manifestSha256}\`；固定 commit：\`${report.openingData.commit}\``,
    `来源：[Lichess CC0 数据库](${report.data.sourceUrl})；固定 PGN 数据在 scripts/data/human-games.pgn。`,
    `运行时：Node ${report.runtime.node}，onnxruntime-node ${report.runtime.onnxruntimeNode}，CPU threads=${report.options.threads}。`,
    `历史输入：${report.options.history ? 'on（显式 --history 研究模式）' : 'off（默认，仅当前 FEN，与产品一致）'}。`,
    `开局：每模型/等级/策略 ${report.options.rollouts} 条，最多 ${report.options.plies} 半回合；等级 ${report.options.elos.join(', ')}。`,
    `策略：${report.policies.map((policy) => `${policy.name}=${policy.temperature}/${policy.topP}`).join('；')}。Top-P 保留跨阈值那步。`, '',
    '## 人类下一着', '',
    '合法着法归一化；Top1/Top3 为人类实走是否在策略前 1/3 名；NLL 使用自然对数。baseline 是原始 Maia policy。截断后零支持使平均 NLL 为无穷，绝不加 epsilon 隐藏。', '',
    '| 模型 | 模型 SHA-256 | 策略 | 局面/棋谱 | Top1 | Top3 | NLL (nats) | 支持覆盖 |',
    '| --- | --- | --- | ---: | ---: | ---: | --- | ---: |',
  ];
  for (const model of report.models) {
    for (const [policy, score] of Object.entries(model.human.policies)) lines.push(`| ${model.size} | \`${model.sha256}\` | ${policy} | ${score.count}/${model.human.gamesRepresented} | ${pct(score.top1)} | ${pct(score.top3)} | ${nll(score)} | ${pct(score.supportCoverage)} |`);
  }
  lines.push('', '### 按实际执棋者 Glicko2 分组', '', '| 模型 | 等级段 | 策略 | 局面 | Top1 | Top3 | NLL |', '| --- | --- | --- | ---: | ---: | ---: | --- |');
  for (const model of report.models) for (const [band, scores] of Object.entries(model.human.bySelfRating)) for (const [policy, score] of Object.entries(scores)) lines.push(`| ${model.size} | ${band} | ${policy} | ${score.count} | ${pct(score.top1)} | ${pct(score.top3)} | ${nll(score)} |`);
  lines.push('', '## 固定 seed 的真实 Maia 开局采样', '',
    '此段是模型自采样多样性诊断，不是真人预测指标。无开局库驱动落子；命名表仅事后分类。唯一路径按完整 UCI 序列区分；重复率=1−唯一路径数/条数，另报无放回路径对碰撞率。熵是经验频率的 Shannon bits，小样本有偏。', '',
    '| 模型 | 等级 | 策略 | 条数 | 唯一路径 | 重复率 | 路径对碰撞率 | 首着熵 | 路径熵 | 家族数（含未识别） |',
    '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const model of report.models) for (const row of model.openings) lines.push(`| ${model.size} | ${row.selfElo}/${row.oppoElo} | ${row.temperature}/${row.topP} | ${row.count} | ${row.uniquePaths} | ${pct(row.duplicatePathRate)} | ${row.pairCollisionRate === null ? 'N/A' : pct(row.pairCollisionRate)} | ${row.firstMoveEntropyBits.toFixed(3)} | ${row.pathEntropyBits.toFixed(3)} | ${row.openingFamilies.length} |`);
  for (const model of report.models) for (const row of model.openings) {
    lines.push('', `### ${model.size} · ${row.selfElo}/${row.oppoElo} · ${row.temperature}/${row.topP}`,
      '', `首着频率：${row.firstMoves.map((entry) => `${entry.value} ${entry.count}/${row.count} (${pct(entry.frequency)})`).join('；')}。`,
      '', `家族频率：${row.openingFamilies.map((entry) => `${entry.value} ${entry.count}/${row.count}`).join('；')}。`);
  }
  lines.push('', '## 可复现性和边界', '',
    '- JSON 包含逐真人局面实走概率、原始双方等级、完整采样路径、每条 seed、模型/数据/实现哈希和完整选项。',
    '- 真人对局来自公开 rated standard 记录，不是谜题或模型自我对弈；未独立审计身份/反作弊。',
    '- 12 局是早期数据库按时间顺序取得的便利样本，不均衡、不同局面不独立，可能与 Maia 训练数据重叠，不能称 held-out。',
    '- PGN 等级是当时的 Lichess Glicko2，不等于 FIDE Elo，也没有标定 Maia 输入等级。',
    '- 采样多样性不等于拟人准确率，更不等于棋力；未运行 Stockfish，不报告坏棋率或 Elo。',
    '- 指标方法参考 [Dash1971/mobile-maia-research](https://github.com/Dash1971/mobile-maia-research/blob/a2d90a94aac930fe17109f5e7e1b2e351c18b4fd/studies/maia3-sampling/REPORT.md)，只借鉴研究设计，未移植其 AGPL-3.0-only 代码/数据/图表。',
    '- 同一环境可复现随机序列；不同 ONNX Runtime/硬件浮点差异可能改变边界着法。', '',
    '### 实现 SHA-256', '', ...Object.entries(report.implementationHashes).map(([file, hash]) => `- \`${file}\`：\`${hash}\``), '');
  return lines.join('\n');
}

async function main() {
  const opts = options(process.argv.slice(2));
  if (opts.help) { console.log(usage); return; }
  const ort = await import('onnxruntime-node');
  const dataset = await loadHumanGames(join(root, 'scripts/data/human-games.manifest.json'));
  const selected = humanPositions(dataset.games, opts.positions, opts.seed);
  if (!selected.positions.length) throw new Error('没有可评测的真人下一着');
  const book = await loadOpeningFamilies(join(root, 'scripts/data/openings'));
  const implementationHashes = {};
  for (const file of ['scripts/human-bench.mjs', 'scripts/human-bench-data.mjs', 'src/maia/encode.ts', 'src/maia/sample.ts']) implementationHashes[file] = sha256(await readFile(join(root, file)));
  const ortPackage = JSON.parse(await readFile(join(root, 'node_modules/onnxruntime-node/package.json'), 'utf8'));
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), options: opts, policies,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, onnxruntimeNode: ortPackage.version },
    data: { ...dataset.manifest, manifestSha256: dataset.manifestSha256, games: dataset.games.length, selectedPositions: selected.positions.length, availablePositions: selected.available },
    openingData: { ...book.manifest, manifestSha256: book.manifestSha256 },
    implementationHashes, models: [],
  };
  for (const size of opts.models) {
    console.error(`加载真实 Maia ${size}，校验模型哈希…`);
    const { session, metadata } = await loadModel(ort, size, opts);
    try {
      const human = await evaluateHumans(ort, session, selected.positions, opts);
      const openings = await evaluateOpenings(ort, session, book, opts);
      report.models.push({ ...metadata, human, openings });
      console.error(`${size}：${human.count} 个真人下一着；${openings.reduce((sum, row) => sum + row.count, 0)} 条真实采样路径。`);
    } finally {
      await session.release();
    }
  }
  await mkdir(dirname(opts.out), { recursive: true });
  await writeFile(opts.out + '.json', JSON.stringify(report, null, 2) + '\n');
  await writeFile(opts.out + '.md', markdown(report));
  console.log(`JSON: ${opts.out}.json\nMarkdown: ${opts.out}.md`);
}

main().catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
