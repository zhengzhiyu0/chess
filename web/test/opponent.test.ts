import { describe, expect, it } from 'vitest';
import { opponentTalk } from '../src/opponent';

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
});
