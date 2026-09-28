const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateProjection, percentage } = require('../dist/learning/projection');

const DAY_MS = 86400000;
const asOf = new Date('2026-09-25T12:00:00.000Z');
const ago = (days, offset = 0) => new Date(asOf.getTime() - days * DAY_MS + offset);
const evidence = (id, overrides = {}) => ({
  _id: `evidence-${id}`, org_id: 'org-1', member_id: 'member-1', subject_id: 'subject-1',
  generation: 'generation-1', created_at: ago(1), updated_at: ago(1),
  session_item_id: `item-${id}`, question_id: `question-${id}`,
  submission_id: `submission-${id}`, grading_run_id: `run-${id}`, grading_revision: 1,
  submitted_at: ago(1), qualification: 'first', verdict: 'correct',
  knowledge_weights: [{ knowledge_point_id: 'kp-a', weight_bps: 10000 }],
  ...overrides,
});
const masteryValues = (row) => ({
  count: row.independent_question_count, numerator: row.numerator, denominator: row.denominator,
  mastery: row.mastery, classification: row.classification,
});
const reportValues = (row) => ({
  period: row.period, submissions: row.submission_count, attempts: row.attempt_count,
  correct: row.correct_count, incorrect: row.incorrect_count, unanswered: row.unanswered_count,
  independent: row.independent_question_count, numerator: row.numerator, denominator: row.denominator,
});

test('四道独立首答证据不足，五道不同题首答才产生掌握度', () => {
  const rows = Array.from({ length: 5 }, (_, i) => evidence(i));
  assert.deepEqual(masteryValues(calculateProjection(rows.slice(0, 4), asOf).mastery[0]), {
    count: 4, numerator: '40000', denominator: '40000', mastery: null, classification: 'insufficient_evidence',
  });
  assert.deepEqual(masteryValues(calculateProjection(rows, asOf).mastery[0]), {
    count: 5, numerator: '50000', denominator: '50000', mastery: '100.00', classification: 'mastered',
  });
});

test('60和80为精确分类边界，展示四舍五入不能提升分类', () => {
  const cases = [
    { correct: 3, firstWeight: 10000, numerator: '30000', denominator: '50000', mastery: '60.00', classification: 'developing' },
    { correct: 4, firstWeight: 10000, numerator: '40000', denominator: '50000', mastery: '80.00', classification: 'mastered' },
    { correct: 3, firstWeight: 9999, numerator: '29999', denominator: '49999', mastery: '60.00', classification: 'weak' },
    { correct: 4, firstWeight: 9999, numerator: '39999', denominator: '49999', mastery: '80.00', classification: 'developing' },
  ];
  for (const example of cases) {
    const rows = Array.from({ length: 5 }, (_, i) => evidence(i, {
      verdict: i < example.correct ? 'correct' : 'incorrect',
      knowledge_weights: [{ knowledge_point_id: 'kp-a', weight_bps: i === 0 ? example.firstWeight : 10000 }],
    }));
    assert.deepEqual(masteryValues(calculateProjection(rows, asOf).mastery[0]), {
      count: 5, numerator: example.numerator, denominator: example.denominator,
      mastery: example.mastery, classification: example.classification,
    });
  }
});

test('百分比使用整数精度和两位小数，零分母不产生伪零掌握度', () => {
  assert.equal(percentage(0n, 0n), null);
  assert.equal(percentage(0n, 7n), '0.00');
  assert.equal(percentage(1n, 3n), '33.33');
  assert.equal(percentage(2n, 3n), '66.67');
  assert.equal(percentage(1n, 20000n), '0.01');
  assert.equal(percentage(99999n, 100000n), '100.00');
  const denominator = 10n ** 30n;
  assert.equal(percentage(12345n * (denominator / 100000n) - 1n, denominator), '12.34');
  assert.equal(percentage(12345n * (denominator / 100000n), denominator), '12.35');
});

test('重复、未知和已暴露题计入活动但不能凑足五题或改变独立证据分母', () => {
  const rows = Array.from({ length: 4 }, (_, i) => evidence(i));
  rows.push(
    evidence('repeat', { question_id: 'question-0', qualification: 'repeated', verdict: 'incorrect', submitted_at: asOf }),
    evidence('unknown', { qualification: 'unknown', verdict: 'incorrect', submitted_at: asOf }),
    evidence('exposed', { qualification: 'exposed', verdict: 'unanswered', submitted_at: asOf }),
  );
  const result = calculateProjection(rows, asOf);
  assert.deepEqual(masteryValues(result.mastery[0]), {
    count: 4, numerator: '40000', denominator: '40000', mastery: null, classification: 'insufficient_evidence',
  });
  assert.deepEqual(result.mastery[0].last_evidence_at, ago(1));
  assert.deepEqual(reportValues(result.reports.find((row) => row.period === '7d')), {
    period: '7d', submissions: 7, attempts: 7, correct: 4, incorrect: 2, unanswered: 1,
    independent: 4, numerator: '40000', denominator: '40000',
  });
  assert.equal(calculateProjection(rows.slice(4), asOf).mastery.length, 0);
});

test('未作答首答计入独立题数及分母，计为未作答而不是错误活动', () => {
  const rows = Array.from({ length: 5 }, (_, i) => evidence(i, { verdict: i === 4 ? 'unanswered' : 'correct' }));
  const result = calculateProjection(rows, asOf);
  assert.deepEqual(masteryValues(result.mastery[0]), {
    count: 5, numerator: '40000', denominator: '50000', mastery: '80.00', classification: 'mastered',
  });
  assert.deepEqual(reportValues(result.reports.find((row) => row.period === '7d')), {
    period: '7d', submissions: 5, attempts: 5, correct: 4, incorrect: 0, unanswered: 1,
    independent: 5, numerator: '40000', denominator: '50000',
  });
  assert.equal(result.mistakes.length, 1);
  assert.equal(result.mistakes[0].question_id, 'question-4');
  assert.equal(result.mistakes[0].status, 'active');
});

test('同一题出现两条当前首答证据必须拒绝，不能重复累计', () => {
  assert.throws(() => calculateProjection([
    evidence('first'), evidence('duplicate', { question_id: 'question-first' }),
  ], asOf), /DUPLICATE_FIRST_EVIDENCE/);
});

test('90天窗口严格排除下界及更早证据，包含当前时刻并排除未来', () => {
  const result = calculateProjection([
    evidence('older', { submitted_at: ago(90, -1), verdict: 'incorrect' }),
    evidence('boundary', { submitted_at: ago(90), verdict: 'incorrect' }),
    evidence('inside', { submitted_at: ago(90, 1), verdict: 'incorrect' }),
    evidence('now', { submitted_at: asOf }),
    evidence('future', { submitted_at: new Date(asOf.getTime() + 1), verdict: 'incorrect' }),
  ], asOf);
  assert.deepEqual(masteryValues(result.mastery[0]), {
    count: 2, numerator: '10000', denominator: '20000', mastery: null, classification: 'insufficient_evidence',
  });
  assert.deepEqual(result.mastery[0].last_evidence_at, asOf);
  assert.deepEqual(result.mistakes.map((row) => row.question_id), ['question-inside']);
  for (const report of result.reports) {
    assert.deepEqual(reportValues(report), {
      period: report.period, submissions: 1, attempts: 1, correct: 1, incorrect: 0, unanswered: 0,
      independent: 1, numerator: '10000', denominator: '10000',
    });
  }
});

test('错题由最新可见作答解决或重新打开，重新输入隐藏后的集合会恢复旧状态', () => {
  const wrong = evidence('wrong', { verdict: 'incorrect', submitted_at: ago(3) });
  const correct = evidence('correct', { question_id: wrong.question_id, qualification: 'repeated', submitted_at: ago(2) });
  const reopened = evidence('reopened', { question_id: wrong.question_id, qualification: 'repeated', verdict: 'incorrect', submitted_at: ago(1) });
  for (const [rows, latest, status] of [
    [[wrong], wrong, 'active'],
    [[correct, wrong], correct, 'resolved'],
    [[reopened, wrong, correct], reopened, 'active'],
    [[wrong, correct], correct, 'resolved'],
    [[wrong], wrong, 'active'],
  ]) {
    const { mistakes } = calculateProjection(rows, asOf);
    assert.equal(mistakes.length, 1);
    assert.deepEqual({
      question: mistakes[0].question_id, item: mistakes[0].latest_visible_item,
      submission: mistakes[0].submission_id, run: mistakes[0].grading_run_id,
      status: mistakes[0].status, at: mistakes[0].last_attempt_at,
    }, {
      question: wrong.question_id, item: latest.session_item_id,
      submission: latest.submission_id, run: latest.grading_run_id, status, at: latest.submitted_at,
    });
  }
  assert.deepEqual(calculateProjection([correct], asOf).mistakes, []);
});

test('同一提交重评以当前有效结果替换旧证据，不能累计旧错误或旧正确结果', () => {
  const original = evidence('regrade', { verdict: 'incorrect' });
  const corrected = { ...original, verdict: 'correct', grading_revision: 2, grading_run_id: 'run-regrade-2' };
  const others = Array.from({ length: 4 }, (_, i) => evidence(i));
  const before = calculateProjection([...others, original], asOf);
  const after = calculateProjection([...others, corrected], asOf);
  const reverted = calculateProjection([...others, { ...corrected, verdict: 'incorrect', grading_revision: 3, grading_run_id: 'run-regrade-3' }], asOf);
  assert.equal(before.mistakes[0].status, 'active');
  assert.equal(before.mastery[0].numerator, '40000');
  assert.deepEqual(after.mistakes, []);
  assert.deepEqual(masteryValues(after.mastery[0]), {
    count: 5, numerator: '50000', denominator: '50000', mastery: '100.00', classification: 'mastered',
  });
  assert.deepEqual(reportValues(after.reports.find((row) => row.period === '7d')), {
    period: '7d', submissions: 5, attempts: 5, correct: 5, incorrect: 0, unanswered: 0,
    independent: 5, numerator: '50000', denominator: '50000',
  });
  assert.equal(reverted.mistakes[0].status, 'active');
  assert.equal(reverted.mistakes[0].grading_run_id, 'run-regrade-3');
  assert.equal(reverted.mastery[0].numerator, '40000');
  assert.equal(reverted.mastery[0].denominator, '50000');
});

test('7天和30天报告严格使用各自下界，提交数、活动题次和独立题数分别统计', () => {
  const rows = [
    evidence('a', { submission_id: 'shared' }),
    evidence('b', { submission_id: 'shared', verdict: 'unanswered' }),
    evidence('repeat', { question_id: 'question-a', qualification: 'repeated', verdict: 'incorrect' }),
    evidence('unknown', { qualification: 'unknown' }),
    evidence('seven-inside', { submitted_at: ago(7, 1), verdict: 'incorrect' }),
    evidence('seven-boundary', { submitted_at: ago(7), verdict: 'incorrect' }),
    evidence('thirty-inside', { submitted_at: ago(30, 1) }),
    evidence('thirty-boundary', { submitted_at: ago(30), verdict: 'unanswered' }),
  ];
  const result = calculateProjection(rows, asOf);
  assert.deepEqual(result.reports.map(reportValues), [
    { period: '7d', submissions: 4, attempts: 5, correct: 2, incorrect: 2, unanswered: 1, independent: 3, numerator: '10000', denominator: '30000' },
    { period: '30d', submissions: 6, attempts: 7, correct: 3, incorrect: 3, unanswered: 1, independent: 5, numerator: '20000', denominator: '50000' },
  ]);
  assert.equal(result.mastery[0].independent_question_count, 6);
  assert.equal(result.mastery[0].denominator, '60000');
});

test('跨知识点报告相加整数权重分子分母，不平均掌握度且不重复计算题数', () => {
  const rows = Array.from({ length: 5 }, (_, i) => evidence(i, {
    verdict: i < 2 ? 'correct' : 'incorrect',
    knowledge_weights: [
      { knowledge_point_id: 'kp-a', weight_bps: i < 2 ? 1000 : 9000 },
      { knowledge_point_id: 'kp-b', weight_bps: i < 2 ? 9000 : 1000 },
    ],
  }));
  const result = calculateProjection(rows, asOf);
  assert.deepEqual(result.mastery.map((row) => ({ point: row.knowledge_point_id, ...masteryValues(row) })), [
    { point: 'kp-a', count: 5, numerator: '2000', denominator: '29000', mastery: '6.90', classification: 'weak' },
    { point: 'kp-b', count: 5, numerator: '18000', denominator: '21000', mastery: '85.71', classification: 'mastered' },
  ]);
  for (const report of result.reports) {
    assert.deepEqual(reportValues(report), {
      period: report.period, submissions: 5, attempts: 5, correct: 2, incorrect: 3, unanswered: 0,
      independent: 5, numerator: '20000', denominator: '50000',
    });
    assert.equal(percentage(BigInt(report.numerator), BigInt(report.denominator)), '40.00');
  }
});
