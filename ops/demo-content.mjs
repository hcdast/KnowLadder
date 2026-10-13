// Produces reviewable API payloads only. No database or network writes.
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function buildDemoContent({ stageId, subjectId, knowledgePointId }) {
  for (const value of [stageId, subjectId, knowledgePointId]) {
    if (!/^[a-f0-9]{24}$/.test(value || '')) throw new Error('Provide existing catalogue ObjectIds');
  }
  const license = { source: 'KnowLadder 原创示例内容，待组织内容负责人审核授权', granted: false, expires_at: null };
  const chapter = (key, position, title, body) => ({ client_key: key, parent_id: null, position, title, body, knowledge_point_ids: [knowledgePointId], resource_ids: [] });
  const questions = [
    ['等式两边同时加数', '若 x − 3 = 5，则 x 等于多少？', '8', '等式两边同时加3，得到x=8。'],
    ['等式两边同时除数', '若 3x = 12，则 x 等于多少？', '4', '等式两边同时除以非零数3，得到x=4。'],
    ['两步解方程', '解方程 2x + 5 = 17，x 等于多少？', '6', '先两边减5得2x=12，再两边除以2得x=6。'],
    ['含负数的方程', '解方程 x + 7 = 2，x 等于多少？', '-5', '两边同时减7，x=2−7=−5。'],
    ['实际应用', '三本相同价格的练习本共15元，每本多少元？', '5', '设每本x元，3x=15，因此x=5。'],
  ].map(([title, prompt, answer, explanation]) => ({ title: `[示例] ${title}`, subject_id: subjectId, question_type: 'numeric', prompt, answer, explanation, options: [], difficulty: '基础', knowledge_point_ids: [knowledgePointId], resource_ids: [], license: { ...license }, scoring_rule: { version: 1, strategy: 'numeric_exact_decimal', max_score: '10' }, knowledge_weights: [{ knowledge_point_id: knowledgePointId, weight_bps: 10000 }], difficulty_basis: '示例基础题，单一知识点，题目难度未经实测标定' }));
  const lesson = (key, title, body) => ({ key, title, body, kind: 'text', required: true, file_id: null, owner_version_id: null });
  return {
    schema_version: 1,
    note: '仅草稿请求材料；确认目录、学科适配及版权授权后，经编辑、独立审核和发布，课程另需班级分配。不含凭据，不自动写入。',
    textbook: { title: '[示例] 基础数学：一元一次方程', edition_code: 'demo-equations-v1', textbook: { title: '[示例] 基础数学', stage_id: stageId, subject_id: subjectId, source: 'KnowLadder 原创教学示例' }, license, resource_ids: [] },
    chapters: [chapter('equality', 0, '等式的性质', '等式表示两边的值相等。两边同时加上或减去同一个数，等式仍成立；同时乘或除以同一个非零数，等式仍成立。例：x−3=5，两边加3得x=8。注意：不能除以0。'), chapter('solve', 1, '解一元一次方程', '解方程是寻找使等式成立的未知数。例：2x+5=17，两边减5得2x=12，再除以2得x=6。检验：2×6+5=17。每一步都应同时对等式两边操作。'), chapter('application', 2, '用方程解决问题', '三本相同价格的练习本共15元。设每本x元，列出3x=15，解得x=5。检验总价3×5=15元。答题时说明未知数的含义并写单位。')],
    questions,
    course: { code: 'demo-equations-v1', title: '[示例] 一元一次方程入门', subject_id: subjectId, version_no: 1, lessons: [lesson('understand', '理解等式', '学习目标：说明等式两边同时进行相同运算的理由。阅读等式性质后，用x−3=5举例说明。'), lesson('practice', '独立解方程', '练习：2x+5=17。先独立写出步骤，再检验所得的x值。文本课节完成仅表示学过，不代表掌握。'), lesson('apply', '应用与复盘', '三本同价练习本共15元。列出方程并求单价；回顾未知数含义、运算步骤和单位。')] },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [stageId, subjectId, knowledgePointId, output] = process.argv.slice(2);
  if (!output) throw new Error('Usage: node ops/demo-content.mjs STAGE_ID SUBJECT_ID KNOWLEDGE_POINT_ID OUTPUT.json');
  await writeFile(output, JSON.stringify(buildDemoContent({ stageId, subjectId, knowledgePointId }), null, 2), { flag: 'wx' });
  console.log('Draft payloads written. No service writes performed.');
}
