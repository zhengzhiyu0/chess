export type OpponentPersonality = 'sharp' | 'deadpan' | 'theatrical' | 'snarky' | 'arrogant' | 'playful' | 'poetic' | 'commentator';
export type CoachVoiceStyle = 'precise' | 'warm' | 'dramatic' | 'calm' | 'bold' | 'playful' | 'scholarly' | 'witty';

export interface OpponentTalkEvent {
  /** The user's move immediately before the opponent's move, if any. */
  userSan?: string;
  opponentSan: string;
  /** The opponent took a piece with this move. */
  captured?: string;
  /** The user took a piece with their immediately preceding move. */
  userCaptured?: string;
  userCapturedValue?: number;
  /** Material swing caused by the user's move, from the user's point of view. */
  userMaterialSwing?: number;
  opening?: boolean;
}

export const OPPONENT_PERSONALITIES: Record<OpponentPersonality, { label: string; description: string }> = {
  sharp: { label: '直球毒舌', description: '失误就直说，语气最锋利' },
  deadpan: { label: '冷面高手', description: '冷静、克制，但句句扎心' },
  theatrical: { label: '戏精挑衅', description: '把每一步都说得像一场大戏' },
  snarky: { label: '阴阳怪气', description: '表面客气，实际不太客气' },
  arrogant: { label: '自信狂', description: '永远觉得自己早已算尽' },
  playful: { label: '玩世不恭', description: '把棋局当成轻松的恶作剧' },
  poetic: { label: '诗人', description: '用夸张又带刺的比喻说话' },
  commentator: { label: '赛事解说', description: '像直播一样点评局面' },
};

/**
 * Each coach has a small, related personality pool. A game picks one style from
 * the selected coach's pool and keeps it for the whole game, so the coach stays
 * recognizable while consecutive games still feel different.
 *
 * The indexes follow COACHES in app/coach-avatars.ts.
 */
export const COACH_PERSONALITY_POOLS: readonly (readonly OpponentPersonality[])[] = [
  ['sharp', 'arrogant', 'commentator'],
  ['playful', 'theatrical', 'snarky'],
  ['deadpan', 'poetic', 'commentator'],
  ['deadpan', 'arrogant', 'sharp'],
  ['playful', 'snarky', 'theatrical'],
  ['sharp', 'commentator', 'arrogant'],
  ['poetic', 'deadpan', 'arrogant'],
  ['poetic', 'playful', 'deadpan'],
];

const COACH_STYLES: readonly CoachVoiceStyle[] = ['precise', 'warm', 'dramatic', 'calm', 'bold', 'playful', 'scholarly', 'witty'];

function coachStyleOf(index: number): CoachVoiceStyle {
  return COACH_STYLES[index] ?? 'precise';
}

function coachFlavor(style: CoachVoiceStyle, line: string, seed: number): string {
  const prefixes: Record<CoachVoiceStyle, readonly string[]> = {
    precise: ['先看事实：', '精确一点：', '关键在这里：'], warm: ['别急，', '我们一起看：', '慢慢来，'], dramatic: ['听好了——', '这一幕的焦点是：', '好戏来了：'], calm: ['冷静观察：', '慢一点。', '先稳住：'],
    bold: ['我就直说：', '大胆一点：', '别绕弯子：'], playful: ['嘿，', '棋盘开个小玩笑：', '来，看看这个：'], scholarly: ['从结构上看，', '记住这个规律：', '按棋理说，'], witty: ['我看见了哦：', '这一步挺会挑时间：', '有意思，'],
  };
  const options = prefixes[style];
  return `${options[Math.floor(Math.abs(seed) * 1_000_000) % options.length] ?? ''}${line}`;
}

function englishCoachFlavor(style: CoachVoiceStyle, line: string, seed: number): string {
  const prefixes: Record<CoachVoiceStyle, readonly string[]> = {
    precise: ['Let us be precise: ', 'Look at the facts: ', 'The key point is this: '], warm: ['No rush. ', 'Let us look together: ', 'Take your time. '], dramatic: ['Listen closely—', 'The focus of this scene is: ', 'Now the drama begins: '], calm: ['Stay calm. ', 'Observe carefully: ', 'Steady now. '],
    bold: ['I will be direct: ', 'Be bold: ', 'No detours: '], playful: ['Hey, ', 'A little chess joke: ', 'Come on, look at this: '], scholarly: ['From a structural view: ', 'Remember this pattern: ', 'By chess logic: '], witty: ['I saw that: ', 'That was well-timed: ', 'Interesting move: '],
  };
  const options = prefixes[style];
  return `${options[Math.floor(Math.abs(seed) * 1_000_000) % options.length] ?? ''}${line}`;
}

export function randomOpponentPersonality(coachIndex?: number): OpponentPersonality {
  const pool = coachIndex === undefined ? undefined : COACH_PERSONALITY_POOLS[Math.max(0, Math.floor(coachIndex))];
  const personalities = pool?.length ? pool : (Object.keys(OPPONENT_PERSONALITIES) as OpponentPersonality[]);
  return personalities[Math.floor(Math.random() * personalities.length)] ?? 'sharp';
}

const EXTRA_LINES: Partial<Record<OpponentPersonality, Record<TemplateKind, string[]>>> = {
  arrogant: {
    opening: ['我先走，因为这盘棋需要一个可靠的开场。', '开局而已，我已经看到中局了。', '别担心，我会把优势控制在礼貌范围内。', '这一手当然在我的计划里。', '你可以放心，我的计算通常不会迟到。'],
    capture: ['这枚子的位置早就写在我的清单上了。', '谢谢把我算过的目标送过来。', '拿走它只是执行计划，不必惊讶。', '棋子已经归位，局面也一样。', '这次收获符合预期。'],
    check: ['将军。答案很明显，只是你还没找到。', '王被我点名了，按计划处理即可。', '将军，我建议你相信计算结果。', '强制着法开始，局面不会替你犹豫。', '别紧张，我已经算到这里了。'],
    mate: ['将杀。正如预期。', '结论和计算完全一致：将杀。', '这一步之后，棋盘只剩一个答案。', '结束了，变化没有超出计划。', '将杀，感谢你配合验证。'],
    userCheck: ['将军看起来不错，但我已经准备好了。', '主动将军，仍在我的计算范围内。', '这一步有想法，不过还不够改变结论。', '你制造了压力，我已经安排了回应。', '可以，至少你找到了一个问题。'],
    userCapture: ['你拿走了一枚关键子，这个分支需要重算。', '这次确实吃到了重子，我承认。', '你抓住了我的漏洞，下一步要守住它。', '关键子损失，局面优势需要重新确认。', '不错的战术，暂时打乱了我的计划。'],
    drop: ['这个漏洞太明显了，几乎不需要计算。', '你给出的机会比我预想得还大。', '这一步让我的计划变得更简单。', '你把主动权交出来了，我会照收不误。', '这里的防守已经无法维持。'],
    good: ['这步合格，终于值得我多算一层。', '不错，但还没有超出我的预期。', '这一步准确，局面仍在可控范围。', '有点质量，不过优势还在我这边。', '你走得很好，接下来更容易犯错。'],
    neutral: ['局面按我的节奏继续。', '暂时没有意外发生。', '你的计划已经被我看见了。', '下一步会更接近结论。', '棋盘很安静，计算却很清楚。'],
  },
  playful: {
    opening: ['我先动一下，别让棋子闲着。', '开局啦，看看谁先把自己吓到。', '棋盘热身完毕，轮到你表演。', '我随手走走，你可别太认真。', '来玩一局，输赢先放一边，漏洞记得多一点。'],
    capture: ['哎呀，这颗子自己跑到我手里了。', '谢谢你帮我做了一个小小的清场。', '收好啦，棋子暂时借我玩玩。', '这份礼物包装得很漂亮。', '棋盘少了一颗糖，我先吃掉了。'],
    check: ['将军！轮到你玩躲猫猫了。', '王王王，快出来回答问题。', '给你一个小挑战，别把它变成大事故。', '将军来了，先别急着按暂停。', '你的王收到了一张紧急通知。'],
    mate: ['将杀！游戏结束，彩蛋也没有了。', '哎呀，玩着玩着就将杀了。', '这局的小剧场到此散场。', '将杀，王先下线啦。', '结束游戏，下一局记得带上防守。'],
    userCheck: ['将军？好玩起来了。', '你也会吓人嘛，再来一点。', '这步有趣，我得认真接住。', '王被你逗了一下，但还没投降。', '小小的将军，大大的自信。'],
    userCapture: ['哎呀，你把我的关键子拿走啦。', '这一下吃得真快，我的重子都没反应过来。', '你赢得一份棋子，记得好好保管。', '好吧，这个玩笑开到我身上了。', '我的关键子消失了，轮到我找乐子了。'],
    drop: ['哇，这里有个礼物，我可以打开吗？', '你是不是不小心把漏洞放出来了？', '这步很有创意，尤其是对我有利这一点。', '机会出现，先玩一下再说。', '这颗棋子看起来很孤单，我来陪它走。'],
    good: ['这步挺好，游戏难度突然上升了。', '不错嘛，这次我差点被你逗到。', '有趣的好棋，继续保持这个小游戏。', '这步让我笑不出来了，算你赢半句。', '可以可以，局面开始好玩了。'],
    neutral: ['继续走，看看棋盘还藏着什么。', '这一手先放在这里，稍后开奖。', '安静的一步，通常在憋着什么。', '棋子们都在移动，只有漏洞还没跑。', '我先记住这个小细节。'],
  },
  poetic: {
    opening: ['第一枚棋子落下，风暴已经有了方向。', '棋盘铺开，命运暂时站在我这一边。', '序诗写下，剩下的交给你的计算。', '黑白交错，第一处阴影已经出现。', '这一手像一扇门，门后没有轻松的路。'],
    capture: ['一枚棋子沉入寂静，留下的是我的回声。', '你送来的棋子，成了我阵地上的一盏灯。', '这次交换像潮水，悄悄带走你的力量。', '棋子落幕，局面却更加喧哗。', '我拾起这枚子，像拾起你计划的碎片。'],
    check: ['将军，王的影子被逼到了墙角。', '一道锋刃划过棋盘，王必须回答。', '将军，沉默的局面终于发出声音。', '你的王听见了风声，答案正在远处。', '这一手把危险写进了棋谱。'],
    mate: ['将杀，棋盘的最后一盏灯熄灭。', '终章落笔，王的旅途停在这里。', '将杀，所有未说出口的计划归于寂静。', '棋局合上书页，结尾比开头更安静。', '这一幕结束，黑白都不再争辩。'],
    userCheck: ['你的将军像一道闪电，照亮了短暂的希望。', '王听见你的挑战，风向因此改变了一瞬。', '这一声将军很响，能否成为真正的雷雨？', '你在平静的湖面投下一颗石子。', '好一处锋芒，暂时逼我转身。'],
    userCapture: ['你取走了我的关键子，像剪断一根命运的线。', '重子坠落，棋盘的诗句突然换了韵脚。', '这一口吃子，带走了我计划的一部分光。', '你拾走一枚重要棋子，优势开始改写。', '这次交换留下伤口，我必须从阴影里重生。'],
    drop: ['你在阵地上留下裂缝，风从那里吹进来。', '这一步像一扇忘了关的门。', '机会落在棋盘上，安静得几乎没有声音。', '你的防线泛起涟漪，我只需伸手触碰。', '这处空白，正好容得下我的计划。'],
    good: ['这一手很稳，像在风里点亮一盏灯。', '好棋让棋盘重新有了秩序。', '你的锋芒掠过棋面，我必须认真回应。', '这一步有重量，局面也因此更有回声。', '漂亮的落子，暂时把阴影推远。'],
    neutral: ['棋盘呼吸着，秘密仍藏在下一步。', '平静只是暴风雨尚未说话。', '你的计划像一条尚未走完的河。', '黑白继续交换位置，答案还在远方。', '这一手落下，新的问题随之生长。'],
  },
  commentator: {
    opening: ['比赛正式开始！先手一方抢占节奏。', '开局落子完成，双方进入计算阶段。', '观众朋友们，第一回合的气氛已经起来了。', '比赛开场，接下来每个细节都可能重要。', '棋盘准备完毕，选手们开始交锋。'],
    capture: ['漂亮的吃子！这枚棋子离场，局面出现变化。', '现场观众看到了，机器人成功完成一次收割。', '一枚棋子被带走，交换结果对我方有利。', '这次取子干净利落，值得回放。', '棋盘出现缺口，机器人抓住了机会。'],
    check: ['将军！这是一个必须立即处理的强制局面。', '王受到攻击，比赛进入高压时刻。', '将军落下，下一步选择空间明显收窄。', '警报响起，防守方需要快速应对。', '这一步制造了直接威胁，场上气氛紧张。'],
    mate: ['将杀！比赛在这里结束，结果已经确定。', '终局确认，王无法逃脱。', '将杀完成，这是一记决定性落子。', '比赛结束，最后的战术非常清楚。', '终场哨响，棋局没有进入下一回合。'],
    userCheck: ['精彩将军！玩家拿到了主动权。', '这一步制造压力，机器人需要认真应对。', '主动将军出现，比赛进入新的阶段。', '玩家发起挑战，局面出现短暂波动。', '这是一记有内容的将军，值得继续观察。'],
    userCapture: ['关键子被吃！这是本局重要的转折点。', '玩家完成重子收割，机器人需要调整方案。', '漂亮的战术，机器人损失了一枚重要棋子。', '现场出现反转，玩家拿到了实质性收益。', '这次取子改变了物资平衡，比赛更有悬念了。'],
    drop: ['出现明显漏洞！机器人获得了可执行的机会。', '玩家的防守出现缺口，局面开始倾斜。', '这一步给了对手直接的战术入口。', '机会已经出现，机器人很可能马上利用。', '比赛走势发生变化，问题出在这一手。'],
    good: ['稳健的一步，玩家保持住了局面质量。', '这步棋很有分量，比赛继续保持张力。', '漂亮处理，玩家没有给出轻易的机会。', '局面质量提升，这一步值得肯定。', '比赛仍然开放，双方都保持着选择。'],
    neutral: ['局面继续推进，双方仍在试探。', '这一手暂时没有改变评价，比赛保持开放。', '棋局进入中段，后续计算会更加关键。', '双方完成一次调整，悬念仍然保留。', '现场安静了一拍，但局面并不简单。'],
  },
};

type TemplateKind = 'opening' | 'capture' | 'check' | 'mate' | 'userCheck' | 'userCapture' | 'drop' | 'good' | 'neutral';

const LINES: Partial<Record<OpponentPersonality, Record<TemplateKind, string[]>>> = {
  sharp: {
    opening: ['先手我收下了。轮到你证明自己。', '我已经落子，别把第一步就走成最后的体面。', '开局就绪。希望你的计划不只是看起来像计划。', '棋盘摆好了，失误也请按顺序来。', '终于开局了，我还以为你在等棋子自己走。', '我先走一步，给你一点追赶的机会。'],
    capture: ['谢谢你把一枚棋子送到我嘴边。', '这颗子放得真贴心，我就不客气了。', '收下了。下次送皇后吧，那个更值钱。', '这不是交易，是你单方面捐赠。', '你看，棋子离开棋盘之后确实安全多了。', '拿走了。你应该不会想念它太久吧。'],
    check: ['将军。现在轮到你为刚才的选择负责。', '将军，别慌，慌了只会再送一枚。', '将军。刚才那步的后果现在上门了。', '请处理将军，借口可以等棋后再想。', '将军！这次可没有悔棋按钮。', '我给王安排了个问题，你慢慢答。'],
    mate: ['将杀。棋盘已经替我结束了这场争论。', '将杀。你可以把刚才那步记进错题本了。', '终局。至少这次不用再猜下一步了。', '将杀。你的王比你的计划先认输了。', '结束了。复盘时记得从那个漏洞开始看。', '将杀！谢谢配合完成这场教学演示。'],
    userCheck: ['将军？气势不错，可惜我还没开始认真。', '这就将军了？先别急着庆祝。', '将军收到，我会把它当作一次礼貌提醒。', '好一个将军。可惜我的王还没写遗书。', '有威胁，值得表扬；能不能兑现再说。', '将军挺响，实际效果我们马上验证。'],
    userCapture: ['你吃掉了我的关键子？好，这下我得认真了。', '这颗子我记下了。你最好有后续计划。', '漂亮，拿走我的重要棋子之后可别松懈。', '你确实吃到了关键子。现在轮到我找补了。', '这笔账我先记着，棋还没下完呢。', '好吧，这次是我丢了贵子。别高兴太早。', '你拿走了我的关键棋子，希望你守得住优势。', '看来你不是只会送子，偶尔也会收账。'],
    drop: ['这一步挺大胆，可惜大胆和正确不是一回事。', '你把局面交给我处理了，我会处理得很彻底。', '这里出现了个洞，我就不假装没看见了。', '你刚刚给了我一个相当明确的邀请。', '好机会摆在这儿，我可不会客气。', '这步棋的后果，可能比你预想得贵一点。'],
    good: ['这步还算像样，终于让我认真看了一眼。', '不错，至少这一步没有替我下棋。', '可以，这步让我少了一句吐槽。', '好棋。别习惯性地把下一步又送回来。', '这下有点意思了，我得重新算算。', '承认一下，这步走得比我预期好。'],
    neutral: ['棋盘上又多了一个可以利用的漏洞。', '我看见了。你最好也看见。', '收到，我先把这个局面记在心里。', '看起来平静，漏洞通常也喜欢这样伪装。', '你在推进计划，我在找计划里的问题。', '这一手暂时过关，暂时。'],
  },
  deadpan: {
    opening: ['我先走。请按自己的节奏犯错。', '开局完成。接下来只需要保持稳定。', '第一步已经走完，复杂度仍然可控。', '请继续，我会观察局面变化。', '棋盘进入工作状态。', '开始了，希望你的计算也已经开始。'],
    capture: ['感谢提供的免费子力。', '这枚棋子现在由我保管。', '物资已接收，感谢配合。', '交换条件对我很有利。', '一枚棋子离开了你的阵营。记录一下。', '这次收获不需要额外解释。'],
    check: ['将军。请用最少的时间找出最不坏的答案。', '将军。局面比刚才更容易解释了。', '王目前需要立刻处理这个问题。', '将军。候选着的数量正在减少。', '这里有个强制问题，请开始作答。', '局面提醒：你的王现在不太自由。'],
    mate: ['将杀。结论很简洁。', '将杀。到这里就足够了。', '计算结束，结果没有歧义。', '将杀。无需再增加说明。', '对局终止。问题定位并不困难。', '这是一个可以直接确认的结论。'],
    userCheck: ['将军。一个合理的尝试。', '你将军了。暂时不影响结论。', '收到将军。王的安全问题已处理。', '有了主动性，后续请保持准确。', '这个将军值得计算，但还不构成结论。', '局面出现压力，尚在可控范围。'],
    userCapture: ['你吃掉了我的关键子。局面需要重新评估。', '这枚重子损失了。你的下一步值得关注。', '这次交换对你有利，我已经记录。', '关键子被拿走，原计划暂时作废。', '你的战术成立。这一步确实不错。', '这颗子是我漏算了，局面发生变化。', '物资统计：我方损失一枚重要棋子。', '你找到了目标。请继续证明优势。'],
    drop: ['这一步降低了你的选择质量。', '局面出现了一个不必要的缺口。', '这里的防守资源减少了。', '这项选择带来了可以利用的弱点。', '你让我的计算变得更直接了。', '当前局面的风险有所上升。'],
    good: ['这步不错。继续保持，别让它成为偶然。', '这一步通过了检查。', '准确的一步，局面保持稳定。', '你的处理方式是合理的。', '这步棋经得起检验。', '不错，继续维持这个质量。'],
    neutral: ['收到。你的计划比你想象得更透明。', '局面继续发展，问题也继续保留。', '暂时没有新的异常，继续。', '你的意图已经进入计算范围。', '结构稳定，下一步会更关键。', '记录完成。局面仍需持续观察。'],
  },
  theatrical: {
    opening: ['帷幕拉开！看看你能撑到第几幕。', '第一幕结束，我已经准备好看你的表演了。', '灯光就位，棋子就位，压力也就位。', '开场完成！观众请注意，失误即将登台。', '序幕已经揭开，结局暂时由我保管。', '各位观众，欢迎来到你的计算力测试。'],
    capture: ['精彩！你亲手把这枚棋子送上了舞台。', '掌声在哪里？这枚棋子已经完成谢幕。', '这颗棋子杀青了，下一位请准备。', '道具组，把这枚棋子请下场。', '一场漂亮的收割，感谢你提供素材。', '棋盘少了一子，戏剧冲突多了一分。'],
    check: ['将军！主角终于登场，轮到你接台词了。', '警报拉响！这一步可没有彩排。', '将军！王的独角戏现在开始。', '全场注意，接下来是强制剧情。', '聚光灯打在你的王上，请即兴发挥。', '将军！这场戏可不能暂停。'],
    mate: ['将杀！灯光熄灭，演出到此结束！', '终幕！你最后的台词是“我怎么没看到将军”。', '谢幕！王已经退场，观众也可以散了。', '大结局来了，而且没有续集。', '将杀！这幕的反转来得有点晚。', '演出结束，感谢你贡献的剧情。'],
    userCheck: ['将军！气氛突然紧张起来了，不过别忘了谁掌握剧本。', '好一记将军，剧情终于有点起伏了。', '主角发起反击了！这回我得认真接戏。', '将军很有戏，结局还需要继续演。', '漂亮的转折，看看能不能把它变成高潮。', '王收到你的挑战，剧本暂时还没改。'],
    userCapture: ['你吃掉了我的关键子？这段剧情我可没排练。', '重子退场！好家伙，主角真的开始反击了。', '这一刀切得漂亮，我的剧本得重写了。', '你拿走了我的重要棋子，观众开始站你这边了。', '关键子杀青了？好吧，这幕你演得不错。', '这次轮到我丢道具了，场面有点失控。', '精彩反转！我方重子已经离场。', '你吃到了大子，别急着谢幕，后面还有戏。'],
    drop: ['这不是伏笔，这是把剧情直接写崩了。', '观众都看见了，只有你的计划没有看见。', '这段剧情的漏洞大到能走进一辆马车。', '导演喊卡！这步需要重新拍。', '你给反派安排了一个很方便的入口。', '这不是意外，是剧情主动送来的机会。'],
    good: ['漂亮的一幕。别急着谢幕，真正的戏还没结束。', '这步有点精彩，我差点忘了自己是反派。', '这场戏终于有了值得鼓掌的部分。', '好棋！主角光环暂时亮了一下。', '节奏不错，观众开始认真看了。', '你这一手把剧情推进得很漂亮。'],
    neutral: ['剧情继续推进，而你的漏洞也在聚光灯下。', '这一幕看似平静，下一幕可就不一定了。', '镜头切回棋盘，危险还在暗处等着。', '音乐渐强，局面还没揭晓。', '双方继续落子，悬念暂时保留。', '这段过场很平静，通常不是好兆头。'],
  },
  snarky: {
    opening: ['我先来，免得你等太久。', '放心，我会尽量让你觉得这局很有教育意义。', '开局啦，希望你的计划比你的表情更从容。', '第一步已经走了，接下来请自由发挥。', '棋盘准备好了，你的信心也准备好了吗？', '我先走一步，你可以假装早有预料。'],
    capture: ['多谢，包装都替我拆好了。', '你送得这么主动，我不收反而不礼貌。', '这枚棋子我就笑纳了，真是太客气。', '不用这么周到，自己留一枚也行。', '收下啦，下次不用特地送到门口。', '哎呀，怎么又有棋子自己走过来了。'],
    check: ['将军哦。希望你准备的答案比这步棋更周全。', '将军。别担心，尴尬很快就会过去的。', '麻烦处理一下将军，别光顾着欣赏。', '将军来了，您的应急方案在哪儿呢？', '王被点名了，请尽快回应。', '这步附赠一个将军，不用谢。'],
    mate: ['将杀。谢谢参与，复盘见。', '将杀。至少这局结束得很干脆。', '哎呀，结束了。下次我们再努力装作势均力敌。', '将杀。你可以把“差一点”留到复盘里说。', '大功告成，感谢你一路配合。', '结束得挺快，省下来的时间可以复盘。'],
    userCheck: ['哇，将军。你是想让我紧张一下吗？', '很有气势的将军。可惜气势不能替你赢棋。', '将军哦，看来你也准备认真一下了。', '这步有点意思，我收回半句吐槽。', '王收到邀请了，不过我暂时不想赴约。', '很漂亮的将军，别让我夸第二次。'],
    userCapture: ['你吃掉我的关键子了？这可不在礼貌范围内。', '哎呀，我的重子怎么就不见了。', '这颗子挺重要的，你拿得倒是很自然。', '好吧，这次确实是你赚到了。', '吃得漂亮。现在你可以暂时得意一下。', '我方关键棋子已离场，能不能先不告诉观众？', '这笔交换你占便宜了，别截图留证。', '拿走我的大子之后，希望你记得继续下棋。'],
    drop: ['这个漏洞很有创意，我差点没忍住笑。', '你这是在测试我的礼貌底线吗？', '哇，这么明显的机会，我都不好意思了。', '你把答案写在棋盘上，我只好照着做。', '这步棋挺慷慨的，真的不用这么客气。', '我本来没想占便宜，是你坚持要给。'],
    good: ['这步不错，看来你偶尔也会给我惊喜。', '终于走了一步让我没法立刻吐槽的棋。', '可以，这步我先不挑毛病。', '好棋。你是不是偷偷练过？', '这下有点麻烦了，我得认真应付。', '不错，今天的惊喜额度用掉一半了。'],
    neutral: ['嗯，计划很神秘。神秘到连你自己可能都不知道。', '我先记下这一步，等你亲自解释。', '好的，我们继续假装这步完全在计划之中。', '棋盘看着挺平静，你确定吗？', '这一步我先收下，稍后再发表意见。', '局面还在发展，借口也可以继续准备。'],
  },
};

/** Extra everyday replies and reactions to moves with a distinct story. */
const SITUATION_LINES: Record<OpponentPersonality, Record<'neutral' | 'castle' | 'promotion', string[]>> = {
  sharp: {
    neutral: ['别只盯着我要走哪儿，也看看你留下了什么。', '这一步落稳了？下一步可别只凭感觉。', '棋盘还很挤，计划最好别太拥挤。', '你有你的路线，我有我的问题。', '这回合先记着，答案要在棋盘上给。', '走得挺从容，希望计算也跟上了。'],
    castle: ['王先住稳，其他棋子才好出去找事。', '易位完成。接下来轮到车上班了。', '王换个住处，你别以为我准备休息。'],
    promotion: ['兵走到底也能换身份，你的防线得重新算了。', '升变了。小兵的野心可比你想得大。', '新的战力到位，旧的防守方案该更新了。'],
  },
  deadpan: {
    neutral: ['先确认威胁，再决定计划。顺序很重要。', '这步落下后，双方都需要重新检查。', '我在比较几个候选着。', '局面没有强制答案，耐心也是资源。', '下一次交换之前，先把账算清。', '这一步改变了棋子的配合关系。'],
    castle: ['易位完成，王车的位置已调整。', '王的部署告一段落，开始协调其他棋子。', '车已连接到新的线路。请继续。'],
    promotion: ['升变完成，子力配置需要更新。', '兵已到达底线，新棋子开始参与计算。', '升变后的威胁，需要单独处理。'],
  },
  theatrical: {
    neutral: ['配角也有台词，别只盯着皇后看。', '这一幕先收住，悬念要留到落子后。', '镜头拉远，每颗棋子都在等自己的戏份。', '场上的安静，是计算开始前的停顿。', '新的布景已经摆好，你准备怎么接戏？', '先别急着写结尾，中场还没散。'],
    castle: ['王移驾，车登台！这一幕换个主角。', '易位完成，王室迁居，战车开工。', '灯光转向另一侧，王已经换好布景。'],
    promotion: ['小兵逆袭！新角色隆重登场。', '走到最后一排，配角终于拿到主演剧本。', '升变完成！道具组，换一枚更有戏的棋子。'],
  },
  snarky: {
    neutral: ['挺有想法，落子之后也记得检查一下。', '你慢慢布局，我正好看看有没有惊喜。', '这个回合很安静，难得我们都这么含蓄。', '先别忙着满意，棋盘还等着下一句呢。', '这步我看到了，至于后续，就看你的诚意了。', '计划可以慢慢来，漏看的棋子最好别太多。'],
    castle: ['王搬家了，总得有个安稳的住处嘛。', '易位一下，免得王老是抢镜。', '我把王安顿好了，你随意。'],
    promotion: ['小兵都升职了，你的防守方案也升级一下？', '升变啦，多走几步果然有回报。', '这枚兵一路走来不容易，值得换个身份。'],
  },
  arrogant: {
    neutral: ['这一回合，我选择继续完善部署。', '值得计算的变化，我一个也不会放过。', '棋子各就各位，计划才刚开始展开。', '耐心一点，我还在筛选最合适的路线。', '这步走完，下一轮的候选着已经排好了。', '每个安静的回合，也都值得精确处理。'],
    castle: ['易位。这种部署当然也在计划之内。', '先安顿王，再安排车的工作，我一向有条理。', '王的位置调整完毕，下一阶段开始。'],
    promotion: ['升变完成，我说过小兵也在计划里。', '最后一排只是起点，新的棋子已经就绪。', '这枚兵完成了任务，接下来换新身份执行。'],
  },
  playful: {
    neutral: ['我的棋子排好队了，你的呢？', '这个回合先埋个小彩蛋。', '棋盘这么大，总有地方可以逛逛。', '我挪好了，看看你会接出什么花样。', '先不揭晓下一步，留点好玩的。', '别催，棋子也得商量一下去哪儿玩。'],
    castle: ['王和车换了个队形，像不像偷偷搬家？', '易位！王找好了躲猫猫的新位置。', '王收拾好行李，车终于能出来兜风了。'],
    promotion: ['小兵通关啦，领取一个新身份！', '恭喜这枚兵，走到底线解锁换装。', '升变！小个子突然有大本事了。'],
  },
  poetic: {
    neutral: ['棋子落定，下一段故事还没有名字。', '每条斜线都有远方，每个格子都有来客。', '此刻的安静，容得下一次深呼吸。', '我把计划放在棋盘上，等你的回应。', '一枚子挪开，另一枚子的视野便改变了。', '时间沿着黑白格前行，我们各写一行。'],
    castle: ['王迁入新的城堡，车踏上另一段旅程。', '易位，像把一盏灯移到避风的窗前。', '王暂歇脚步，车开始眺望远处的道路。'],
    promotion: ['小兵走过漫长的路，终于换上新的名字。', '底线不是终点，而是蜕变的门。', '一枚兵的远行，在此刻长出了新的翅膀。'],
  },
  commentator: {
    neutral: ['选手完成调整，接下来关注棋子之间的配合。', '这一回合没有吃子，布局的选择依然值得看。', '镜头给到全盘，双方的路线正在展开。', '比赛继续，下一次接触可能改变节奏。', '落子完成，轮到另一方给出回应。', '双方都保留了选择，比赛还有很多内容。'],
    castle: ['易位完成！王与车同时调整了位置。', '王的部署告一段落，接下来关注车的活动。', '场上出现易位，双方进入新的布局阶段。'],
    promotion: ['升变完成！一枚兵走到了棋盘底线。', '新棋子登场，场上的子力配置发生改变。', '这是一次重要的升变，后续威胁需要重新计算。'],
  },
};

function kindOf(e: OpponentTalkEvent): TemplateKind {
  if (e.opponentSan.includes('#')) return 'mate';
  if ((e.userCapturedValue ?? 0) >= 3) return 'userCapture';
  if (e.opponentSan.includes('+')) return 'check';
  if (e.userSan?.includes('+') || e.userSan?.includes('#')) return 'userCheck';
  if (e.captured) return 'capture';
  if ((e.userMaterialSwing ?? 0) <= -1) return 'drop';
  if ((e.userMaterialSwing ?? 0) >= 1) return 'good';
  if (e.opening) return 'opening';
  return 'neutral';
}

/**
 * Situation-aware additions keep the voice varied without turning every line
 * into the same sentence with a word swapped. Piece names come from the move
 * event, so one idea can naturally react to a bishop, rook, queen, or pawn.
 */
function contextualLines(personality: OpponentPersonality, event: OpponentTalkEvent, kind: TemplateKind, situation: 'promotion' | 'castle' | null): string[] {
  const myPiece = event.userCaptured ? `我的${event.userCaptured}` : '';
  const yourPiece = event.captured ? `你的${event.captured}` : '';
  const ownLoss: Record<OpponentPersonality, string[]> = {
    sharp: [
      `啊，${myPiece}也能被你抓住？这笔账我记下了。`,
      `你盯上的偏偏是${myPiece}，这一手有点东西。`,
      `${myPiece}没了，别以为我会因此停手。`,
      `漂亮的交换。${myPiece}倒下之后，轮到你承受压力了。`,
      `我承认，${myPiece}这次走得太冒险。`,
    ],
    deadpan: [
      `${myPiece}离场。局面仍然可以继续。`,
      `记录一下：${myPiece}损失，补偿方案稍后计算。`,
      `你拿走了${myPiece}。这不是好消息，但也不是结论。`,
      `${myPiece}的价值已经兑现，至少从你的角度看是这样。`,
      `确认丢失${myPiece}。接下来按新物质平衡处理。`,
    ],
    theatrical: [
      `啊！我的${event.userCaptured}谢幕了，而且谢幕得很突然！`,
      `聚光灯打在${myPiece}身上——等等，它已经退场了！`,
      `这一幕的反转是：你带走了${myPiece}。`,
      `${myPiece}倒在舞台中央，剧情可没有因此结束。`,
      `好一场夺子戏！${myPiece}成了今天的主角。`,
    ],
    snarky: [
      `哎呀，${myPiece}送到你手里了，满意了吗？`,
      `你挑得真准，偏偏拿走${myPiece}。`,
      `${myPiece}没了。恭喜，这次总算看见了。`,
      `当然可以吃${myPiece}，我只是想看看你会不会真的动手。`,
      `很好，${myPiece}替你完成了最简单的一步。`,
    ],
    arrogant: [
      `你拿走${myPiece}，只是执行了我允许的交换。`,
      `${myPiece}的损失已经写进我的计算里。`,
      `不错，${myPiece}给了你一个看似舒服的选择。`,
      `我当然看见了${myPiece}会丢，只是你还没看见下一步。`,
      `一枚${event.userCaptured}而已，别急着把它算成胜势。`,
    ],
    playful: [
      `哎呀，我的${event.userCaptured}被你拐走啦！`,
      `${myPiece}下班了，棋盘上又空出一个座位。`,
      `你和${myPiece}玩得挺开心？那我可要捣乱了。`,
      `糟糕，${myPiece}没跟上队伍，先去休息了。`,
      `这次是${myPiece}的冒险失败，下一位谁来接班？`,
    ],
    poetic: [
      `一盏灯熄灭了，${myPiece}沉入棋盘的暮色。`,
      `${myPiece}离开原位，留下一个等待回声的空格。`,
      `你带走${myPiece}，像从棋局里剪下一行诗。`,
      `这枚${event.userCaptured}落幕，风向却还没有决定。`,
      `失去${myPiece}之后，棋盘的呼吸换了节拍。`,
    ],
    commentator: [
      `关键事件：${myPiece}被吃，双方物质平衡发生变化。`,
      `现场确认，${myPiece}离场，这会影响接下来的攻防路线。`,
      `一枚${event.userCaptured}被带走，选手需要立即重估局面。`,
      `漂亮的取子！${myPiece}的消失让这回合有了明确主题。`,
      `注意这个细节：${myPiece}损失之后，开放线正在形成。`,
    ],
  };
  const opponentCapture: Record<OpponentPersonality, string[]> = {
    sharp: [`${yourPiece}落网，别把它当成偶然。`, `我拿走${yourPiece}，现在轮到你解释这步了。`, `${yourPiece}留下了缺口，我会继续追。`],
    deadpan: [`${yourPiece}被吃。交换结果符合当前计算。`, `取走${yourPiece}，局面进入下一阶段。`, `${yourPiece}消失，线路变得更清楚了。`],
    theatrical: [`${yourPiece}退场！这一幕的布景完全变了。`, `一记取子，${yourPiece}从剧情中消失。`, `谢幕吧，${yourPiece}已经没有台词了。`],
    snarky: [`谢谢你把${yourPiece}送过来，包装还挺完整。`, `${yourPiece}就这样走了？我还以为你会保护它。`, `拿走${yourPiece}，至少这一步不用猜。`],
    arrogant: [`${yourPiece}按计划离场，结果没有悬念。`, `取走${yourPiece}，这正是它应该出现的位置。`, `${yourPiece}的命运早已写在这条线上。`],
    playful: [`${yourPiece}被我捉住啦！`, `来，${yourPiece}先坐我的车。`, `${yourPiece}掉队了，我就顺手带走。`],
    poetic: [`${yourPiece}沉入黑白交界，棋路因此改写。`, `我拾起${yourPiece}，像拾起一片落叶。`, `${yourPiece}离场，空格开始说话。`],
    commentator: [`取子完成：${yourPiece}离场，局面出现新的焦点。`, `${yourPiece}被吃，交换后的线路值得重点观察。`, `一枚${event.captured}退出战场，双方计划随之调整。`],
  };
  const promotion: Record<OpponentPersonality, string[]> = {
    sharp: ['兵终于升变，别让这份威胁白白长大。', '升变完成，棋盘上多了一个必须回答的问题。'],
    deadpan: ['升变已发生。新的子力需要重新计入。', '兵完成晋升，局面参数发生变化。'],
    theatrical: ['小兵登台换装，下一幕直接升级！', '升变！旧角色退场，新角色抢走了聚光灯。'],
    snarky: ['兵都升变了，你现在总该认真一点了吧？', '恭喜小兵毕业，顺便给你制造麻烦。'],
    arrogant: ['升变只是计划的收尾，不必惊讶。', '新子力登场，正好执行下一段计算。'],
    playful: ['小兵换上新皮肤，突然变得很能打！', '升级成功！棋盘上多了一位新朋友。'],
    poetic: ['小兵走到尽头，化作一束新的锋芒。', '漫长的跋涉终于开花，升变改写了棋盘的光线。'],
    commentator: ['重大节点：兵完成升变，攻防资源重新洗牌。', '升变落地，双方必须立即评估新子力的活动范围。'],
  };
  if (situation === 'promotion') return promotion[personality];
  if (kind === 'userCapture' && myPiece) return ownLoss[personality];
  if (kind === 'capture' && yourPiece) return opponentCapture[personality];
  return [];
}

const ENGLISH_PIECES: Record<string, string> = { '兵': 'pawn', '马': 'knight', '象': 'bishop', '车': 'rook', '后': 'queen', '王': 'king' };

function englishPiece(piece: string | undefined): string {
  return ENGLISH_PIECES[piece ?? ''] ?? 'piece';
}

/** Short English equivalents for the same event, used only by system TTS. */
export function opponentVoiceLine(personality: OpponentPersonality, event: OpponentTalkEvent, seed = Math.random(), coachIndex = 0): string {
  const kind = kindOf(event);
  const situation = !event.opponentSan.includes('#') && /=[QRBN]/.test(event.opponentSan) ? 'promotion'
    : kind === 'neutral' && event.opponentSan.startsWith('O-O') ? 'castle' : null;
  const myPiece = englishPiece(event.userCaptured);
  const yourPiece = englishPiece(event.captured);
  const lines: string[] = situation === 'promotion'
    ? ({
        sharp: ['Promotion. Now answer this threat.', 'That pawn made it through. Find a response.'],
        deadpan: ['Promotion confirmed. Recalculate the position.', 'A new piece has entered the position.'],
        theatrical: ['Promotion! A new star takes the stage.', 'The pawn has transformed for the final act.'],
        snarky: ['A promotion. I hope you noticed this time.', 'The pawn got an upgrade. Good luck.'],
        arrogant: ['Promotion, exactly as calculated.', 'The promotion completes the plan.'],
        playful: ['Promotion! That little pawn just leveled up.', 'New piece, new trouble!'],
        poetic: ['The pawn reaches the horizon and becomes light.', 'A long journey ends in a new form.'],
        commentator: ['Major event: promotion changes the balance.', 'Promotion completed; both plans must be reassessed.'],
      } as Record<OpponentPersonality, string[]>)[personality]
    : kind === 'userCapture' && event.userCaptured
      ? ({
          sharp: [`Ah, my ${myPiece}. I will remember that.`, `You found my ${myPiece}; now deal with the pressure.`],
          deadpan: [`My ${myPiece} is gone. The position continues.`, `Loss recorded: my ${myPiece}. Recalculating.`],
          theatrical: [`My ${myPiece} leaves the stage!`, `A dramatic turn: you captured my ${myPiece}.`],
          snarky: [`Well done, you found my ${myPiece}.`, `My ${myPiece} is gone. Happy now?`],
          arrogant: [`You took my ${myPiece}; the exchange was allowed.`, `My ${myPiece} was already part of the calculation.`],
          playful: [`Oops, my ${myPiece} got carried away!`, `You caught my ${myPiece}. Nice little trap.`],
          poetic: [`My ${myPiece} fades into the quiet of the board.`, `You took my ${myPiece}; the rhythm has changed.`],
          commentator: [`Key moment: my ${myPiece} has been captured.`, `The loss of my ${myPiece} changes the balance.`],
        } as Record<OpponentPersonality, string[]>)[personality]
      : kind === 'capture' && event.captured
        ? ({
            sharp: [`Your ${yourPiece} is gone. Keep calculating.`, `I took your ${yourPiece}; this line is mine now.`],
            deadpan: [`Your ${yourPiece} was captured. Continue.`],
            theatrical: [`Your ${yourPiece} exits the stage!`, `One capture, and the whole scene changes.`],
            snarky: [`Thanks for leaving your ${yourPiece} there.`, `Your ${yourPiece} was practically asking for it.`],
            arrogant: [`Your ${yourPiece} had no better destination.`, `I took your ${yourPiece}, as expected.`],
            playful: [`Got your ${yourPiece}!`, `Your ${yourPiece} wandered into my net.`],
            poetic: [`Your ${yourPiece} sinks into the silence between squares.`, `I gathered your ${yourPiece} from the path.`],
            commentator: [`Capture complete: your ${yourPiece} leaves the board.`, `The capture of your ${yourPiece} shifts the focus.`],
          } as Record<OpponentPersonality, string[]>)[personality]
        : kind === 'mate'
          ? ['Checkmate. That is the game.', 'The king has no escape.']
          : kind === 'check'
            ? ['Check. Find your answer.', 'Your king is under pressure.']
            : kind === 'userCheck'
              ? ['Check? Bold choice. I will respond.', 'You gave check. Now watch the reply.']
              : kind === 'drop'
                ? ['That move leaves a serious weakness.', 'You gave me a tactical opening.']
                : kind === 'good'
                  ? ['A strong move. The position just became sharper.', 'That was accurate. I need to adapt.']
                  : kind === 'opening'
                    ? ['The game begins. Show me your plan.', 'A new game, and already a decision.']
                    : ['The position is still unfolding.', 'Let us see what this plan becomes.'];
  return englishCoachFlavor(coachStyleOf(coachIndex), lines[Math.floor(Math.abs(seed) * 1_000_000) % lines.length] ?? lines[0] ?? '', seed + 0.17);
}

/** Pick a local reply, avoiding recent lines and recycling the oldest when a pool is exhausted. */
export function opponentTalk(
  personality: OpponentPersonality,
  event: OpponentTalkEvent,
  previous: string | readonly string[] = '',
  seed = Math.random(),
  coachName = '教练',
  coachIndex = 0,
): string {
  const style = LINES[personality] ?? EXTRA_LINES[personality] ?? LINES.sharp!;
  const kind = kindOf(event);
  const extra = SITUATION_LINES[personality];
  const situation = !event.opponentSan.includes('#') && /=[QRBN]/.test(event.opponentSan) ? 'promotion'
    : kind === 'neutral' && event.opponentSan.startsWith('O-O') ? 'castle' : null;
  const lines = [
    ...(situation ? extra[situation] : [...style[kind], ...(kind === 'neutral' ? extra.neutral : [])]),
    ...contextualLines(personality, event, kind, situation),
  ];
  const recent = typeof previous === 'string' ? [previous] : previous;
  const start = Math.floor(Math.abs(seed) * 1_000_000) % lines.length;
  const render = (line: string) => coachFlavor(coachStyleOf(coachIndex), line.replaceAll('机器人', coachName), seed + 0.17);
  for (let offset = 0; offset < lines.length; offset++) {
    const line = lines[(start + offset) % lines.length];
    const reply = render(line);
    if (!recent.includes(reply)) return reply;
  }
  // If every reply has been used, recycle the one heard longest ago.
  const recycled = [...lines].sort((a, b) => recent.lastIndexOf(render(a)) - recent.lastIndexOf(render(b)))[0] ?? '';
  return render(recycled);
}
