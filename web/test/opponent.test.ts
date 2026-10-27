import { describe, expect, it } from 'vitest';
import { COACH_PERSONALITY_POOLS, OPPONENT_PERSONALITIES, opponentTalk, opponentVoiceLine, type OpponentPersonality } from '../src/opponent';

describe('local opponent talk', () => {
  it('selects an immediate check line without a network request', () => {
    expect(opponentTalk('sharp', { opponentSan: 'Qh4+' }, '', 0)).toContain('将军');
  });

  it('uses the personality-specific capture line', () => {
    const lines = Array.from({ length: 80 }, (_, i) => opponentTalk('deadpan', { opponentSan: 'Nxf3', captured: '兵' }, '', i * 0.000013));
    expect(lines.some((line) => line.includes('子力'))).toBe(true);
  });

  it('does not mistake a good user move for a blunder', () => {
    expect(opponentTalk('snarky', { opponentSan: 'e6', userSan: 'Bxh7+', userMaterialSwing: 1 }, '', 0)).toContain('将军');
  });

  it('reacts when the user captures a valuable piece', () => {
    const lines = Array.from({ length: 80 }, (_, i) => opponentTalk('sharp', { opponentSan: 'e6', userCaptured: '后', userCapturedValue: 9 }, '', i * 0.000017));
    expect(lines.some((line) => line.includes('关键'))).toBe(true);
  });

  it('avoids repeating the immediately previous line', () => {
    const first = opponentTalk('sharp', { opponentSan: 'Nxf3', captured: '兵' }, '', 0);
    const next = opponentTalk('sharp', { opponentSan: 'Bxc4', captured: '兵' }, first, 0);
    expect(next).not.toBe(first);
  });

  it('addresses the selected coach instead of calling itself a robot', () => {
    const lines = Array.from({ length: 80 }, (_, i) => opponentTalk('commentator', { opponentSan: 'Nxf3', captured: '兵' }, '', i * 0.000013, '星河教练'));
    expect(lines.some((line) => line.includes('星河教练'))).toBe(true);
    expect(lines.every((line) => !line.includes('机器人'))).toBe(true);
  });

  it.each(['象', '后', '车'])('can mention the exact piece lost (%s)', (piece) => {
    const lines = Array.from({ length: 80 }, (_, i) => opponentTalk(
      'theatrical',
      { opponentSan: 'e6', userCaptured: piece, userCapturedValue: piece === '后' ? 9 : 3 },
      '',
      i * 0.000013,
    ));
    expect(lines.some((line) => line.includes(`我的${piece}`))).toBe(true);
  });

  it('uses a dedicated branch for promotion instead of a generic reply', () => {
    const lines = Array.from({ length: 80 }, (_, i) => opponentTalk('poetic', { opponentSan: 'e8=Q' }, '', i * 0.000013));
    expect(lines.some((line) => line.includes('升变'))).toBe(true);
  });

  it('gives every coach several compatible personalities to rotate between games', () => {
    expect(COACH_PERSONALITY_POOLS).toHaveLength(8);
    for (const pool of COACH_PERSONALITY_POOLS) {
      expect(new Set(pool).size).toBeGreaterThanOrEqual(2);
    }
  });

  it('uses a distinct Chinese and English opening for each personality', () => {
    const personalities = Object.keys(OPPONENT_PERSONALITIES) as OpponentPersonality[];
    const chineseStarts = personalities.map((personality) =>
      opponentTalk(personality, { opponentSan: 'e6' }, '', 0).match(/^[^：，。！？\s]+/)?.[0]);
    const englishStarts = personalities.map((personality) =>
      opponentVoiceLine(personality, { opponentSan: 'e6' }, 0).match(/^[^\s,:.!?—]+/)?.[0]);
    expect(new Set(chineseStarts).size).toBe(personalities.length);
    expect(new Set(englishStarts).size).toBe(personalities.length);
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

    it(`${personality}: gives twenty routine voice replies without repeating`, () => {
      const heard: string[] = [];
      for (let i = 0; i < 20; i++) {
        const line = opponentVoiceLine(personality, { opponentSan: 'e6' }, i / 97, 0, heard);
        expect(heard).not.toContain(line);
        heard.push(line);
      }
    });
  }
});
