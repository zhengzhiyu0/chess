import { describe, expect, it } from 'vitest';
import { detectMotifs, explainMove, hangingSquares, materialWords, plainEval, pvMaterialSwing } from '../src/coach/explain';

const S = { me: '你', opp: '对手' };
const kinds = (fen: string, uci: string) => detectMotifs(fen, uci).map((m) => m.kind);

describe('detectMotifs', () => {
  it('finds a knight fork of king and rook', () => {
    expect(kinds('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', 'b5c7')).toContain('fork');
  });

  it('finds an absolute pin', () => {
    const ms = detectMotifs('4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1', 'f1b5');
    expect(ms[0].kind).toBe('pin');
    expect(ms[0].text).toContain('马');
  });

  it('finds a skewer of king and rook', () => {
    expect(kinds('r3k3/8/8/8/8/8/8/4K2R w - - 0 1', 'h1h8')).toContain('skewer');
  });

  it('finds a discovered attack', () => {
    expect(kinds('3qk3/8/8/8/8/8/3N4/3RK3 w - - 0 1', 'd2f3')).toContain('discovered');
  });

  it('finds free captures, trades up and mate', () => {
    expect(kinds('4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1', 'd1d5')).toContain('free');
    expect(kinds('4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1', 'e4d5')).toContain('trade-up');
    expect(kinds('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', 'a1a8')[0]).toBe('mate');
  });
});

describe('material and words', () => {
  it('settles material after exchanges finish', () => {
    // 白车吃 d5 马，黑后不能回吃：净得 3
    expect(pvMaterialSwing('4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1', ['d1d5'])).toBe(3);
    // 后吃兵被兵回吃：净亏 8
    expect(pvMaterialSwing('4k3/8/2p5/3p4/8/8/8/3QK3 w - - 0 1', ['d1d5', 'c6d5'])).toBe(-8);
  });

  it('describes evaluations in plain words', () => {
    expect(plainEval({ multipv: 1, depth: 10, cp: 10, pv: [] }, 'w', 'w', S)).toBe('双方大致均势');
    expect(plainEval({ multipv: 1, depth: 10, cp: 120, pv: [] }, 'w', 'w', S)).toContain('你大约多一个兵');
    expect(plainEval({ multipv: 1, depth: 10, cp: 120, pv: [] }, 'b', 'w', S)).toContain('对手');
    expect(plainEval({ multipv: 1, depth: 10, mate: 2, pv: [] }, 'b', 'w', S)).toBe('对手能在 2 步内将杀');
    expect(materialWords(5)).toBe('大约一个车');
  });

  it('lists hanging pieces', () => {
    expect(hangingSquares('4k3/8/8/3n4/8/8/8/3RK3 b - - 0 1', 'b')).toEqual(['d5']);
  });
});

describe('explainMove', () => {
  it('explains a bad move and the better one', () => {
    const r = explainMove({
      fen: '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1',
      uci: 'a1a2',
      best: 'a1a8',
      bestLine: { multipv: 1, depth: 10, mate: 1, pv: ['a1a8'] },
      replyLine: { multipv: 1, depth: 10, cp: 0, pv: ['h7h6'] },
      bad: true,
      sides: S,
    });
    expect(r.better).toEqual(['1 步杀']);
    expect(r.problem[0]).toContain('h6');
  });

  it('explains a blunder that allows a knight fork', () => {
    const r = explainMove({
      fen: '4k3/8/8/8/3n4/8/7P/R3K3 w - - 0 1',
      uci: 'h2h3',
      best: 'e1d2',
      replyLine: { multipv: 1, depth: 10, cp: 400, pv: ['d4c2', 'e1d2', 'c2a1'] },
      bad: true,
      sides: S,
    });
    expect(r.problem[0]).toContain('捉双');
    expect(r.problem[0]).toContain('你的王和车');
    expect(r.problem.join()).toContain('大约一个车');
  });

  it('praises a good fork', () => {
    const r = explainMove({ fen: 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', uci: 'b5c7', best: 'b5c7', bad: false, sides: S });
    expect(r.praise).toContain('捉双');
  });
});
