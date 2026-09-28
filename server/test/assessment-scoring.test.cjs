const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Decimal128 } = require('mongodb');
const { normalizeAnswer, scoreAnswer, scoreCents, scoreText } = require('../dist/assessment/scoring');
const snapshot = (type, answer) => ({ question_type: type, options: [{ id: 'A', text: '甲' }, { id: 'B', text: '乙' }], answer, scoring_rule: { version: 1, strategy: { single: 'single_exact', multiple: 'multiple_exact_set', numeric: 'numeric_exact_decimal' }[type], max_score: '1.25' } });
const maximum = Decimal128.fromString('1.25');

test('三题型精确评分且多选不依赖顺序、不计部分分', () => {
  assert.equal(scoreAnswer(snapshot('single', 'A'), { selected_option_ids: ['A'] }, maximum).score.toString(), '1.25');
  assert.equal(scoreAnswer(snapshot('multiple', 'A,B'), { selected_option_ids: ['B', 'A'] }, maximum).verdict, 'correct');
  assert.equal(scoreAnswer(snapshot('multiple', 'A,B'), { selected_option_ids: ['A'] }, maximum).score.toString(), '0.00');
  assert.equal(scoreAnswer(snapshot('single', 'A'), { selected_option_ids: [] }, maximum).verdict, 'unanswered');
  for (const answer of [{ selected_option_ids: ['A', 'A'] }, { selected_option_ids: ['C'] }, { selected_option_ids: ['A'], extra: true }]) assert.throws(() => normalizeAnswer(snapshot('multiple', 'A,B'), answer));
});

test('数值含受限指数精确等价，不经过浮点且规范化再次输入稳定', () => {
  for (const value of ['1', '1.00', '1e0', '+0.10e1']) assert.deepEqual(normalizeAnswer(snapshot('numeric', '1'), { value }), { value: '1' });
  assert.equal(scoreAnswer(snapshot('numeric', '0.1'), { value: '0.10000000000000001' }, maximum).verdict, 'incorrect');
  for (const value of ['-0e100', '1e100', '100e100', '.001e-100', '9'.repeat(100), `.${'0'.repeat(91)}1e-100`]) {
    const first = normalizeAnswer(snapshot('numeric', value), { value });
    assert.deepEqual(normalizeAnswer(snapshot('numeric', value), first), first);
    assert.equal(scoreAnswer(snapshot('numeric', value), first, maximum).verdict, 'correct');
  }
  for (const value of ['NaN', 'Infinity', '1/2', '1kg', '1e101', '1e-101', '1'.repeat(101)]) assert.throws(() => normalizeAnswer(snapshot('numeric', '1'), { value }));
  assert.equal(normalizeAnswer(snapshot('numeric', '1'), { value: '  ' }), null);
});

test('百分之一分使用BigInt，冻结满分优先且未知规则不会假零分', () => {
  assert.equal(scoreCents('0.10') + scoreCents('2e-1'), 30n);
  assert.equal(scoreText(30n), '0.30');
  assert.equal(scoreCents(Decimal128.fromString('100.00')), 10000n);
  assert.throws(() => scoreCents('0.001'));
  assert.equal(scoreAnswer(snapshot('numeric', '1'), { value: '1' }, Decimal128.fromString('8.75')).score.toString(), '8.75');
  assert.throws(() => scoreAnswer({ ...snapshot('numeric', '1'), scoring_rule: { version: 2, strategy: 'numeric_exact_decimal' } }, null, maximum));
});
