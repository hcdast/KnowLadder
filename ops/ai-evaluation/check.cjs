'use strict';
// Offline evaluation preparation only. Deliberately has no network or paid execution path.
const path = require('node:path');
const crypto = require('node:crypto');
const corpus = require('./cases.json');
function validateCorpus(pack = corpus) {
  const expected = { assist: 20, prepare: 10, questions: 20, 'learning-report': 10 };
  if (pack.version !== 1 || !Array.isArray(pack.cases) || pack.cases.length !== 60) throw Error('INVALID_CORPUS');
  const ids = new Set();
  for (const c of pack.cases) {
    if (!Object.hasOwn(expected, c.kind) || ids.has(c.id) || !c.prompt || !c.sources?.length || !c.review_criteria?.length) throw Error('INVALID_CASE');
    ids.add(c.id); expected[c.kind]--;
    if (c.sources.some(s => !s.key || !s.text)) throw Error('INVALID_SOURCE');
    if (c.kind === 'learning-report') {
      const s = JSON.parse(c.sources[0].text);
      if (s.rule_version !== 'learning_v1' || s.training_completion !== 'unavailable' || Object.keys(s).sort().join() !== 'mastery_bands,rule_version,training_completion') throw Error('INVALID_LEARNING_SOURCE');
      const names = ['insufficient_evidence', 'weak', 'developing', 'mastered'];
      if (!s.mastery_bands || Object.keys(s.mastery_bands).sort().join() !== names.sort().join()) throw Error('INVALID_BANDS');
      const values = Object.values(s.mastery_bands);
      if (values.some(n => !Number.isSafeInteger(n) || n < 0 || (n > 0 && n < 5)) || values.reduce((a,b)=>a+b,0) > 200 || values.reduce((a,b)=>a+b,0) < 5) throw Error('UNSAFE_GROUP');
    }
  }
  if (Object.values(expected).some(n => n !== 0)) throw Error('INVALID_DISTRIBUTION');
  return { cases: 60, distribution: { assist: 20, prepare: 10, questions: 20, 'learning-report': 10 }, sha256: crypto.createHash('sha256').update(JSON.stringify(pack)).digest('hex') };
}
function checkOutput(c, raw) {
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 100000) throw Error('INVALID_RESPONSE');
    let d;
    try { d = JSON.parse(raw); } catch { throw Error('INVALID_JSON'); }
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw Error('INVALID_OBJECT');
    const text = (x, max) => { if (typeof x !== 'string' || !x.trim() || x.length > max) throw Error('INVALID_TEXT'); return x; };
    if (!Array.isArray(d.source_keys) || !d.source_keys.length || d.source_keys.some(k => !c.sources.some(s => s.key === k))) throw Error('INVALID_CITATIONS');
    if (c.kind === 'learning-report') {
      if (Object.keys(d).sort().join() !== 'interpretation,source_keys,suggestions') throw Error('INVALID_FIELDS');
      text(d.interpretation, 4000);
      if (!Array.isArray(d.suggestions) || !d.suggestions.length || d.suggestions.length > 10) throw Error('INVALID_SUGGESTIONS');
      d.suggestions.forEach(x => text(x, 500));
      if (/[0-9０-９%％]|[零一二三四五六七八九十百千万两]+(?:人|名|次|分|成|％|%)/.test(d.interpretation+d.suggestions.join(''))) throw Error('AI_NUMERIC_CLAIM');
    } else text(d.text, 12000);
    return { structure: 'pass', pedagogy: 'pending_two_human_reviewers' };
  } catch (e) { return { structure: 'fail', code: e.message, pedagogy: 'not_reviewed' }; }
}
function preflight(env) {
  let endpointValid = false;
  try { const u = new URL(env.KL_AI_ENDPOINT); endpointValid = u.protocol === 'https:' && u.hostname === 'sub2api.akool.icu' && u.pathname === '/v1/chat/completions' && !u.username && !u.password && !u.search && !u.hash; } catch {}
  return { model_matches: env.KL_AI_MODEL === 'gpt-5.5', endpoint_matches: endpointValid, key_configured: !!env.KL_AI_API_KEY?.trim(), amount_policy_enabled: env.KL_AI_POLICY_ENABLED === 'true', external_requests: 0, spent_usd: 0, paid_execution: 'unavailable_in_offline_tool', remaining: ['网关实际计费及可证明的5美元费用上界', '真实系统HTTP派发、usage及账单核对', '两名独立人工教学质量评审'] };
}
function reviewRows() {
  return corpus.cases.map(c => ({ case_id: c.id, kind: c.kind, response: null, structure: 'not_run', reviews: [1,2].map(slot => ({ slot, reviewer: null, source_fidelity: null, teaching_usefulness: null, boundary_awareness: null, decision: null, notes: null })) }));
}
if (require.main === module) {
  try { process.loadEnvFile(path.resolve(__dirname, '../../server/.env')); }
  catch (e) { if (e.code !== 'ENOENT') { process.stderr.write('ENV_LOAD_FAILED\n'); process.exit(1); } }
  const report = { ...validateCorpus(), config: preflight(process.env), reviews: reviewRows() };
  // No raw configuration, secrets or provider errors are emitted.
  process.stdout.write(JSON.stringify(report, null, 2)+'\n');
}
module.exports = { validateCorpus, checkOutput, preflight, reviewRows };
