'use strict';
// Offline evidence processor. It never sends requests or infers supplier fees from token counts.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { validateCorpus, checkOutput } = require('./check.cjs');
const corpus = require('./cases.json');
const BUDGET_MICRO = 5000000;
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function fail(code) { throw Error(code); }
function object(value, allowed, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail(code);
}
function ref(value, code) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) fail(code); return value; }
function money(value, positive = false) { if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > BUDGET_MICRO) fail('INVALID_AMOUNT'); return value; }
function template() {
  return {
    version: 1, corpus_sha256: validateCorpus().sha256, run_ref: 'pending', model: 'gpt-5.5', currency: 'USD',
    transport: 'not_run',
    records: corpus.cases.map(c => ({ case_id: c.id, status: 'not_run', response_json: null, usage: null, reserved_micro: 0, billed_micro: null, provider_receipt_ref: null, reviews: [] })),
  };
}
function summarize(input) {
  object(input, ['version','corpus_sha256','run_ref','model','currency','transport','records'], 'INVALID_RESULT_PACK');
  if (input.version !== 1 || input.corpus_sha256 !== validateCorpus().sha256 || input.model !== 'gpt-5.5' || input.currency !== 'USD') fail('RESULT_CONTEXT_MISMATCH');
  ref(input.run_ref, 'INVALID_RUN_REF');
  if (!['not_run','controlled','real-system-http'].includes(input.transport) || !Array.isArray(input.records) || input.records.length > 60) fail('INVALID_RESULT_PACK');
  const seen = new Set(), groups = Object.fromEntries(['assist','prepare','questions','learning-report'].map(k => [k,{ total:corpus.cases.filter(c=>c.kind===k).length, not_run:0, unknown:0, failed:0, structure_pass:0, structure_fail:0, human_pending:0, human_approved:0, human_rejected:0, human_disagreement:0 }]));
  let reserved = 0, billed = 0, unreconciled = 0;
  const rows = [];
  for (const r of input.records) {
    object(r, ['case_id','status','response_json','usage','reserved_micro','billed_micro','provider_receipt_ref','reviews'], 'INVALID_RECORD');
    const c = corpus.cases.find(c=>c.id===r.case_id);
    if (!c || seen.has(r.case_id)) fail('INVALID_CASE_REF'); seen.add(r.case_id);
    if (!['not_run','succeeded','unknown','failed'].includes(r.status)) fail('INVALID_STATUS');
    const g = groups[c.kind];
    reserved += money(r.reserved_micro, r.status !== 'not_run');
    if (reserved > BUDGET_MICRO) fail('BUDGET_EXCEEDED');
    if (r.status === 'not_run' && (r.reserved_micro !== 0 || r.billed_micro !== null || r.provider_receipt_ref !== null)) fail('UNRUN_COST');
    if (r.billed_micro !== null) {
      billed += money(r.billed_micro);
      if (r.billed_micro > r.reserved_micro) fail('RESERVATION_EXCEEDED');
      ref(r.provider_receipt_ref,'BILLING_RECEIPT_REQUIRED');
    } else { if (r.provider_receipt_ref !== null) fail('INCOMPLETE_BILLING'); if (r.status !== 'not_run') unreconciled += r.reserved_micro; }
    if (r.usage !== null) {
      object(r.usage,['prompt_tokens','completion_tokens','reasoning_tokens'],'INVALID_USAGE');
      if (!['prompt_tokens','completion_tokens','reasoning_tokens'].every(k=>Number.isSafeInteger(r.usage[k]) && r.usage[k]>=0 && r.usage[k]<=10000000) || r.usage.reasoning_tokens>r.usage.completion_tokens || r.status==='not_run') fail('INVALID_USAGE');
    }
    if (!Array.isArray(r.reviews) || r.reviews.length > 2) fail('INVALID_REVIEWS');
    if (r.status !== 'succeeded') {
      if (r.response_json !== null || r.reviews.length) fail('UNSUCCESSFUL_OUTPUT');
      g[r.status]++; rows.push({case_id:c.id,status:r.status,structure:'not_checked',human:'not_reviewed'}); continue;
    }
    const check = checkOutput(c,r.response_json);
    const responseHash = hash(typeof r.response_json === 'string' ? r.response_json : '');
    const reviewerIds = new Set();
    for (const review of r.reviews) {
      object(review,['reviewer_ref','response_sha256','decision','source_fidelity','teaching_usefulness','boundary_awareness','notes'],'INVALID_REVIEW');
      ref(review.reviewer_ref,'INVALID_REVIEWER_REF');
      if (reviewerIds.has(review.reviewer_ref)) fail('INDEPENDENT_REVIEWERS_REQUIRED'); reviewerIds.add(review.reviewer_ref);
      if (review.response_sha256 !== responseHash) fail('STALE_REVIEW');
      if (!['approve','reject'].includes(review.decision) || !['source_fidelity','teaching_usefulness','boundary_awareness'].every(k=>Number.isInteger(review[k]) && review[k]>=1 && review[k]<=5) || typeof review.notes !== 'string' || !review.notes.trim() || review.notes.length>2000) fail('INCOMPLETE_REVIEW');
    }
    g[check.structure === 'pass' ? 'structure_pass' : 'structure_fail']++;
    let human = 'pending';
    if (r.reviews.length === 2) {
      human = r.reviews[0].decision === r.reviews[1].decision ? (r.reviews[0].decision === 'approve' ? 'approved' : 'rejected') : 'disagreement';
    }
    // A structurally invalid response cannot be approved by the offline aggregate.
    if (check.structure !== 'pass' && human === 'approved') fail('INVALID_OUTPUT_APPROVAL');
    g['human_'+human]++;
    rows.push({case_id:c.id,status:r.status,structure:check.structure,code:check.code || null,response_sha256:responseHash,human});
  }
  if (input.transport === 'not_run' && input.records.some(r=>r.status!=='not_run')) fail('TRANSPORT_STATUS_MISMATCH');
  for (const c of corpus.cases) if (!seen.has(c.id)) { groups[c.kind].not_run++; rows.push({case_id:c.id,status:'not_run',structure:'not_checked',human:'not_reviewed'}); }
  const allReviewed = Object.values(groups).every(g=>g.human_approved===g.total && g.structure_pass===g.total);
  return { version:1, run_ref:input.run_ref, corpus_sha256:input.corpus_sha256, transport:input.transport, budget:{currency:'USD',limit_micro:BUDGET_MICRO,reserved_micro:reserved,billed_micro:billed,unreconciled_micro:unreconciled,conservative_exposure_micro:billed+unreconciled}, groups, rows, review_status:allReviewed?'all_declared_reviews_approved':'incomplete_or_failed', overall:'pending_external_verification', required_external_checks:['确认真实系统HTTP来源、权限与水位证据','核对网关原始账单及费用上界依据','核实两名评审身份与独立性','系统安全专项与生产准入另行验收'] };
}
if (require.main === module) {
  try {
    const [command,filename,...extra] = process.argv.slice(2);
    if (extra.length || (command!=='template' && command!=='summarize') || (command==='template' && filename) || (command==='summarize' && !filename)) fail('USAGE_RESULTS_TEMPLATE_OR_SUMMARIZE_FILE');
    let result;
    if (command==='template') result=template();
    else { if (fs.statSync(filename).size>10000000) fail('RESULT_PACK_TOO_LARGE'); result=summarize(JSON.parse(fs.readFileSync(filename,'utf8'))); }
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } catch (e) {
    // Never echo imported files, OS paths, free text or JSON parser diagnostics.
    const safe=new Set(['INVALID_RESULT_PACK','RESULT_CONTEXT_MISMATCH','INVALID_RUN_REF','INVALID_RECORD','INVALID_CASE_REF','INVALID_STATUS','INVALID_AMOUNT','BUDGET_EXCEEDED','UNRUN_COST','RESERVATION_EXCEEDED','BILLING_RECEIPT_REQUIRED','INCOMPLETE_BILLING','INVALID_USAGE','INVALID_REVIEWS','UNSUCCESSFUL_OUTPUT','INVALID_REVIEW','INVALID_REVIEWER_REF','INDEPENDENT_REVIEWERS_REQUIRED','STALE_REVIEW','INCOMPLETE_REVIEW','INVALID_OUTPUT_APPROVAL','TRANSPORT_STATUS_MISMATCH','USAGE_RESULTS_TEMPLATE_OR_SUMMARIZE_FILE','RESULT_PACK_TOO_LARGE']);
    process.stderr.write((safe.has(e.message)?e.message:'RESULT_INPUT_INVALID')+'\n'); process.exitCode=1;
  }
}
module.exports={template,summarize,hash};
