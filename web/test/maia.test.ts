import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import * as ort from 'onnxruntime-node';
import { buildTokens, FEAT, indexToUci, legalMoveIndices, uciToIndex } from '../src/maia/encode';
import { sampleMove, softmaxMoves } from '../src/maia/sample';
import { parseInfo } from '../src/engine/stockfish';
import { winPct, judge } from '../src/coach/coach';

interface Case {
  name: string;
  fen: string;
  moves: string[];
  self: number;
  oppo: number;
  model: string;
  top: { uci: string; p: number }[];
  wdl: [number, number, number];
  tokens_nonzero?: [number, number][];
  legal_idx?: number[];
}

const golden = JSON.parse(readFileSync(join(__dirname, 'golden.json'), 'utf8')) as { cases: Case[] };

function replay(c: Case) {
  const chess = new Chess(c.fen);
  const fens = [chess.fen()];
  for (const m of c.moves) {
    chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
    fens.push(chess.fen());
  }
  return { chess, fens };
}

describe('encoder matches PyTorch reference', () => {
  for (const c of golden.cases.filter((x) => x.model === '5m')) {
    it(c.name, () => {
      const { chess, fens } = replay(c);
      const tokens = buildTokens(fens);
      const nz: [number, number][] = [];
      for (let s = 0; s < 64; s++) for (let f = 0; f < FEAT; f++) if (tokens[s * FEAT + f]) nz.push([s, f]);
      expect(nz).toEqual(c.tokens_nonzero);
      const legal = legalMoveIndices(chess).map((l) => l.index).sort((a, b) => a - b);
      expect(legal).toEqual(c.legal_idx);
    });
  }

  it('move vocabulary round-trips', () => {
    for (let i = 0; i < 4352; i++) expect(uciToIndex(indexToUci(i))).toBe(i);
  });
});

const onnxDir = join(__dirname, '..', '..', '_onnx');
for (const size of ['5m', '23m', '79m']) {
  const file = join(onnxDir, `maia3-${size}.onnx`);
  describe.skipIf(!existsSync(file) || (size !== '5m' && !process.env.ALL_MODELS))(`ONNX maia3-${size} matches PyTorch`, () => {
    let session: ort.InferenceSession;
    for (const c of golden.cases.filter((x) => x.model === size)) {
      it(c.name, async () => {
        session ??= await ort.InferenceSession.create(file);
        const { chess, fens } = replay(c);
        const out = await session.run({
          tokens: new ort.Tensor('float32', buildTokens(fens), [1, 64, FEAT]),
          self_elo: new ort.Tensor('float32', Float32Array.of(c.self), [1]),
          oppo_elo: new ort.Tensor('float32', Float32Array.of(c.oppo), [1]),
        });
        const logits = out.logits_move.data as Float32Array;
        const moves = softmaxMoves(legalMoveIndices(chess).map((l) => ({ uci: l.uci, logit: logits[l.index] })));
        c.top.forEach((t, i) => {
          expect(moves[i].uci).toBe(t.uci);
          expect(moves[i].p).toBeCloseTo(t.p, 3);
        });
        const v = Array.from(out.logits_value.data as Float32Array);
        const m = Math.max(...v);
        const e = v.map((x) => Math.exp(x - m));
        const s = e[0] + e[1] + e[2];
        const wdl = [e[2] / s, e[1] / s, e[0] / s];
        wdl.forEach((x, i) => expect(x).toBeCloseTo(c.wdl[i], 3));
      });
    }
  });
}

describe('helpers', () => {
  it('sampleMove: temperature 0 is argmax, top_p keeps top-1', () => {
    const ms = softmaxMoves([
      { uci: 'a', logit: 1 },
      { uci: 'b', logit: 3 },
      { uci: 'c', logit: 2 },
    ]);
    expect(sampleMove(ms, 0, 1).uci).toBe('b');
    expect(sampleMove(ms, 1, 0.01, () => 0.99).uci).toBe('b');
    expect(sampleMove(ms, 1, 1, () => 0.999999).uci).toBe('a');
  });

  it('parseInfo', () => {
    const l = parseInfo('info depth 20 seldepth 30 multipv 2 score cp -35 wdl 50 800 150 nodes 1 pv e7e5 g1f3');
    expect(l).toEqual({ multipv: 2, depth: 20, cp: -35, wdl: [50, 800, 150], pv: ['e7e5', 'g1f3'] });
    expect(parseInfo('info depth 5 score mate -3 pv a1a2')?.mate).toBe(-3);
    expect(parseInfo('info string hi')).toBeNull();
  });

  it('coach thresholds', () => {
    expect(winPct(0)).toBeCloseTo(50);
    expect(judge(80, 45, false)).toBe('blunder');
    expect(judge(60, 55, false)).toBe('good');
  });
});
