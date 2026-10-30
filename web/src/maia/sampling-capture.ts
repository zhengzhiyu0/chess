import { samplingDistribution, type ScoredMove } from './sample';

const STORAGE_KEY = 'maia-coach.sampling-capture.v1';
export const SAMPLING_CAPTURE_MAX_GAMES = 10;
export const SAMPLING_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

export interface SamplingDecisionInput {
  /** Call only after a move was successfully applied, and only while capture is enabled. */
  committed: true;
  gameId: string;
  model: string;
  selfElo: number;
  oppoElo: number;
  /** Position before the chosen move. Elo inputs and WDL use its side-to-move perspective. */
  fen: string;
  temperature: number;
  topP: number;
  moves: ScoredMove[];
  chosen: string;
  ms: number;
  /** [win, draw, loss], side-to-move perspective, not White's perspective. */
  wdl?: [number, number, number];
}

export interface SamplingDecision {
  schemaVersion: 1;
  recordedAt: number;
  gameId: string;
  model: string;
  selfElo: number;
  oppoElo: number;
  fen: string;
  temperature: number;
  topP: number;
  rawMoves: ScoredMove[];
  distribution: ScoredMove[];
  chosen: string;
  ms: number;
  wdl?: { perspective: 'side-to-move'; win: number; draw: number; loss: number; expectedScore: number };
}

export interface SamplingCaptureResult {
  ok: boolean;
  error?: string;
}

export interface SamplingCaptureSummary extends SamplingCaptureResult {
  games: number;
  decisions: number;
  /** UTF-8 bytes of the stored JSONL, including line separators. */
  bytes: number;
}

function errorText(error: unknown): string {
  return `采样诊断存储失败：${error instanceof Error ? error.message : String(error)}`;
}

function moveList(value: unknown): value is ScoredMove[] {
  return Array.isArray(value) && value.length > 0 && value.every((move) =>
    move && typeof move.uci === 'string' && Number.isFinite(move.logit)
      && Number.isFinite(move.p) && move.p >= 0 && move.p <= 1,
  );
}

function isDecision(value: unknown): value is SamplingDecision {
  if (!value || typeof value !== 'object') return false;
  const record = value as SamplingDecision;
  return record.schemaVersion === 1 && Number.isFinite(record.recordedAt)
    && typeof record.gameId === 'string' && record.gameId.length > 0
    && typeof record.model === 'string' && typeof record.fen === 'string'
    && Number.isFinite(record.selfElo) && Number.isFinite(record.oppoElo)
    && Number.isFinite(record.temperature) && Number.isFinite(record.topP)
    && Number.isFinite(record.ms) && record.ms >= 0
    && typeof record.chosen === 'string' && moveList(record.rawMoves) && moveList(record.distribution)
    && record.distribution.some((move) => move.uci === record.chosen && move.p > 0)
    && (record.wdl === undefined || (record.wdl.perspective === 'side-to-move'
      && [record.wdl.win, record.wdl.draw, record.wdl.loss, record.wdl.expectedScore]
        .every((p) => Number.isFinite(p) && p >= 0 && p <= 1)));
}

function readCapture(): { records: SamplingDecision[]; text: string } {
  const text = localStorage.getItem(STORAGE_KEY) ?? '';
  if (encoder.encode(text).byteLength > SAMPLING_CAPTURE_MAX_BYTES) throw new Error('诊断数据超过 8 MiB 上限');
  const records: SamplingDecision[] = text === '' ? [] : text.split('\n').map((line) => {
    const value: unknown = JSON.parse(line);
    if (!isDecision(value)) throw new Error('诊断数据格式无效，请清除后重试');
    return value;
  });
  if (new Set(records.map((record) => record.gameId)).size > SAMPLING_CAPTURE_MAX_GAMES) {
    throw new Error('诊断数据超过 10 局上限');
  }
  return { records, text };
}

/**
 * Purely local, opt-in at the call site. This module never runs inference, draws
 * randomness, uploads, or reads/writes game history. Failures never escape into play.
 * Retains up to ten most recently recorded games; the byte cap may retain only a
 * game's tail. These are captured decisions, never a claim of complete game coverage.
 */
export function recordSamplingDecision(input: SamplingDecisionInput): SamplingCaptureResult {
  try {
    if (input.committed !== true) throw new Error('仅可记录已经成功落子的决策');
    const record: SamplingDecision = {
      schemaVersion: 1,
      recordedAt: Date.now(),
      gameId: input.gameId,
      model: input.model,
      selfElo: input.selfElo,
      oppoElo: input.oppoElo,
      fen: input.fen,
      temperature: input.temperature,
      topP: input.topP,
      rawMoves: input.moves.map(({ uci, logit, p }) => ({ uci, logit, p })),
      distribution: samplingDistribution(input.moves, input.temperature, input.topP),
      chosen: input.chosen,
      ms: input.ms,
    };
    if (input.wdl) {
      const [win, draw, loss] = input.wdl;
      if (Math.abs(win + draw + loss - 1) > 1e-6) throw new Error('WDL 必须为归一化概率');
      record.wdl = { perspective: 'side-to-move', win, draw, loss, expectedScore: win + 0.5 * draw };
    }
    if (!isDecision(record)) throw new Error('决策字段无效或所选着法不在实际采样分布中');
    const line = JSON.stringify(record);
    if (encoder.encode(line).byteLength > SAMPLING_CAPTURE_MAX_BYTES) throw new Error('单条诊断数据超过 8 MiB 上限');
    const { records } = readCapture();
    records.push(record);
    const recentGames = new Set<string>();
    for (let i = records.length - 1; i >= 0 && recentGames.size < SAMPLING_CAPTURE_MAX_GAMES; i--) {
      recentGames.add(records[i].gameId);
    }
    const lines = records.filter((r) => recentGames.has(r.gameId)).map((r) => JSON.stringify(r));
    const sizes = lines.map((entry) => encoder.encode(entry).byteLength);
    let bytes = sizes.reduce((sum, size) => sum + size, 0) + lines.length - 1;
    let start = 0;
    while (bytes > SAMPLING_CAPTURE_MAX_BYTES) bytes -= sizes[start++] + 1;
    localStorage.setItem(STORAGE_KEY, lines.slice(start).join('\n'));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

export function samplingCaptureSummary(): SamplingCaptureSummary {
  try {
    const { records, text } = readCapture();
    return { ok: true, games: new Set(records.map((record) => record.gameId)).size,
      decisions: records.length, bytes: encoder.encode(text).byteLength };
  } catch (error) {
    return { ok: false, games: 0, decisions: 0, bytes: 0, error: errorText(error) };
  }
}

/** Removes only capture data; game history and all preferences are untouched. */
export function clearSamplingCapture(): SamplingCaptureResult {
  try {
    localStorage.removeItem(STORAGE_KEY);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(3)}%`;
}

function decisionHtml(record: SamplingDecision, index: number): string {
  const actual = new Map(record.distribution.map((move) => [move.uci, move.p]));
  const rows = record.rawMoves.map((move) => `<tr${move.uci === record.chosen ? ' class="chosen"' : ''}><td>${escapeHtml(move.uci)}${move.uci === record.chosen ? '（已落子）' : ''}</td><td>${move.logit.toFixed(4)}</td><td>${percent(move.p)}</td><td>${percent(actual.get(move.uci) ?? 0)}</td></tr>`).join('');
  const outcome = record.wdl
    ? `<p>WDL（落子前行棋方视角）：胜 ${percent(record.wdl.win)} / 和 ${percent(record.wdl.draw)} / 负 ${percent(record.wdl.loss)}；预期得分 W + 0.5D = ${percent(record.wdl.expectedScore)}（不是单独胜率）</p>`
    : '<p>未记录 WDL。</p>';
  return `<section><h2>决策 ${index + 1} · ${escapeHtml(record.gameId)}</h2><p>模型 ${escapeHtml(record.model)}；SelfElo ${escapeHtml(record.selfElo)} / OppoElo ${escapeHtml(record.oppoElo)}（均以落子前行棋方为 self）；Temperature ${escapeHtml(record.temperature)} / Top-P ${escapeHtml(record.topP)}；推理 ${record.ms.toFixed(1)} ms</p><p>已落子：${escapeHtml(record.chosen)}；记录时间（UTC）：${escapeHtml(new Date(record.recordedAt).toISOString())}</p><pre>${escapeHtml(record.fen)}</pre>${outcome}<table><thead><tr><th>着法</th><th>原始 logit</th><th>原始模型概率</th><th>实际采样概率</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

/** Offline, script-free HTML or one committed-decision object per JSONL line. */
export function exportSamplingCapture(format: 'jsonl' | 'html'): string {
  try {
    const { records, text } = readCapture();
    if (format === 'jsonl') return text;
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Maia 本地采样诊断</title><style>body{font:16px system-ui,sans-serif;max-width:1080px;margin:auto;padding:20px;color:#222;overflow-wrap:anywhere}section{border-top:1px solid #aaa;margin-top:24px;padding-top:8px}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:1px solid #aaa;padding:8px;text-align:left;overflow-wrap:anywhere}.chosen{background:#e4f4df}pre{white-space:pre-wrap;overflow-wrap:anywhere}p{overflow-wrap:anywhere}@media(max-width:600px){body{font-size:14px;padding:12px}th,td{padding:5px}}</style></head><body><h1>Maia 本地采样诊断</h1><p>共 ${new Set(records.map((record) => record.gameId)).size} 局 / ${records.length} 个已落子决策。仅含实际捕获的决策，不保证完整对局；关闭记录、清除或达到 10 局 / 8 MiB 上限均可能造成缺失。本报告完全离线，不发送数据。</p><p>原始模型概率是温度调整前的预测；实际采样概率经 Temperature、Top-P 和重新归一化。Top-P 保留跨阈值的一步，被剔除着法实际概率为 0；Temperature 为 0 时仅取最大 logit。概率描述人类着法频率，不代表着法质量或胜率。</p>${records.map(decisionHtml).join('')}</body></html>`;
  } catch (error) {
    throw new Error(errorText(error));
  }
}
