import { describe, expect, it } from 'vitest';
import { confirmedMotifs, detectMotifs, explainMove, hangingSquares, materialWords, plainEval, pvMaterialSwing } from '../src/coach/explain';

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

  it('uses exchange evaluation: a defended piece is not free, a pinned defender does not count', () => {
    // d5 马有 e6 兵保护：不算白吃
    expect(kinds('4k3/8/4p3/3n4/8/8/8/3RK3 w - - 0 1', 'd1d5')).not.toContain('free');
    // 保护 e5 兵的 c6 马被 a4 象牵制在王前，不能回吃
    const ms = detectMotifs('4k3/8/2n5/4p3/B7/8/8/4R2K w - - 0 1', 'e1e5');
    expect(ms.find((m) => m.kind === 'pin')?.text).toContain('不能回吃');
    expect(hangingSquares('4k3/8/2n5/4p3/B7/8/8/4R2K b - - 0 1', 'b')).toEqual(['c6', 'e5']);
  });

  it('does not call attacking a pawn a fork', () => {
    expect(kinds('b3k3/1p6/8/8/2N5/8/8/4K3 w - - 0 1', 'c4d6')).not.toContain('fork');
  });

  it('finds a double check', () => {
    expect(kinds('4k3/8/8/8/4N3/8/8/4R2K w - - 0 1', 'e4f6')).toContain('double-check');
    expect(kinds('4k3/8/8/8/4N3/8/8/4R2K w - - 0 1', 'e4c5')).not.toContain('double-check');
  });

  it('finds removing the defender, a trapped piece and a mate threat', () => {
    // 车吃掉保护 e5 马的 d6 象，e5 马就保不住了
    expect(kinds('6k1/8/3b4/4n3/8/8/3R4/4R2K w - - 0 1', 'd2d6')).toContain('remove-defender');
    // b4 兵攻击 a5 象，象无路可逃
    expect(kinds('4k3/8/1p6/b7/8/2P5/1P6/4K3 w - - 0 1', 'b2b4')).toContain('trapped');
    // Qh5 威胁 Qxf7#
    expect(kinds('r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR w KQkq - 2 3', 'd1h5')).toContain('mate-threat');
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

describe('confirmedMotifs', () => {
  it('keeps a pin only when the line wins the pinned piece', () => {
    const fen = '4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1';
    expect(confirmedMotifs(fen, ['f1b5', 'e8d7', 'b5c6']).map((m) => m.kind)).toContain('pin');
    expect(confirmedMotifs(fen, ['f1b5', 'e8d7'])).toEqual([]);
  });

  it('keeps free captures without a follow-up but checks material', () => {
    expect(confirmedMotifs('4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1', ['d1d5']).map((m) => m.kind)).toContain('free');
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
    const r = explainMove({
      fen: 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1',
      uci: 'b5c7',
      best: 'b5c7',
      replyLine: { multipv: 1, depth: 10, cp: -500, pv: ['e8d7', 'c7a8'] },
      bad: false,
      sides: S,
    });
    expect(r.praise).toContain('捉双');
  });

  it('praises a sacrifice that sets up a fork later in the line', () => {
    // Rxf8+ Kxf8 Nd7+ 捉双王后
    const r = explainMove({
      fen: '1q3rk1/6pp/8/4N3/8/8/6PP/5R1K w - - 0 1',
      uci: 'f1f8',
      best: 'f1f8',
      replyLine: { multipv: 1, depth: 10, cp: -600, pv: ['g8f8', 'e5d7', 'f8e7', 'd7b8'] },
      bad: false,
      sides: S,
    });
    expect(r.praise).toContain('接着 <b>Nd7+</b>');
    expect(r.praise).toContain('捉双');
  });

  it('does not praise a fork the engine line refutes', () => {
    // 马捉双王车，但黑象直接吃掉马
    const r = explainMove({
      fen: 'r2bk3/8/8/1N6/8/8/8/4K3 w - - 0 1',
      uci: 'b5c7',
      best: 'b5c7',
      replyLine: { multipv: 1, depth: 10, cp: 300, pv: ['d8c7'] },
      bad: false,
      sides: S,
    });
    expect(r.praise).toBeNull();
  });

  it('does not claim a fork when the forked pieces escape', () => {
    // 黑马将军并捉双王车，但引擎变化里车没有被吃
    const r = explainMove({
      fen: '4k3/8/8/8/3n4/8/7P/R3K3 w - - 0 1',
      uci: 'h2h3',
      best: 'e1d2',
      replyLine: { multipv: 1, depth: 10, cp: 0, pv: ['d4c2', 'e1d2'] },
      bad: true,
      sides: S,
    });
    expect(r.problem[0]).not.toContain('捉双');
    expect(r.problem[0]).toContain('Nc2+');
  });
});
