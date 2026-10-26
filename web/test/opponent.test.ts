import { describe, expect, it } from 'vitest';
import { OPPONENT_PERSONALITIES, opponentTalk, type OpponentPersonality } from '../src/opponent';

describe('local opponent talk', () => {
  it('selects an immediate check line without a network request', () => {
    expect(opponentTalk('sharp', { opponentSan: 'Qh4+' }, '', 0)).toContain('将军');
  });

  it('uses the personality-specific capture line', () => {
    expect(opponentTalk('deadpan', { opponentSan: 'Nxf3', captured: '兵' }, '', 0)).toContain('子力');
  });

  it('does not mistake a good user move for a blunder', () => {
    expect(opponentTalk('snarky', { opponentSan: 'e6', userSan: 'Bxh7+', userMaterialSwing: 1 }, '', 0)).toContain('将军');
  });

  it('reacts when the user captures a valuable piece', () => {
    expect(opponentTalk('sharp', { opponentSan: 'e6', userCaptured: '后', userCapturedValue: 9 }, '', 0)).toContain('关键');
  });

  it('avoids repeating the immediately previous line', () => {
    const first = opponentTalk('sharp', { opponentSan: 'Nxf3', captured: '兵' }, '', 0);
    const next = opponentTalk('sharp', { opponentSan: 'Bxc4', captured: '兵' }, first, 0);
    expect(next).not.toBe(first);
  });

  for (const personality of Object.keys(OPPONENT_PERSONALITIES) as OpponentPersonality[]) {
    it(`${personality}: varies routine replies across a whole opening`, () => {
      const heard: string[] = [];
      for (let i = 0; i < 10; i++) {
        const line = opponentTalk(personality, { opponentSan: 'e6' }, heard, 0);
        expect(heard).not.toContain(line);
        heard.push(line);
      }
    });

    it(`${personality}: reacts to castling and promotion while keeping mate priority`, () => {
      expect(opponentTalk(personality, { opponentSan: 'O-O' }, '', 0)).not.toBe(opponentTalk(personality, { opponentSan: 'e6' }, '', 0));
      expect(opponentTalk(personality, { opponentSan: 'e1=Q+' }, '', 0)).not.toBe(opponentTalk(personality, { opponentSan: 'Qh4+' }, '', 0));
      expect(opponentTalk(personality, { opponentSan: 'e1=Q#' }, '', 0)).toBe(opponentTalk(personality, { opponentSan: 'Qh4#' }, '', 0));
    });
  }
});
