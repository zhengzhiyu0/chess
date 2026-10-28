import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COACH_CLIPS, COACH_VOICES, CoachDialogue, type CoachEvent } from '../src/coach-voice/dialogue';
import { coachEvents, type CoachMove } from '../src/coach-voice/events';
import { COACHES } from '../src/app/coach-avatars';

const start = new Chess().fen();
const input = (extra: Partial<CoachMove> = {}): CoachMove => ({ fen: start, uci: 'e2e4', player: 'w', ply: 1, inBook: false, wasInBook: false, ...extra });
const event = (category: CoachEvent['category'], actor: CoachEvent['actor'] = 'opponent', priority = 50): CoachEvent => ({ category, actor, priority });

describe('Coach recording catalog and event evidence', () => {
  it('ships exactly the approved recordings with matching text and filenames', () => {
    const approved = [...JSON.parse(readFileSync('../ChessCoachResources/coach_lines.json', 'utf8')).clips, ...JSON.parse(readFileSync('../ChessCoachResources/Cast/coach_lines.json', 'utf8')).clips];
    expect(COACH_CLIPS).toHaveLength(968);
    expect(new Set(COACH_CLIPS.map(clip => clip.id)).size).toBe(968);
    expect(new Set(COACH_CLIPS.map(clip => clip.category)).size).toBe(30);
    for (const clip of COACH_CLIPS) {
      expect(approved.find((entry: { id: string }) => entry.id === clip.id)).toMatchObject({ id: clip.id, text: clip.text, file: clip.file, category: clip.category });
      expect(existsSync(join('public/voices', clip.role, clip.file))).toBe(true);
    }
  });

  it('stays quiet on routine moves instead of inventing praise or a tactic', () => {
    expect(coachEvents(input()).events).toEqual([]);
    expect(coachEvents(input({ inBook: true })).events.map(e => e.category)).toEqual(['opening_book_entry']);
  });

  it('can use all eight voices for player checks, and keeps personal mate claims on the correct side', () => {
    for (let coach = 0; coach < 8; coach++) {
      expect(new CoachDialogue().pick([event('player_check', 'player')], 1, 0, coach)?.category).toBe('player_check');
      expect(new CoachDialogue().pick([event('mate', 'player', 120)], 1, 0, coach)?.category).toBe('mate');
      expect(new CoachDialogue().pick([event('mate', 'opponent', 120)], 1, 0, coach)?.category).toBe('mate');
    }
    for (let i = 0; i < 4; i++) {
      const clip = new CoachDialogue(() => i / 4).pick([event('mate', 'player', 120)], 1, 0, 1)!;
      expect(clip.id).not.toBe('xiaoyou_mate_03');
    }
    const clip = COACH_CLIPS.find(clip => clip.id === 'ajian_tactic_discovered_attack_02')!;
    expect(clip.actors).toEqual(['player']);
  });

  it('uses engine evidence for best moves, and rejects bound/unfinished scores', () => {
    const before = { bestmove: 'e2e4', lines: [{ depth: 12, multipv: 1, cp: 30, pv: ['e2e4', 'e7e5'] }] };
    const after = { bestmove: 'e7e5', lines: [{ depth: 12, multipv: 1, cp: -30, pv: ['e7e5'] }] };
    expect(coachEvents(input({ before, after })).events.some(e => e.category === 'player_best')).toBe(true);
    expect(coachEvents(input({ before: { ...before, lines: [{ ...before.lines[0], bound: 'lowerbound' }] }, after })).events).toEqual([]);
    expect(coachEvents(input({ before: { ...before, lines: [{ ...before.lines[0], depth: 5 }] }, after })).events).toEqual([]);
  });

  it('keeps black/white evaluation perspectives consistent', () => {
    const board = new Chess(); board.move('e4');
    const before = { bestmove: 'e7e5', lines: [{ depth: 12, multipv: 1, cp: 0, pv: ['e7e5'] }] };
    const after = { bestmove: 'g1f3', lines: [{ depth: 12, multipv: 1, cp: 0, pv: ['g1f3'] }] };
    const reaction = coachEvents(input({ fen: board.fen(), uci: 'e7e5', player: 'b', ply: 2, before, after }));
    expect(reaction.playerWin).toBe(50);
    expect(reaction.events.some(e => e.category === 'player_best')).toBe(true);
  });

  it('separates queen and minor captures, without treating an immediate trade as a donation', () => {
    const queen = input({ fen: '4k3/8/8/8/8/8/q7/R3K3 w - - 0 1', uci: 'a1a2' });
    expect(coachEvents(queen).events[0].category).toBe('player_loses_queen');
    expect(coachEvents({ ...queen, player: 'b' }).events[0].category).toBe('capture_queen');
    expect(coachEvents({ ...queen, fen: 'r3k3/8/8/8/8/8/q7/R3K3 w - - 0 1' }).events).toEqual([]);
    expect(coachEvents({ ...queen, fen: '4k3/8/8/8/8/8/n7/R3K3 w - - 0 1' }).events[0].category).toBe('player_loses_minor');
  });

  it('prioritizes the actual mating side and never praises a capture over mate', () => {
    const board = new Chess(); for (const san of ['f3', 'e5', 'g4']) board.move(san);
    const reaction = coachEvents(input({ fen: board.fen(), uci: 'd8h4', ply: 4 }));
    expect(reaction.events).toEqual([{ category: 'mate', actor: 'opponent', piece: 'q', priority: 120 }]);
    const dialogue = new CoachDialogue(() => 0);
    expect(dialogue.pick(reaction.events, 4, 0, 0)?.id).not.toMatch(/_04$/);
    expect(new CoachDialogue().pick([{ ...reaction.events[0], actor: 'player' }], 4, 0, 0)?.id).toBe('lia_mate_04');
  });
});

describe('Coach dialogue scheduling', () => {
  it("uses each portrait's own script and recording, with isolated cooldowns", () => {
    const dialogue = new CoachDialogue();
    expect(COACH_VOICES).toHaveLength(8);
    for (const role of COACH_VOICES) {
      expect(role.name).toBe(COACHES[role.coachIndex].name);
      const pool = COACH_CLIPS.filter(clip => clip.coachIndex === role.coachIndex);
      expect(pool).toHaveLength(121);
      const clip = dialogue.pick([event('player_best', 'player')], 10, 0, role.coachIndex)!;
      expect(clip.role).toBe(role.id);
      expect(clip.id).toMatch(new RegExp(`^${role.id}_`));
    }
    for (const index of [-1, 8, 1.5, NaN]) expect(dialogue.pick([event('mate', 'opponent', 120)], 10, 0, index)).toBeNull();
  });

  it('uses a whole shuffle bag before repeating and changes the first line after recycling', () => {
    const dialogue = new CoachDialogue(() => 0.3);
    const ids = Array.from({ length: 9 }, (_, i) => dialogue.pick([event('capture_minor')], i * 6, i * 10000, 0)!.id);
    expect(new Set(ids.slice(0, 4)).size).toBe(4);
    expect(new Set(ids.slice(4, 8)).size).toBe(4);
    expect(ids[4]).not.toBe(ids[3]);
  });

  it('keeps ordinary moves quiet during cooldown, while allowing queen loss and mate', () => {
    const dialogue = new CoachDialogue();
    expect(dialogue.pick([event('capture_minor')], 10, 0, 0)).not.toBeNull();
    expect(dialogue.pick([event('capture_minor')], 11, 1000, 0)).toBeNull();
    expect(dialogue.pick([event('mate', 'opponent', 120), event('capture_queen', 'opponent', 100)], 12, 2000, 0)?.category).toBe('mate');
  });

  it('does not congratulate the player using a threat addressed at their own fork', () => {
    const dialogue = new CoachDialogue();
    expect(['lia_tactic_fork_02', 'lia_tactic_fork_03']).toContain(dialogue.pick([{ ...event('tactic_fork', 'player'), piece: 'n' }], 10, 0, 0)?.id);
    expect(dialogue.pick([{ ...event('tactic_fork', 'player'), piece: 'p' }], 20, 10000, 0)).toBeNull();
  });

  it('limits opening reactions to once per game, and requires a real recovery for comeback', () => {
    const dialogue = new CoachDialogue();
    expect(dialogue.pick([event('opening_book_entry', 'player')], 1, 0, 0)).not.toBeNull();
    expect(dialogue.pick([event('opening_book_entry', 'player')], 8, 10000, 0)).toBeNull();
    expect(dialogue.observe(50, true, 0)).toBe(false);
    expect(dialogue.observe(15, false, 0)).toBe(false);
    expect(dialogue.observe(46, true, 0)).toBe(true);
  });
});
