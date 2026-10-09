'use strict';
const fs=require('node:fs');
const crypto=require('node:crypto');
const corpus=require('./cases.json');
const {validateCorpus,checkOutput}=require('./check.cjs');
const escapeHtml=value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function prepare(pack){
  if(pack.model!=='gpt-5.5'||pack.transport!=='real-gateway-evaluation'||pack.corpus_sha256!==validateCorpus().sha256||!Array.isArray(pack.records)||pack.records.length!==60)throw Error('INVALID_REVIEW_PACK');
  const seen=new Set();
  const rows=pack.records.map(r=>{
    const c=corpus.cases.find(c=>c.id===r.case_id);
    if(!c||seen.has(c.id)||r.kind!==c.kind||r.status!=='succeeded'||typeof r.response_json!=='string')throw Error('INVALID_REVIEW_RECORD');seen.add(c.id);
    const digest=crypto.createHash('sha256').update(r.response_json).digest('hex');
    if(r.response_sha256!==digest)throw Error('OUTPUT_HASH_MISMATCH');
    const structural=checkOutput(c,r.response_json);
    if(structural.structure!=='pass')throw Error('OUTPUT_STRUCTURE_FAILED');
    const output=JSON.parse(r.response_json);
    const hints=[];
    if(c.kind==='questions')hints.push('题目建议仍是自由文本，须人工确认题型、选项、答案和解析后通过正式题库契约。');
    if(c.scenario==='证据不足')hints.push('来源不含实时价格，重点核对是否明确说明未知、是否编造收费信息。');
    if(c.kind==='learning-report')hints.push('核对建议与分布是否相符；培训完成率未知，不应推断个人能力。');
    const findings=[];
    if(c.kind==='learning-report'){
      const facts=JSON.parse(c.sources[0].text);
      // A narrowly scoped screening hint, not a general semantic or human-quality verdict.
      if(facts.mastery_bands.insufficient_evidence===0 && /(?:^|[，；。])(?:同时也|同时|仍|也)?存在(?:一些|部分)?证据不足/.test(output.interpretation)){
        findings.push({code:'POSSIBLE_UNSUPPORTED_EVIDENCE_BAND',status:'needs_human_review',basis:'来源的insufficient_evidence为0，但解释中出现“存在证据不足”的肯定表述。'});
        hints.push('自动筛查提示：来源证据不足分类为0，解释却可能声称该分类存在，请重点复核；此提示不替代人工结论。');
      }
    }
    return {case_id:c.id,kind:c.kind,topic:c.topic,scenario:c.scenario,prompt:c.prompt,sources:c.sources,criteria:c.review_criteria,output,response_sha256:digest,structure:'pass',hints,automated_findings:findings};
  });
  return {model:pack.model,corpus_sha256:pack.corpus_sha256,rows,coverage:{assist:20,prepare:10,questions:20,'learning-report':10,numeric_question_cases:0},human_quality:'not_reviewed'};
}
function render(pack){
  const data=prepare(pack);
  const labels={assist:'课程答疑',prepare:'备课建议',questions:'题目建议','learning-report':'有效学情解读'};
  const cards=data.rows.map(r=>`<article data-kind="${r.kind}" data-case="${r.case_id}"><h2>${escapeHtml(r.case_id)} · ${labels[r.kind]} · ${escapeHtml(r.topic)}</h2><p class="meta">场景：${escapeHtml(r.scenario)} · 结构检查通过 · 人工质量待评</p><details><summary>查看来源、请求与核对要点</summary><h3>请求</h3><p>${escapeHtml(r.prompt)}</p>${r.sources.map(s=>`<h3>${escapeHtml(s.title)} · ${escapeHtml(s.key)}</h3><pre>${escapeHtml(s.text)}</pre>`).join('')}<h3>核对要点</h3><ul>${[...r.criteria,...r.hints].map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></details><h3>真实模型输出</h3><pre>${escapeHtml(r.kind==='learning-report'?r.output.interpretation+'\n\n教学建议：\n'+r.output.suggestions.join('\n'):r.output.text)}</pre><details><summary>输出绑定 SHA256</summary><code>${r.response_sha256}</code></details><div class="reviews">${[1,2].map(slot=>`<fieldset data-slot="${slot}"><legend>评审 ${slot}</legend><label>来源一致性（1—5）<select data-field="source_fidelity"><option value="">待评</option>${[1,2,3,4,5].map(n=>`<option>${n}</option>`).join('')}</select></label><label>教学实用性（1—5）<select data-field="teaching_usefulness"><option value="">待评</option>${[1,2,3,4,5].map(n=>`<option>${n}</option>`).join('')}</select></label><label>边界意识（1—5）<select data-field="boundary_awareness"><option value="">待评</option>${[1,2,3,4,5].map(n=>`<option>${n}</option>`).join('')}</select></label><label>结论<select data-field="decision"><option value="">待评</option><option value="approve">可用</option><option value="reject">需修改</option></select></label><label>核对依据与问题<textarea data-field="notes" maxlength="2000" rows="3"></textarea></label></fieldset>`).join('')}</div></article>`).join('');
  const encoded=JSON.stringify(data).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'"><title>KnowLadder 真实AI输出人工评审</title><style>body{margin:0;background:#f4f6fa;color:#203049;font:16px/1.6 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:28px}h1{font-size:28px}h2{font-size:20px}h3{font-size:16px}article,.toolbar{background:white;border:1px solid #d7dfec;border-radius:12px;padding:22px;margin:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f7f9fc;padding:14px;font:15px/1.7 system-ui,sans-serif}.meta{color:#53647e}.reviews{display:grid;grid-template-columns:1fr 1fr;gap:16px}fieldset{border:1px solid #cbd5e4;border-radius:8px}label{display:block;margin:10px 0}input,select,textarea,button{font:inherit;padding:6px;box-sizing:border-box}textarea{display:block;width:100%}button{cursor:pointer;background:#174fba;color:white;border:0;border-radius:6px;padding:9px 16px}code{overflow-wrap:anywhere}summary{cursor:pointer}#message{color:#9a3412}@media(max-width:700px){main{padding:12px}.reviews{grid-template-columns:1fr}}@media print{.toolbar{display:none}details{display:block}article{break-inside:avoid}body{background:white}}</style></head><body><main><h1>真实AI输出 · 双人教学评审</h1><p>60条原创合成案例，模型请求 gpt-5.5。结构通过不等于教学质量通过。数值题覆盖为0；题库结构、确定性答案和系统安全须另行验收。实际费用未知。</p><p>此页面离线使用，不向网络提交信息、不自动保存。导出JSON后保管评审记录；关闭页面会丢失未导出的输入。两位评审须独立核对并使用不同代号，不填真实身份或凭据。</p><section class="toolbar"><label>评审1代号 <input id="reviewer1" maxlength="80" placeholder="例如 reviewer_A"></label><label>评审2代号 <input id="reviewer2" maxlength="80" placeholder="例如 reviewer_B"></label><label>筛选能力 <select id="filter"><option value="all">全部60条</option>${Object.entries(labels).map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select></label><button id="download" type="button">导出已填写评审JSON</button><p id="message" role="status"></p><details id="export-preview" hidden><summary>生成的JSON（下载未出现时可手动复制）</summary><textarea id="export-json" readonly rows="12" aria-label="生成的评审JSON"></textarea></details></section>${cards}</main><script type="application/json" id="review-data">${encoded}</script><script>
const data=JSON.parse(document.getElementById('review-data').textContent);
document.getElementById('filter').addEventListener('change',event=>{document.querySelectorAll('article').forEach(el=>{el.hidden=event.target.value!=='all'&&el.dataset.kind!==event.target.value;});});
document.getElementById('download').addEventListener('click',()=>{
 const message=document.getElementById('message');
 const ids=[1,2].map(n=>document.getElementById('reviewer'+n).value.trim());
 if(ids.some(id=>id&&!/^[A-Za-z0-9_-]{1,80}$/.test(id))||(ids[0]&&ids[0]===ids[1])){message.textContent='请输入不同的非敏感评审代号，仅允许字母、数字、下划线和短横线。';return;}
 const rows=[];let count=0;
 for(const article of document.querySelectorAll('article')){
  const source=data.rows.find(r=>r.case_id===article.dataset.case);const reviews=[];
  for(const fieldset of article.querySelectorAll('fieldset')){
   const slot=Number(fieldset.dataset.slot);const value={};fieldset.querySelectorAll('[data-field]').forEach(el=>{value[el.dataset.field]=el.value.trim();});
   if(!Object.values(value).some(Boolean))continue;
   if(!ids[slot-1]||Object.values(value).some(x=>!x)){message.textContent=source.case_id+' 的评审'+slot+'未填完整，请填写代号、各项分数、结论和依据。';return;}
   reviews.push({reviewer_ref:ids[slot-1],response_sha256:source.response_sha256,source_fidelity:Number(value.source_fidelity),teaching_usefulness:Number(value.teaching_usefulness),boundary_awareness:Number(value.boundary_awareness),decision:value.decision,notes:value.notes});count++;
  }
  rows.push({case_id:source.case_id,response_sha256:source.response_sha256,reviews});
 }
 const output={version:1,model:data.model,corpus_sha256:data.corpus_sha256,review_status:'pending_identity_and_external_verification',records:rows};
 document.getElementById('export-json').value=JSON.stringify(output,null,2);document.getElementById('export-preview').hidden=false;
 const url=URL.createObjectURL(new Blob([JSON.stringify(output,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='knowladder-human-reviews.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);message.textContent='已生成'+count+'条评审记录并发起下载；下载未出现时可复制下方JSON。仍须核实身份、独立性和分歧，不自动判定验收通过。';
});
</script></body></html>`;
}
if(require.main===module){try{if(process.argv.length!==3||fs.statSync(process.argv[2]).size>10000000)throw Error('invalid');process.stdout.write(render(JSON.parse(fs.readFileSync(process.argv[2],'utf8'))));}catch{process.stderr.write('REVIEW_PACK_INVALID\n');process.exitCode=1;}}
module.exports={prepare,render,escapeHtml};
