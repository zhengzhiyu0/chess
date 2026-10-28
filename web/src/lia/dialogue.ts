import catalog from './lines.json';

export const LIA_COACH_INDEX = 0;
export type LiaCategory =
  | 'opening_book_entry' | 'opening_book_exit' | 'player_accurate' | 'player_best' | 'player_brilliant'
  | 'lia_best_move' | 'capture_pawn' | 'capture_minor' | 'capture_rook' | 'capture_queen'
  | 'player_loses_minor' | 'player_loses_rook' | 'player_loses_queen'
  | 'tactic_fork' | 'tactic_pin' | 'tactic_discovered_attack' | 'tactic_zwischenzug' | 'tactic_sacrifice'
  | 'key_threat' | 'check' | 'player_check' | 'missed_mate' | 'blunder_into_mate' | 'mate'
  | 'castling' | 'promotion' | 'queen_early' | 'defense_found' | 'player_missed_tactic' | 'comeback';
export interface VoiceClip { id: string; category: LiaCategory; text: string; file: string }
export type Actor = 'player' | 'lia';
export interface LiaEvent {
  category: LiaCategory;
  actor: Actor;
  piece?: string;
  /** Larger events replace smaller reactions to the same move. */
  priority: number;
}
export const LIA_CLIPS = catalog as readonly VoiceClip[];
export const LIA_FILES = new Set(LIA_CLIPS.map(clip => clip.file));

// A recording's pronouns and piece-specific claims must match the actual event.
function fits(clip: VoiceClip, event: LiaEvent): boolean {
  const id = clip.id;
  if (event.category === 'mate') return id.endsWith('_04') ? event.actor === 'player' : event.actor === 'lia';
  if (event.category === 'tactic_fork') {
    if (id.endsWith('_03')) return event.actor === 'player' && event.piece === 'n';
    if (id.endsWith('_02')) return event.piece === 'n';
    return event.actor === 'lia';
  }
  if (event.category === 'tactic_pin') return id.endsWith('_04') ? event.actor === 'player' : event.actor === 'lia';
  if (event.category === 'tactic_discovered_attack') return !id.endsWith('_01') || event.actor === 'player';
  if (event.category === 'tactic_sacrifice') return event.actor === 'player';
  return true;
}

const LIMITS: Partial<Record<LiaCategory, number>> = {
  opening_book_entry: 1, opening_book_exit: 1, castling: 1,
  player_brilliant: 2, missed_mate: 1, comeback: 1,
};

/** One instance belongs to one game, including its shuffle bags and cooldowns. */
export class LiaDialogue {
  private bags = new Map<string, VoiceClip[]>();
  private counts = new Map<string, number>();
  private lastId = '';
  private lastPly = -100;
  private lastAt = -Infinity;
  private lowWater = 100;

  constructor(private random = Math.random) {}

  ready(ply: number, now: number): boolean {
    return ply - this.lastPly >= 4 && now - this.lastAt >= 8000;
  }

  /** Track a sustained recovery, rather than treating any single good move as a comeback. */
  observe(playerWin: number, accuratePlayerMove: boolean): boolean {
    this.lowWater = Math.min(this.lowWater, playerWin);
    return accuratePlayerMove && this.lowWater <= 20 && playerWin >= 45;
  }

  pick(events: readonly LiaEvent[], ply: number, now: number, coachIndex: number): VoiceClip | null {
    if (coachIndex !== LIA_COACH_INDEX) return null;
    for (const event of [...events].sort((a, b) => b.priority - a.priority)) {
      if (event.priority < 90 && !this.ready(ply, now)) continue;
      const counter = `${event.category}:${event.actor}`;
      if ((this.counts.get(counter) ?? 0) >= (LIMITS[event.category] ?? Infinity)) continue;
      const pool = LIA_CLIPS.filter(clip => clip.category === event.category && fits(clip, event));
      if (!pool.length) continue;
      const key = pool.map(clip => clip.id).join('|');
      let bag = this.bags.get(key);
      if (!bag?.length) {
        bag = [...pool];
        for (let i = bag.length - 1; i > 0; i--) {
          const j = Math.min(i, Math.max(0, Math.floor(this.random() * (i + 1))));
          [bag[i], bag[j]] = [bag[j], bag[i]];
        }
        if (bag.length > 1 && bag[bag.length - 1].id === this.lastId) [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
        this.bags.set(key, bag);
      }
      const clip = bag.pop()!;
      this.lastId = clip.id;
      this.lastAt = now;
      this.lastPly = ply;
      this.counts.set(counter, (this.counts.get(counter) ?? 0) + 1);
      return clip;
    }
    return null;
  }
}
