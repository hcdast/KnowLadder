import { Decimal128 } from 'mongodb';
import { fail } from '../errors';
import type { QuestionSnapshot, StudentAnswer } from './contracts';

export const SCORING_CODE_VERSION = 'exact-v1';

function decimal(value: string): { coefficient: bigint; exponent: number } {
  const text = value.trim();
  if (text.length > 100 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))
    fail(422, 'INVALID_ANSWER', '请输入有效的十进制数值');
  const [mantissa, power = '0'] = text.toLowerCase().split('e');
  const exponent = BigInt(power);
  if (exponent < -100n || exponent > 100n) fail(422, 'INVALID_ANSWER', '数值指数超出范围');
  const negative = mantissa.startsWith('-');
  const unsigned = mantissa.replace(/^[+-]/, '');
  const [whole, fraction = ''] = unsigned.split('.');
  let digits = (whole + fraction).replace(/^0+/, '');
  if (!digits) return { coefficient: 0n, exponent: 0 };
  const stripped = digits.replace(/0+$/, '');
  const scale = Number(exponent) - fraction.length + digits.length - stripped.length;
  digits = stripped;
  return { coefficient: BigInt((negative ? '-' : '') + digits), exponent: scale };
}

function canonicalDecimal(parsed: { coefficient: bigint; exponent: number }): string {
  if (parsed.coefficient === 0n) return '0';
  const sign = parsed.coefficient < 0n ? '-' : '';
  const digits = (parsed.coefficient < 0n ? -parsed.coefficient : parsed.coefficient).toString();
  const candidates: string[] = [];
  // Prefer compact fixed/scaled spelling; normalization stays within the input bounds.
  for (const exponent of new Set([0, Math.max(-100, Math.min(100, parsed.exponent))])) {
    const shift = parsed.exponent - exponent;
    const point = digits.length + shift;
    const mantissa = shift >= 0 ? digits + '0'.repeat(shift) : point > 0 ? digits.slice(0, point) + '.' + digits.slice(point) : '.' + '0'.repeat(-point) + digits;
    const value = sign + mantissa + (exponent ? `e${exponent}` : '');
    if (value.length <= 100) candidates.push(value);
  }
  candidates.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  if (!candidates.length) fail(422, 'INVALID_ANSWER', '数值超出规范化范围');
  return candidates[0];
}

export function scoreCents(value: string | Decimal128): bigint {
  const parsed = decimal(typeof value === 'string' ? value : value.toString());
  const scale = parsed.exponent + 2;
  if (scale < 0) fail(422, 'INVALID_SCORE', '分值最多保留两位小数');
  return parsed.coefficient * 10n ** BigInt(scale);
}

export function scoreText(cents: bigint): string {
  const magnitude = cents < 0n ? -cents : cents;
  return `${cents < 0n ? '-' : ''}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, '0')}`;
}

export function normalizeAnswer(snapshot: QuestionSnapshot, input: unknown): StudentAnswer {
  if (input === null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(422, 'INVALID_ANSWER', '答案结构无效');
  const object = input as Record<string, unknown>;
  if (snapshot.question_type === 'numeric') {
    if (Object.keys(object).length !== 1 || typeof object.value !== 'string') fail(422, 'INVALID_ANSWER', '数值答案结构无效');
    const value = object.value.trim();
    if (!value) return null;
    const parsed = decimal(value);
    return { value: canonicalDecimal(parsed) };
  }
  if (snapshot.question_type !== 'single' && snapshot.question_type !== 'multiple') fail(422, 'UNSUPPORTED_SCORING_RULE', '题型不受支持');
  const ids = object.selected_option_ids;
  if (Object.keys(object).length !== 1 || !Array.isArray(ids) || ids.length > snapshot.options.length || ids.some((id) => typeof id !== 'string' || !snapshot.options.some((option) => option.id === id)) || new Set(ids).size !== ids.length || (snapshot.question_type === 'single' && ids.length > 1))
    fail(422, 'INVALID_ANSWER', '选项答案无效');
  return ids.length ? { selected_option_ids: [...ids].sort() as string[] } : null;
}

export function scoreAnswer(snapshot: QuestionSnapshot, answer: StudentAnswer, maxScore: Decimal128): { score: Decimal128; max_score: Decimal128; verdict: 'correct' | 'incorrect' | 'unanswered' } {
  const strategies = { single: 'single_exact', multiple: 'multiple_exact_set', numeric: 'numeric_exact_decimal' };
  if (snapshot.scoring_rule?.version !== 1 || snapshot.scoring_rule.strategy !== strategies[snapshot.question_type]) fail(422, 'UNSUPPORTED_SCORING_RULE', '冻结评分规则不受支持');
  const maximum = scoreCents(maxScore);
  if (maximum <= 0n || maximum > 10000n) fail(422, 'INVALID_SCORE', '冻结满分无效');
  const standard = normalizeAnswer(snapshot, snapshot.question_type === 'numeric' ? { value: snapshot.answer } : { selected_option_ids: snapshot.answer.split(',').map((id) => id.trim()) });
  if (!standard) fail(422, 'UNSUPPORTED_SCORING_RULE', '标准答案无效');
  const normalized = normalizeAnswer(snapshot, answer);
  const correct = normalized !== null && JSON.stringify(normalized) === JSON.stringify(standard);
  return { score: Decimal128.fromString(scoreText(correct ? maximum : 0n)), max_score: maxScore, verdict: normalized === null ? 'unanswered' : correct ? 'correct' : 'incorrect' };
}
