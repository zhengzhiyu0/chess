export type OpponentPersonality = 'sharp' | 'deadpan' | 'theatrical' | 'snarky';

export interface OpponentTalkEvent {
  /** The user's move immediately before the opponent's move, if any. */
  userSan?: string;
  opponentSan: string;
  /** The opponent took a piece with this move. */
  captured?: string;
  /** Material swing caused by the user's move, from the user's point of view. */
  userMaterialSwing?: number;
  opening?: boolean;
}

export const OPPONENT_PERSONALITIES: Record<OpponentPersonality, { label: string; description: string }> = {
  sharp: { label: '直球毒舌', description: '失误就直说，语气最锋利' },
  deadpan: { label: '冷面高手', description: '冷静、克制，但句句扎心' },
  theatrical: { label: '戏精挑衅', description: '把每一步都说得像一场大戏' },
  snarky: { label: '阴阳怪气', description: '表面客气，实际不太客气' },
};

type TemplateKind = 'opening' | 'capture' | 'check' | 'mate' | 'userCheck' | 'drop' | 'good' | 'neutral';

const LINES: Record<OpponentPersonality, Record<TemplateKind, string[]>> = {
  sharp: {
    opening: ['先手我收下了。轮到你证明自己。', '我已经落子，别把第一步就走成最后的体面。'],
    capture: ['谢谢你把一枚棋子送到我嘴边。', '这颗子放得真贴心，我就不客气了。'],
    check: ['将军。现在轮到你为刚才的选择负责。', '将军，别慌，慌了只会再送一枚。'],
    mate: ['将杀。棋盘已经替我结束了这场争论。', '将杀。你可以把刚才那步记进错题本了。'],
    userCheck: ['将军？气势不错，可惜我还没开始认真。', '这就将军了？先别急着庆祝。'],
    drop: ['这一步挺大胆，可惜大胆和正确不是一回事。', '你把局面交给我处理了，我会处理得很彻底。'],
    good: ['这步还算像样，终于让我认真看了一眼。', '不错，至少这一步没有替我下棋。'],
    neutral: ['棋盘上又多了一个可以利用的漏洞。', '我看见了。你最好也看见。'],
  },
  deadpan: {
    opening: ['我先走。请按自己的节奏犯错。', '开局完成。接下来只需要保持稳定。'],
    capture: ['感谢提供的免费子力。', '这枚棋子现在由我保管。'],
    check: ['将军。请用最少的时间找出最不坏的答案。', '将军。局面比刚才更容易解释了。'],
    mate: ['将杀。结论很简洁。', '将杀。到这里就足够了。'],
    userCheck: ['将军。一个合理的尝试。', '你将军了。暂时不影响结论。'],
    drop: ['这一步降低了你的选择质量。', '局面出现了一个不必要的缺口。'],
    good: ['这步不错。继续保持，别让它成为偶然。', '这一步通过了检查。'],
    neutral: ['收到。你的计划比你想象得更透明。', '局面继续发展，问题也继续保留。'],
  },
  theatrical: {
    opening: ['帷幕拉开！看看你能撑到第几幕。', '第一幕结束，我已经准备好看你的表演了。'],
    capture: ['精彩！你亲手把这枚棋子送上了舞台。', '掌声在哪里？这枚棋子已经完成谢幕。'],
    check: ['将军！主角终于登场，轮到你接台词了。', '警报拉响！这一步可没有彩排。'],
    mate: ['将杀！灯光熄灭，演出到此结束！', '终幕！你最后的台词是“我怎么没看到将军”。'],
    userCheck: ['将军！气氛突然紧张起来了，不过别忘了谁掌握剧本。', '好一记将军，剧情终于有点起伏了。'],
    drop: ['这不是伏笔，这是把剧情直接写崩了。', '观众都看见了，只有你的计划没有看见。'],
    good: ['漂亮的一幕。别急着谢幕，真正的戏还没结束。', '这步有点精彩，我差点忘了自己是反派。'],
    neutral: ['剧情继续推进，而你的漏洞也在聚光灯下。', '这一幕看似平静，下一幕可就不一定了。'],
  },
  snarky: {
    opening: ['我先来，免得你等太久。', '放心，我会尽量让你觉得这局很有教育意义。'],
    capture: ['多谢，包装都替我拆好了。', '你送得这么主动，我不收反而不礼貌。'],
    check: ['将军哦。希望你准备的答案比这步棋更周全。', '将军。别担心，尴尬很快就会过去的。'],
    mate: ['将杀。谢谢参与，复盘见。', '将杀。至少这局结束得很干脆。'],
    userCheck: ['哇，将军。你是想让我紧张一下吗？', '很有气势的将军。可惜气势不能替你赢棋。'],
    drop: ['这个漏洞很有创意，我差点没忍住笑。', '你这是在测试我的礼貌底线吗？'],
    good: ['这步不错，看来你偶尔也会给我惊喜。', '终于走了一步让我没法立刻吐槽的棋。'],
    neutral: ['嗯，计划很神秘。神秘到连你自己可能都不知道。', '我先记下这一步，等你亲自解释。'],
  },
};

function kindOf(e: OpponentTalkEvent): TemplateKind {
  if (e.opponentSan.includes('#')) return 'mate';
  if (e.opponentSan.includes('+')) return 'check';
  if (e.userSan?.includes('+') || e.userSan?.includes('#')) return 'userCheck';
  if (e.captured) return 'capture';
  if ((e.userMaterialSwing ?? 0) <= -1) return 'drop';
  if ((e.userMaterialSwing ?? 0) >= 1) return 'good';
  if (e.opening) return 'opening';
  return 'neutral';
}

/** Pick a line without waiting for a network request. The seed avoids repeats in adjacent moves. */
export function opponentTalk(personality: OpponentPersonality, event: OpponentTalkEvent, seed = 0): string {
  const set = LINES[personality] ?? LINES.sharp;
  const lines = set[kindOf(event)];
  return lines[Math.abs(seed) % lines.length];
}
