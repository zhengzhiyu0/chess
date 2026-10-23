import { beforeEach, describe, expect, it } from 'vitest';

const mem = new Map<string, string>();
/** bytes allowed in the stub storage (keys + values) */
let quota = Infinity;
const used = () => [...mem].reduce((n, [k, v]) => n + k.length + v.length, 0);
Object.assign(globalThis, {
  matchMedia: () => ({ matches: false }),
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      const next = used() - (mem.has(k) ? k.length + mem.get(k)!.length : 0) + k.length + v.length;
      if (next > quota) throw new DOMException('full', 'QuotaExceededError');
      mem.set(k, v);
    },
    removeItem: (k: string) => void mem.delete(k),
  },
});

const { safeSet } = await import('../src/storage');
const mistakes = await import('../src/training/mistakes');
const { addMistakes, gradeMistake, loadMistakes, removeMistake, resetMistakeCache, sanitizeMistake, setMistakes, loadDeletedMistakes, DELETED_CAP, MASTER_STREAK } = mistakes;
type Mistake = import('../src/training/mistakes').Mistake;
const { mergeBackup, parseBackup, makeBackup } = await import('../src/backup');
const { defaultSettings } = await import('../src/settings');
const { sanitizeGame } = await import('../src/game/history');
const { sanitizeProgress } = await import('../src/training/puzzles');

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const DAY = 86_400_000;

const mistake = (over: Partial<Mistake> = {}): Mistake => ({
  id: 'g:1',
  gameId: 'g',
  date: 1000,
  fen: START_FEN,
  played: 'f2f3',
  playedSan: 'f3',
  best: 'e2e4',
  line: ['e2e4'],
  judgement: 'mistake',
  drop: 20,
  tag: 'positional',
  tagLabel: '局面判断失误',
  streak: 0,
  due: 0,
  tries: 0,
  solved: 0,
  ...over,
});

beforeEach(() => {
  mem.clear();
  quota = Infinity;
  resetMistakeCache();
});

describe('safeSet', () => {
  it('drops the analysis cache when storage is full, then retries', () => {
    quota = 200;
    mem.set('maia-coach.evals', 'x'.repeat(150));
    expect(safeSet('maia-coach.history', 'y'.repeat(60))).toBe(true);
    expect(mem.has('maia-coach.evals')).toBe(false);
    expect(mem.get('maia-coach.history')).toHaveLength(60);
  });
  it('still reports failure when nothing can make room', () => {
    quota = 50;
    expect(safeSet('maia-coach.history', 'y'.repeat(100))).toBe(false);
  });
});

describe('sanitizeMistake', () => {
  it('rejects broken positions and moves that are illegal there', () => {
    expect(sanitizeMistake(mistake())).not.toBeNull();
    expect(sanitizeMistake(mistake({ fen: 'not a fen' }))).toBeNull();
    expect(sanitizeMistake(mistake({ fen: '8/8/8/8/8/8/8/8 w - - 0 1' }))).toBeNull();
    expect(sanitizeMistake(mistake({ best: 'e2e5' }))).toBeNull();
    expect(sanitizeMistake(mistake({ played: 'e7e5' }))).toBeNull();
  });
});

describe('deleted mistakes', () => {
  it('stay deleted when the game is reviewed again', () => {
    expect(addMistakes([mistake(), mistake({ id: 'g:2' })])).toBe(2);
    removeMistake('g:1');
    expect(addMistakes([mistake(), mistake({ id: 'g:2' }), mistake({ id: 'g:3' })])).toBe(1);
    expect(loadMistakes().map((m) => m.id).sort()).toEqual(['g:2', 'g:3']);
    // persisted across restarts
    resetMistakeCache();
    expect(loadDeletedMistakes()).toEqual(['g:1']);
    expect(addMistakes([mistake()])).toBe(0);
  });
  it('keeps a bounded tombstone list, newest last', () => {
    for (let i = 0; i < DELETED_CAP + 5; i++) removeMistake(`x:${i}`);
    const d = loadDeletedMistakes();
    expect(d).toHaveLength(DELETED_CAP);
    expect(d[d.length - 1]).toBe(`x:${DELETED_CAP + 4}`);
    expect(d).not.toContain('x:0');
  });
});

describe('gradeMistake spacing', () => {
  it('does not advance a mistake practised before it is due', () => {
    setMistakes([mistake({ due: 0 })]);
    const t0 = 10 * DAY;
    expect(gradeMistake('g:1', true, t0)).toBe(true);
    const m = loadMistakes()[0];
    expect(m.streak).toBe(1);
    const due = m.due;
    expect(due).toBe(t0 + DAY);
    // three more quick answers right away: only tries change
    for (let i = 0; i < 3; i++) expect(gradeMistake('g:1', true, t0 + 60_000 * (i + 1))).toBe(false);
    expect(loadMistakes()[0]).toMatchObject({ streak: 1, due, tries: 4, solved: 1 });
    expect(loadMistakes()[0].mastered).toBeUndefined();
    // early wrong answers don't reset either
    expect(gradeMistake('g:1', false, t0 + 120_000)).toBe(false);
    expect(loadMistakes()[0].streak).toBe(1);
  });
  it('is mastered only after going through every interval, the 7-day one included', () => {
    setMistakes([mistake({ due: 0 })]);
    let now = 0;
    const gaps: number[] = [];
    for (let i = 0; i < MASTER_STREAK; i++) {
      expect(loadMistakes()[0].mastered).toBeUndefined();
      expect(gradeMistake('g:1', true, now)).toBe(true);
      const m = loadMistakes()[0];
      gaps.push((m.due - now) / DAY);
      now = m.due;
    }
    expect(loadMistakes()[0].mastered).toBe(true);
    expect(gaps.slice(0, MASTER_STREAK - 1)).toEqual([1, 3, 7]);
  });
});

describe('backup normalization', () => {
  const game = (id: string, date: number) => ({ id, date, startFen: START_FEN, tree: {}, userColor: 'w' as const, result: '1-0' });

  it('dedupes, sorts and caps an imported backup (replace path)', () => {
    const history = [...Array.from({ length: 320 }, (_, i) => game(`g${i}`, i)), game('g5', 999)];
    const file = JSON.stringify({
      ...makeBackup(
        {
          settings: defaultSettings(),
          history,
          mistakes: [mistake(), mistake({ tries: 4 }), mistake({ id: 'g:2' }), mistake({ id: 'g:9' })],
          puzzles: sanitizeProgress({}),
        },
        'test',
      ),
      deletedMistakes: ['g:9'],
    });
    const { data } = parseBackup(file);
    expect(data.history).toHaveLength(300);
    expect(new Set(data.history.map((g) => g.id)).size).toBe(300);
    expect(data.history[0]).toMatchObject({ id: 'g5', date: 999 });
    expect(data.history.every((g, i, a) => i === 0 || a[i - 1].date >= g.date)).toBe(true);
    expect(data.mistakes.map((m) => m.id).sort()).toEqual(['g:1', 'g:2']);
    expect(data.mistakes.find((m) => m.id === 'g:1')!.tries).toBe(4);
    expect(data.deletedMistakes).toEqual(['g:9']);
  });

  it('exports, merges and keeps tombstones from both sides', () => {
    removeMistake('local:1');
    const exported = makeBackup({ settings: defaultSettings(), history: [], mistakes: [], puzzles: sanitizeProgress({}) }, 'test');
    expect(exported.deletedMistakes).toEqual(['local:1']);
    const inc = parseBackup(JSON.stringify({ ...exported, mistakes: [mistake({ id: 'local:1' }), mistake({ id: 'a' })], deletedMistakes: ['b'] })).data;
    const cur = { settings: defaultSettings(), history: [], mistakes: [mistake({ id: 'b' })], puzzles: sanitizeProgress({}) };
    const m = mergeBackup(cur, inc);
    expect(m.mistakes.map((x) => x.id)).toEqual(['a']);
    expect([...m.deletedMistakes!].sort()).toEqual(['b', 'local:1']);
  });

  it('accepts older backups without tombstones', () => {
    const file = JSON.stringify({ format: 'maia-coach-backup', version: 1, history: [game('a', 1)], mistakes: [mistake()] });
    const { data } = parseBackup(file);
    expect(data.mistakes).toHaveLength(1);
    expect(data.deletedMistakes).toEqual([]);
  });
});

describe('sanitizeGame id', () => {
  it('accepts generated ids and rejects markup', () => {
    const base = { date: 1, startFen: START_FEN, tree: {}, userColor: 'w' };
    expect(sanitizeGame({ ...base, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7) })).not.toBeNull();
    expect(sanitizeGame({ ...base, id: '"><img src=x onerror=alert(1)>' })).toBeNull();
    expect(sanitizeGame({ ...base, id: '' })).toBeNull();
    expect(sanitizeGame({ ...base, id: 'a'.repeat(65) })).toBeNull();
  });
});
