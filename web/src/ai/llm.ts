import { readJson, safeSet } from '../storage';

export interface AiConfig {
  enabled: boolean;
  provider: 'deepseek' | 'custom';
  baseUrl: string;
  model: string;
  shareGame: boolean;
  saveKey: boolean;
}

export interface AiModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
}

export interface AiExplanationContext {
  fen: string;
  move: string;
  moveSan: string;
  bestMove: string | null;
  bestMoveSan: string | null;
  judgement: string;
  before: number;
  after: number;
  pv: string[];
  motifs: string[];
  playerRating: number;
  gameContext?: string;
}

export interface AiExplanation {
  title: string;
  question: string;
  hint: string;
  correct_move: string | null;
  correct_move_san: string | null;
  why: string;
  next_check: string;
  pv: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface AiSummaryItem {
  ply: number;
  move: string;
  title: string;
  correct_move: string | null;
  why: string;
}

export interface AiSummary {
  overview: string;
  items: AiSummaryItem[];
  practice: string;
}

const KEY = 'maia-coach.ai-key';
export const DEEPSEEK_BASE = 'https://api.deepseek.com';
export const DEEPSEEK_MODEL = 'deepseek-flash';

export function loadAiKey(): string {
  const v = readJson(KEY);
  return typeof v === 'string' ? v : '';
}

export function saveAiKey(key: string): boolean {
  return safeSet(KEY, JSON.stringify(key.trim()));
}

export function clearAiKey(): boolean {
  try {
    localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

export function baseUrlFor(c: Pick<AiConfig, 'provider' | 'baseUrl'>): string {
  return (c.provider === 'deepseek' ? DEEPSEEK_BASE : c.baseUrl || DEEPSEEK_BASE).replace(/\/+$/, '');
}

async function jsonFetch(url: string, key: string, init: RequestInit = {}): Promise<any> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${key}`);
  headers.set('Content-Type', 'application/json');
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) throw new Error(body?.error?.message || body?.message || `请求失败（${res.status}）`);
  return body;
}

export async function fetchAiModels(config: AiConfig, key: string): Promise<AiModel[]> {
  if (!key.trim()) throw new Error('请先填写 API Key');
  const body = await jsonFetch(`${baseUrlFor(config)}/models`, key);
  const list = Array.isArray(body?.data) ? body.data : [];
  return list
    .filter((x: any) => typeof x?.id === 'string')
    .map((x: any) => ({
      id: x.id,
      name: typeof x.name === 'string' ? x.name : undefined,
      contextWindow: typeof x.context_window === 'number' ? x.context_window : undefined,
      maxOutputTokens: typeof x.max_output_tokens === 'number' ? x.max_output_tokens : undefined,
      inputModalities: Array.isArray(x.input_modalities) ? x.input_modalities.filter((m: unknown): m is string => typeof m === 'string') : undefined,
    }));
}

function cleanJsonText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (fenced?.[1] ?? text).replace(/<\|[^>]+\|>/g, '').trim();
}

export function parseExplanation(raw: string): AiExplanation {
  const v = JSON.parse(cleanJsonText(raw));
  const str = (x: unknown) => (typeof x === 'string' ? x : '');
  return {
    title: str(v.title) || '局面讲解',
    question: str(v.question),
    hint: str(v.hint),
    correct_move: typeof v.correct_move === 'string' ? v.correct_move : null,
    correct_move_san: typeof v.correct_move_san === 'string' ? v.correct_move_san : null,
    why: str(v.why),
    next_check: str(v.next_check),
    pv: Array.isArray(v.pv) ? v.pv.filter((x: unknown): x is string => typeof x === 'string').slice(0, 8) : [],
    confidence: v.confidence === 'high' || v.confidence === 'low' ? v.confidence : 'medium',
  };
}

function promptFor(c: AiExplanationContext, mode: 'hint' | 'full'): string {
  return [
    '你是一个耐心、具体、面向学习的国际象棋教练。',
    'Stockfish 的评估、最佳着法和变化是事实来源，不要自行否定或编造棋步。',
    '只根据提供的数据解释，不要展示思维链；用简体中文，适合普通业余棋手。',
    mode === 'hint' ? '现在只给思考问题和渐进提示，不要直接泄露最佳着法。' : '请明确告诉玩家正确走法、为什么正确，以及以后走棋时要检查什么。',
    '必须只返回 JSON，不要 Markdown，不要额外文字。字段：title, question, hint, correct_move, correct_move_san, why, next_check, pv, confidence。',
    JSON.stringify(c),
  ].join('\n');
}

export async function explainWithAi(config: AiConfig, key: string, context: AiExplanationContext, mode: 'hint' | 'full' = 'full'): Promise<AiExplanation> {
  if (!key.trim()) throw new Error('请先填写 API Key');
  if (!config.model.trim()) throw new Error('请先选择模型');
  const body = await jsonFetch(`${baseUrlFor(config)}/chat/completions`, key, {
    method: 'POST',
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'system', content: '你输出严格、简短、可验证的国际象棋教学 JSON。' }, { role: 'user', content: promptFor(context, mode) }],
      temperature: 0.2,
      max_tokens: 900,
      response_format: { type: 'json_object' },
      ...(config.provider === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
    }),
  });
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型没有返回有效讲解');
  return parseExplanation(content);
}

export async function summarizeWithAi(config: AiConfig, key: string, contexts: AiExplanationContext[]): Promise<AiSummary> {
  if (!key.trim()) throw new Error('请先填写 API Key');
  if (!config.model.trim()) throw new Error('请先选择模型');
  const prompt = [
    '你是国际象棋复盘教练。根据 Stockfish 已确认的问题着法，归纳这盘棋最值得学习的关键失败。',
    '最多保留 5 个问题，按学习价值排序；不要编造没有提供的棋步或变化。',
    '必须只返回 JSON：overview（整体总结）、items（包含 ply、move、title、correct_move、why）、practice（下一步训练建议）。',
    JSON.stringify(contexts.slice(0, 8)),
  ].join('\n');
  const body = await jsonFetch(`${baseUrlFor(config)}/chat/completions`, key, {
    method: 'POST',
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'system', content: '你输出严格、简短、可验证的国际象棋复盘 JSON。' }, { role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 1400,
      response_format: { type: 'json_object' },
      ...(config.provider === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
    }),
  });
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型没有返回有效总结');
  const v = JSON.parse(cleanJsonText(content));
  return {
    overview: typeof v.overview === 'string' ? v.overview : '',
    practice: typeof v.practice === 'string' ? v.practice : '',
    items: Array.isArray(v.items)
      ? v.items.slice(0, 5).map((x: any) => ({
          ply: typeof x?.ply === 'number' ? x.ply : 0,
          move: typeof x?.move === 'string' ? x.move : '',
          title: typeof x?.title === 'string' ? x.title : '关键问题',
          correct_move: typeof x?.correct_move === 'string' ? x.correct_move : null,
          why: typeof x?.why === 'string' ? x.why : '',
        }))
      : [],
  };
}
