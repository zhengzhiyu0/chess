// Puzzle categories and "what to train next": combines puzzle results per theme, the player's
// level and the error types collected in the mistake notebook.
import { THEME_LABEL, type PuzzleProgress } from './puzzles';
import type { TagStat } from './mistakes';

export interface ThemeGroup {
  title: string;
  themes: string[];
}

export const THEME_GROUPS: ThemeGroup[] = [
  { title: '基础战术', themes: ['hangingPiece', 'fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck', 'trappedPiece'] },
  {
    title: '进阶战术',
    themes: ['capturingDefender', 'deflection', 'attraction', 'sacrifice', 'clearance', 'interference', 'intermezzo', 'xRayAttack', 'quietMove', 'defensiveMove', 'promotion'],
  },
  { title: '将杀', themes: ['mateIn1', 'mateIn2', 'mateIn3', 'backRankMate', 'smotheredMate', 'mate'] },
  { title: '对局阶段', themes: ['opening', 'middlegame', 'endgame'] },
];

/** Core themes per level, most important first. */
const CURRICULUM: { below: number; name: string; themes: string[] }[] = [
  { below: 1000, name: '1000 分以下', themes: ['mateIn1', 'hangingPiece', 'fork', 'backRankMate'] },
  { below: 1400, name: '1000–1400 分', themes: ['fork', 'pin', 'mateIn2', 'skewer', 'discoveredAttack', 'hangingPiece'] },
  { below: 1800, name: '1400–1800 分', themes: ['deflection', 'attraction', 'capturingDefender', 'sacrifice', 'discoveredAttack', 'mateIn2'] },
  { below: Infinity, name: '1800 分以上', themes: ['quietMove', 'defensiveMove', 'intermezzo', 'clearance', 'mateIn3', 'sacrifice'] },
];

/** Too broad to be a useful recommendation; still playable from the category list. */
const NOT_RECOMMENDED = new Set(['mate', 'opening', 'middlegame', 'endgame']);

const MOTIF_THEMES: Record<string, string[]> = {
  fork: ['fork'],
  pin: ['pin'],
  skewer: ['skewer'],
  discovered: ['discoveredAttack'],
  'double-check': ['doubleCheck'],
  'remove-defender': ['capturingDefender'],
  trapped: ['trappedPiece'],
  free: ['hangingPiece'],
  'trade-up': ['hangingPiece'],
  promote: ['promotion'],
  'mate-threat': ['backRankMate', 'mateIn2'],
};

/** Puzzle themes that train against a mistake-notebook error type (see `mistakeTag`). */
export function themesForTag(tag: string, level: number): string[] {
  if (tag === 'hanging' || tag === 'miss-material') return ['hangingPiece'];
  if (tag === 'allow-mate' || tag === 'miss-mate') return [level < 1200 ? 'mateIn1' : 'mateIn2', 'backRankMate'];
  const m = /^(allow|miss)-(.+)$/.exec(tag);
  return m ? (MOTIF_THEMES[m[2]] ?? []) : [];
}

export interface Recommendation {
  theme: string;
  label: string;
  score: number;
  reasons: string[];
}

export interface RecommendInput {
  progress: PuzzleProgress;
  /** game rating, used until the puzzle rating has settled */
  elo: number;
  mistakes: TagStat[];
  /** puzzles available per theme */
  available: Record<string, number>;
}

/** Puzzles needed before the puzzle rating replaces the game rating as the level. */
export const SETTLED = 20;
const MIN_THEME = 50;

export function trainingLevel(p: PuzzleProgress, elo: number): number {
  return p.games >= SETTLED ? p.rating : elo;
}

export function curriculumFor(level: number) {
  return CURRICULUM.find((c) => level < c.below)!;
}

export function recommendThemes(o: RecommendInput, limit = 3): Recommendation[] {
  const p = o.progress;
  const level = trainingLevel(p, o.elo);
  const cur = curriculumFor(level);
  const overall = p.games ? p.solved / p.games : 0;
  // per theme: how often the player's own game errors would have been trained by it
  const fromGames = new Map<string, { n: number; labels: string[] }>();
  for (const s of o.mistakes) {
    const n = s.total - s.mastered + s.recent;
    if (n <= 0) continue;
    for (const t of themesForTag(s.tag, level)) {
      const e = fromGames.get(t) ?? { n: 0, labels: [] };
      e.n += n;
      e.labels.push(`${s.label} ${s.total} 次`);
      fromGames.set(t, e);
    }
  }
  const out: Recommendation[] = [];
  for (const theme of Object.keys(THEME_LABEL)) {
    if (NOT_RECOMMENDED.has(theme) || (o.available[theme] ?? 0) < MIN_THEME) continue;
    const [solved, failed] = p.byTheme[theme] ?? [0, 0];
    const n = solved + failed;
    let score = 0;
    const reasons: string[] = [];
    const g = fromGames.get(theme);
    if (g) {
      score += Math.min(3, 0.6 * g.n);
      reasons.push(`对局错题：${g.labels.slice(0, 2).join('、')}`);
    }
    if (n >= 5) {
      // shrink toward the overall rate so a few unlucky puzzles don't dominate
      const acc = (solved + 3 * overall) / (n + 3);
      const gap = overall - acc;
      if (gap > 0.05) {
        score += Math.min(3, gap * 12);
        reasons.push(`正确率 ${Math.round((solved / n) * 100)}%（${n} 题），低于你的平均 ${Math.round(overall * 100)}%`);
      } else if (n >= 10 && solved / n > overall + 0.1) score -= 1;
    }
    const core = cur.themes.indexOf(theme);
    if (core >= 0) {
      score += 1.2 - core * 0.1;
      if (n < 10) reasons.push(n ? `${cur.name}的核心题型，才练了 ${n} 题` : `${cur.name}的核心题型，还没练过`);
      else if (!reasons.length) reasons.push(`${cur.name}的核心题型`);
    }
    if (score > 0 && reasons.length) out.push({ theme, label: THEME_LABEL[theme], score, reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
