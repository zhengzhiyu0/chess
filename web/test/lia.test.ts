import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIA_CLIPS, LiaDialogue, type LiaEvent } from '../src/lia/dialogue';
import { liaEvents, type LiaMove } from '../src/lia/events';

const start = new Chess().fen();
const input = (extra: Partial<LiaMove> = {}): LiaMove => ({ fen: start, uci: 'e2e4', player: 'w', ply: 1, inBook: false, wasInBook: false, ...extra });
const event = (category: LiaEvent['category'], actor: LiaEvent['actor'] = 'lia', priority = 50): LiaEvent => ({ category, actor, priority });

describe('Lia recording catalog and event evidence', () => {
  it('ships exactly the approved recordings with matching text and filenames', () => {
    const approved = JSON.parse(readFileSync('../ChessCoachResources/coach_lines.json', 'utf8')).clips;
    expect(LIA_CLIPS).toHaveLength(121);
    expect(new Set(LIA_CLIPS.map(clip => clip.id)).size).toBe(121);
    expect(new Set(LIA_CLIPS.map(clip => clip.category)).size).toBe(30);
    for (const clip of LIA_CLIPS) {
      expect(approved.find((entry: { id: string }) => entry.id === clip.id)).toMatchObject(clip);
      expect(existsSync(join('public/voices/lia', clip.file))).toBe(true);
    }
  });

  it('stays quiet on routine moves instead of inventing praise or a tactic', () => {
    expect(liaEvents(input()).events).toEqual([]);
    expect(liaEvents(input({ inBook: true })).events.map(e => e.category)).toEqual(['opening_book_entry']);
  });

  it('uses engine evidence for best moves, and rejects bound/unfinished scores', () => {
    const before = { bestmove: 'e2e4', lines: [{ depth: 12, multipv: 1, cp: 30, pv: ['e2e4', 'e7e5'] }] };
    const after = { bestmove: 'e7e5', lines: [{ depth: 12, multipv: 1, cp: -30, pv: ['e7e5'] }] };
    expect(liaEvents(input({ before, after })).events.some(e => e.category === 'player_best')).toBe(true);
    expect(liaEvents(input({ before: { ...before, lines: [{ ...before.lines[0], bound: 'lowerbound' }] }, after })).events).toEqual([]);
    expect(liaEvents(input({ before: { ...before, lines: [{ ...before.lines[0], depth: 5 }] }, after })).events).toEqual([]);
  });

  it('keeps black/white evaluation perspectives consistent', () => {
    const board = new Chess(); board.move('e4');
    const before = { bestmove: 'e7e5', lines: [{ depth: 12, multipv: 1, cp: 0, pv: ['e7e5'] }] };
    const after = { bestmove: 'g1f3', lines: [{ depth: 12, multipv: 1, cp: 0, pv: ['g1f3'] }] };
    const reaction = liaEvents(input({ fen: board.fen(), uci: 'e7e5', player: 'b', ply: 2, before, after }));
    expect(reaction.playerWin).toBe(50);
    expect(reaction.events.some(e => e.category === 'player_best')).toBe(true);
  });

  it('separates queen and minor captures, without treating an immediate trade as a donation', () => {
    const queen = input({ fen: '4k3/8/8/8/8/8/q7/R3K3 w - - 0 1', uci: 'a1a2' });
    expect(liaEvents(queen).events[0].category).toBe('player_loses_queen');
    expect(liaEvents({ ...queen, player: 'b' }).events[0].category).toBe('capture_queen');
    expect(liaEvents({ ...queen, fen: 'r3k3/8/8/8/8/8/q7/R3K3 w - - 0 1' }).events).toEqual([]);
    expect(liaEvents({ ...queen, fen: '4k3/8/8/8/8/8/n7/R3K3 w - - 0 1' }).events[0].category).toBe('player_loses_minor');
  });

  it('prioritizes the actual mating side and never praises a capture over mate', () => {
    const board = new Chess(); for (const san of ['f3', 'e5', 'g4']) board.move(san);
    const reaction = liaEvents(input({ fen: board.fen(), uci: 'd8h4', ply: 4 }));
    expect(reaction.events).toEqual([{ category: 'mate', actor: 'lia', piece: 'q', priority: 120 }]);
    const dialogue = new LiaDialogue(() => 0);
    expect(dialogue.pick(reaction.events, 4, 0, 0)?.id).not.toMatch(/_04$/);
    expect(new LiaDialogue().pick([{ ...reaction.events[0], actor: 'player' }], 4, 0, 0)?.id).toBe('lia_mate_04');
  });
});

describe('Lia dialogue scheduling', () => {
  it('produces no dialogue for the other seven portraits', () => {
    const dialogue = new LiaDialogue();
    for (let coach = 1; coach < 8; coach++) expect(dialogue.pick([event('capture_queen', 'lia', 100)], 10, 0, coach)).toBeNull();
  });

  it('uses a whole shuffle bag before repeating and changes the first line after recycling', () => {
    const dialogue = new LiaDialogue(() => 0.3);
    const ids = Array.from({ length: 9 }, (_, i) => dialogue.pick([event('capture_minor')], i * 6, i * 10000, 0)!.id);
    expect(new Set(ids.slice(0, 4)).size).toBe(4);
    expect(new Set(ids.slice(4, 8)).size).toBe(4);
    expect(ids[4]).not.toBe(ids[3]);
  });

  it('keeps ordinary moves quiet during cooldown, while allowing queen loss and mate', () => {
    const dialogue = new LiaDialogue();
    expect(dialogue.pick([event('capture_minor')], 10, 0, 0)).not.toBeNull();
    expect(dialogue.pick([event('capture_minor')], 11, 1000, 0)).toBeNull();
    expect(dialogue.pick([event('mate', 'lia', 120), event('capture_queen', 'lia', 100)], 12, 2000, 0)?.category).toBe('mate');
  });

  it('does not congratulate the player using a threat addressed at their own fork', () => {
    const dialogue = new LiaDialogue();
    expect(['lia_tactic_fork_02', 'lia_tactic_fork_03']).toContain(dialogue.pick([{ ...event('tactic_fork', 'player'), piece: 'n' }], 10, 0, 0)?.id);
    expect(dialogue.pick([{ ...event('tactic_fork', 'player'), piece: 'p' }], 20, 10000, 0)).toBeNull();
  });

  it('limits opening reactions to once per game, and requires a real recovery for comeback', () => {
    const dialogue = new LiaDialogue();
    expect(dialogue.pick([event('opening_book_entry', 'player')], 1, 0, 0)).not.toBeNull();
    expect(dialogue.pick([event('opening_book_entry', 'player')], 8, 10000, 0)).toBeNull();
    expect(dialogue.observe(50, true)).toBe(false);
    expect(dialogue.observe(15, false)).toBe(false);
    expect(dialogue.observe(46, true)).toBe(true);
  });
});
