import { describe, expect, it } from 'vitest';
import { baseUrlFor, DEEPSEEK_BASE, parseExplanation } from '../src/ai/llm';

describe('AI coach transport helpers', () => {
  it('uses the DeepSeek base URL for the built-in provider', () => {
    expect(baseUrlFor({ provider: 'deepseek', baseUrl: 'https://example.invalid' })).toBe(DEEPSEEK_BASE);
  });

  it('normalizes fenced JSON and provider end markers', () => {
    const e = parseExplanation('```json\n{"title":"Test","correct_move":"e2e4","confidence":"high"}<|endoftext|>\n```');
    expect(e.title).toBe('Test');
    expect(e.correct_move).toBe('e2e4');
    expect(e.confidence).toBe('high');
  });
});
