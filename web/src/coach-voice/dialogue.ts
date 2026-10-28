import catalog from './lines.json';
import roles from './roles.json';

export type CoachCategory =
  | 'opening_book_entry' | 'opening_book_exit' | 'player_accurate' | 'player_best' | 'player_brilliant'
  | 'lia_best_move' | 'capture_pawn' | 'capture_minor' | 'capture_rook' | 'capture_queen'
  | 'player_loses_minor' | 'player_loses_rook' | 'player_loses_queen'
  | 'tactic_fork' | 'tactic_pin' | 'tactic_discovered_attack' | 'tactic_zwischenzug' | 'tactic_sacrifice'
  | 'key_threat' | 'check' | 'player_check' | 'missed_mate' | 'blunder_into_mate' | 'mate'
  | 'castling' | 'promotion' | 'queen_early' | 'defense_found' | 'player_missed_tactic' | 'comeback';
export type Actor = 'player' | 'opponent';
export interface VoiceClip {
  id: string;
  role: string;
  coachIndex: number;
  category: CoachCategory;
  text: string;
  file: string;
  actors: Actor[];
  pieces?: string[];
}
export interface CoachEvent {
  category: CoachCategory;
  actor: Actor;
  piece?: string;
  /** Larger events replace smaller reactions to the same move. */
  priority: number;
}
export const COACH_VOICES = roles;
export const COACH_CLIPS = catalog as readonly VoiceClip[];
const byFile = new Map(COACH_CLIPS.map(clip => [clip.file, clip]));
export const hasCoachVoice = (index: number) => Number.isInteger(index) && roles.some(role => role.coachIndex === index);
export function isCoachClip(clip: VoiceClip, coachIndex: number): boolean {
  const canonical = byFile.get(clip.file);
  return !!canonical && canonical.coachIndex === coachIndex && canonical.id === clip.id && canonical.role === clip.role;
}

const LIMITS: Partial<Record<CoachCategory, number>> = {
  opening_book_entry: 1, opening_book_exit: 1, castling: 1,
  player_brilliant: 2, missed_mate: 1, comeback: 1,
};

/** One instance belongs to one game. State is also isolated by portrait. */
export class CoachDialogue {
  private states = new Map<number, {
    bags: Map<string, VoiceClip[]>;
    counts: Map<string, number>;
    lastId: string;
    lastPly: number;
    lastAt: number;
    lowWater: number;
  }>();
  constructor(private random = Math.random) {}

  private state(coachIndex: number) {
    let state = this.states.get(coachIndex);
    if (!state) {
      state = { bags: new Map(), counts: new Map(), lastId: '', lastPly: -100, lastAt: -Infinity, lowWater: 100 };
      this.states.set(coachIndex, state);
    }
    return state;
  }

  ready(ply: number, now: number, coachIndex: number): boolean {
    const state = this.state(coachIndex);
    return ply - state.lastPly >= 4 && now - state.lastAt >= 8000;
  }

  observe(playerWin: number, accuratePlayerMove: boolean, coachIndex: number): boolean {
    const state = this.state(coachIndex);
    state.lowWater = Math.min(state.lowWater, playerWin);
    return accuratePlayerMove && state.lowWater <= 20 && playerWin >= 45;
  }

  pick(events: readonly CoachEvent[], ply: number, now: number, coachIndex: number): VoiceClip | null {
    if (!hasCoachVoice(coachIndex)) return null;
    const state = this.state(coachIndex);
    for (const event of [...events].sort((a, b) => b.priority - a.priority)) {
      if (event.priority < 90 && !this.ready(ply, now, coachIndex)) continue;
      const counter = `${event.category}:${event.actor}`;
      if ((state.counts.get(counter) ?? 0) >= (LIMITS[event.category] ?? Infinity)) continue;
      const pool = COACH_CLIPS.filter(clip => clip.coachIndex === coachIndex && clip.category === event.category
        && clip.actors.includes(event.actor) && (!clip.pieces || (!!event.piece && clip.pieces.includes(event.piece))));
      if (!pool.length) continue;
      const key = pool.map(clip => clip.id).join('|');
      let bag = state.bags.get(key);
      if (!bag?.length) {
        bag = [...pool];
        for (let i = bag.length - 1; i > 0; i--) {
          const j = Math.min(i, Math.max(0, Math.floor(this.random() * (i + 1))));
          [bag[i], bag[j]] = [bag[j], bag[i]];
        }
        if (bag.length > 1 && bag[bag.length - 1].id === state.lastId) [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
        state.bags.set(key, bag);
      }
      const clip = bag.pop()!;
      state.lastId = clip.id;
      state.lastAt = now;
      state.lastPly = ply;
      state.counts.set(counter, (state.counts.get(counter) ?? 0) + 1);
      return clip;
    }
    return null;
  }
}
