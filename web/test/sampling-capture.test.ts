import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { softmaxMoves } from '../src/maia/sample';
import {
  clearSamplingCapture, exportSamplingCapture, recordSamplingDecision,
  samplingCaptureSummary, SAMPLING_CAPTURE_MAX_BYTES, SAMPLING_CAPTURE_MAX_GAMES,
  type SamplingDecisionInput,
} from '../src/maia/sampling-capture';

const memory = new Map<string, string>();
let failRead = false;
let failWrite = false;
let failRemove = false;
const storage = {
  getItem: (key: string) => {
    if (failRead) throw new Error('storage unavailable');
    return memory.get(key) ?? null;
  },
  setItem: (key: string, value: string) => {
    if (failWrite) throw new Error('quota exceeded');
    memory.set(key, value);
  },
  removeItem: (key: string) => {
    if (failRemove) throw new Error('storage locked');
    memory.delete(key);
  },
};

function input(overrides: Partial<SamplingDecisionInput> = {}): SamplingDecisionInput {
  return {
    committed: true,
    gameId: 'game-1', model: '23m', selfElo: 1600, oppoElo: 1400,
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    temperature: 1, topP: 0.7,
    moves: softmaxMoves([
      { uci: 'e2e4', logit: Math.log(0.5) },
      { uci: 'd2d4', logit: Math.log(0.3) },
      { uci: 'g1f3', logit: Math.log(0.2) },
    ]),
    chosen: 'd2d4', ms: 12.5, wdl: [0.3, 0.4, 0.3], ...overrides,
  };
}

beforeEach(() => {
  memory.clear();
  failRead = failWrite = failRemove = false;
  vi.stubGlobal('localStorage', storage);
  vi.spyOn(Date, 'now').mockReturnValue(123456789);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('local committed-decision sampling capture', () => {
  it('starts empty without creating storage or generating inference and records exact snapshots', () => {
    expect(samplingCaptureSummary()).toEqual({ ok: true, games: 0, decisions: 0, bytes: 0 });
    expect(memory.size).toBe(0);
    expect(exportSamplingCapture('jsonl')).toBe('');
    const decision = input();
    expect(recordSamplingDecision(decision)).toEqual({ ok: true });
    decision.moves[0].p = 0.99;
    const saved = JSON.parse(exportSamplingCapture('jsonl'));
    expect(saved).toMatchObject({ schemaVersion: 1, recordedAt: 123456789,
      gameId: 'game-1', model: '23m', selfElo: 1600, oppoElo: 1400,
      temperature: 1, topP: 0.7, chosen: 'd2d4', ms: 12.5,
      wdl: { perspective: 'side-to-move', win: 0.3, draw: 0.4, loss: 0.3, expectedScore: 0.5 } });
    expect(saved.rawMoves[0].p).toBeCloseTo(0.5, 14);
    expect(saved.rawMoves).toHaveLength(3);
    expect(saved.distribution).toHaveLength(2);
    expect(saved.distribution[0].p).toBeCloseTo(0.625, 14);
    expect(saved.distribution[1].p).toBeCloseTo(0.375, 14);
    expect(saved.distribution[1].logit).toBe(decision.moves[1].logit);
    expect(samplingCaptureSummary()).toMatchObject({ ok: true, games: 1, decisions: 1 });
  });

  it('refuses uncommitted decisions and chosen moves excluded by actual sampling', () => {
    expect(recordSamplingDecision(input({ committed: false as unknown as true })).ok).toBe(false);
    expect(recordSamplingDecision(input({ chosen: 'g1f3' })).ok).toBe(false);
    expect(samplingCaptureSummary().decisions).toBe(0);
    expect(recordSamplingDecision(input({ temperature: 0, chosen: 'e2e4' }))).toEqual({ ok: true });
    expect(JSON.parse(exportSamplingCapture('jsonl')).distribution).toEqual([{ ...input().moves[0], p: 1 }]);
  });

  it('retains the ten most recently recorded games and no records of an evicted game', () => {
    for (let i = 0; i < SAMPLING_CAPTURE_MAX_GAMES; i++) {
      expect(recordSamplingDecision(input({ gameId: `game-${i}` })).ok).toBe(true);
    }
    expect(recordSamplingDecision(input({ gameId: 'game-0' })).ok).toBe(true);
    expect(recordSamplingDecision(input({ gameId: 'game-10' })).ok).toBe(true);
    const records = exportSamplingCapture('jsonl').split('\n').map((line) => JSON.parse(line));
    const games = new Set(records.map((record) => record.gameId));
    expect(games.size).toBe(10);
    expect(games.has('game-0')).toBe(true);
    expect(games.has('game-1')).toBe(false);
    expect(games.has('game-10')).toBe(true);
    expect(samplingCaptureSummary().decisions).toBe(11);
  });

  it('enforces the UTF-8 8 MiB boundary including separators and evicts oldest decisions', () => {
    const fen = '棋'.repeat(1024 * 1024);
    for (let i = 0; i < 3; i++) {
      expect(recordSamplingDecision(input({ gameId: `large-${i}`, fen }))).toEqual({ ok: true });
    }
    const jsonl = exportSamplingCapture('jsonl');
    const summary = samplingCaptureSummary();
    expect(summary.ok).toBe(true);
    expect(summary.games).toBe(2);
    expect(summary.decisions).toBe(2);
    expect(summary.bytes).toBe(new TextEncoder().encode(jsonl).byteLength);
    expect(summary.bytes).toBeLessThanOrEqual(SAMPLING_CAPTURE_MAX_BYTES);
    expect(JSON.parse(jsonl.split('\n')[0]).gameId).toBe('large-1');
  });

  it('accepts exactly 8 MiB and rejects an oversized single record without losing existing records', () => {
    expect(recordSamplingDecision(input({ fen: '' })).ok).toBe(true);
    const base = samplingCaptureSummary().bytes;
    expect(clearSamplingCapture().ok).toBe(true);
    const fen = 'x'.repeat(SAMPLING_CAPTURE_MAX_BYTES - base);
    expect(recordSamplingDecision(input({ fen }))).toEqual({ ok: true });
    expect(samplingCaptureSummary().bytes).toBe(SAMPLING_CAPTURE_MAX_BYTES);
    const result = recordSamplingDecision(input({ fen: `${fen}x` }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('8 MiB');
    expect(samplingCaptureSummary()).toMatchObject({ ok: true, decisions: 1, bytes: SAMPLING_CAPTURE_MAX_BYTES });
  });

  it('clears capture only, leaving game history and preferences untouched', () => {
    memory.set('maia-coach.history', '[{"id":"saved-game"}]');
    memory.set('maia-coach.settings', '{"theme":"dark"}');
    expect(recordSamplingDecision(input()).ok).toBe(true);
    expect(clearSamplingCapture()).toEqual({ ok: true });
    expect(memory.get('maia-coach.history')).toBe('[{"id":"saved-game"}]');
    expect(memory.get('maia-coach.settings')).toBe('{"theme":"dark"}');
    expect(samplingCaptureSummary().decisions).toBe(0);
  });

  it('reports write failures without throwing or mutating the prior capture', () => {
    expect(recordSamplingDecision(input()).ok).toBe(true);
    const before = exportSamplingCapture('jsonl');
    failWrite = true;
    expect(() => recordSamplingDecision(input({ gameId: 'failed' }))).not.toThrow();
    expect(recordSamplingDecision(input({ gameId: 'failed' }))).toEqual({ ok: false, error: '采样诊断存储失败：quota exceeded' });
    expect(exportSamplingCapture('jsonl')).toBe(before);
  });

  it('reports unavailable storage on read, export and clear explicitly', () => {
    failRead = true;
    expect(recordSamplingDecision(input())).toEqual({ ok: false, error: '采样诊断存储失败：storage unavailable' });
    expect(samplingCaptureSummary()).toEqual({ ok: false, games: 0, decisions: 0, bytes: 0, error: '采样诊断存储失败：storage unavailable' });
    expect(() => exportSamplingCapture('html')).toThrow('storage unavailable');
    failRemove = true;
    expect(clearSamplingCapture()).toEqual({ ok: false, error: '采样诊断存储失败：storage locked' });
  });

  it('reports corrupt storage rather than silently discarding diagnostics', () => {
    recordSamplingDecision(input());
    const [key] = [...memory.keys()];
    memory.set(key, '{"schemaVersion":1}');
    expect(samplingCaptureSummary().ok).toBe(false);
    expect(recordSamplingDecision(input()).ok).toBe(false);
    expect(() => exportSamplingCapture('jsonl')).toThrow('格式无效');
    expect(clearSamplingCapture().ok).toBe(true);
  });
});

describe('offline sampling exports', () => {
  it('escapes every user string and distinguishes raw policy, actual policy, WDL and expected score', () => {
    const attack = '</pre><script>alert("x")</script><img src=x onerror=alert(1)>&\'';
    const decision = input({ gameId: attack, model: attack, fen: attack,
      moves: [{ uci: attack, logit: 0, p: 1 }], chosen: attack });
    expect(recordSamplingDecision(decision).ok).toBe(true);
    const jsonl = exportSamplingCapture('jsonl');
    expect(JSON.parse(jsonl).gameId).toBe(attack);
    const html = exportSamplingCapture('html');
    expect(html).not.toContain(attack);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('&amp;&#39;');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('原始模型概率');
    expect(html).toContain('实际采样概率');
    expect(html).toContain('落子前行棋方视角');
    expect(html).toContain('预期得分 W + 0.5D = 50.000%');
    expect(html).toContain('不保证完整对局');
  });

  it('exports one JSON object per decision and marks pruned actual probabilities as zero', () => {
    recordSamplingDecision(input({ wdl: undefined }));
    recordSamplingDecision(input({ gameId: 'game-2' }));
    expect(exportSamplingCapture('jsonl').split('\n').map((line) => JSON.parse(line).gameId)).toEqual(['game-1', 'game-2']);
    const html = exportSamplingCapture('html');
    expect(html).toContain('未记录 WDL');
    expect(html).toContain('<td>20.000%</td><td>0.000%</td>');
    expect(html).toContain('共 2 局 / 2 个已落子决策');
  });
});
