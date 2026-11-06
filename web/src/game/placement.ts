import type { Glicko2Result } from './glicko2';

export type ChessExperience = 'unknown' | 'beginner' | 'casual' | 'regular' | 'skip';
export const EXPERIENCE_LEVELS = { beginner: 600, casual: 1000, regular: 1500 } as const;

/** Pairing advice only: never changes the official rating state. */
export function placementRecommendation(o: {
  rating: number; deviation: number; games: number; period: readonly Glicko2Result[];
  experience: ChessExperience; levels: readonly number[];
  recent?: readonly Glicko2Result[];
}): { opponent: number; reason: string } {
  const nearest = (rating: number) => o.levels.reduce((a, b) => Math.abs(b - rating) < Math.abs(a - rating) ? b : a, o.levels[0]);
  if (o.games < 10 && !o.period.length) return {
    opponent: o.experience in EXPERIENCE_LEVELS ? EXPERIENCE_LEVELS[o.experience as keyof typeof EXPERIENCE_LEVELS] : o.levels[0],
    reason: '棋力尚未确定，先选一个适合的对手；刚入门可从最低档开始。',
  };
  const results = o.recent?.length ? o.recent : o.period;
  if (o.games > 0 && results.length && (o.games < 10 || o.deviation > 100)) {
    const last = results.at(-1)!;
    const recent = results.slice(-2).filter(r => r.rating === last.rating);
    const index = o.levels.indexOf(nearest(last.rating));
    const direction = recent.length === 2 && recent.every(r => r.score === 1) ? 1
      : recent.length === 2 && recent.every(r => r.score === 0) ? -1 : 0;
    return { opponent: o.levels[Math.max(0, Math.min(o.levels.length - 1, index + direction))],
      reason: direction > 0 ? '最近两局在这一档都获胜，可以尝试高一档。'
        : direction < 0 ? '最近两局在这一档都失利，可以先降低一档。'
          : '定位中，建议继续当前档位积累结果；这不是已测出的棋力。' };
  }
  return { opponent: nearest(o.rating), reason: '根据当前暂定估分选择邻近档位，交替执白和执黑。' };
}
