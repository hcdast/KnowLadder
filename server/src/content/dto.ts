import { fail } from '../errors';
import { uuidPattern } from './access';
import type { License, ScoringRule, KnowledgeWeight, QuestionVersion, BaseVersion, ChapterRecord } from './contracts';
export type Input = Record<string,unknown>;
export function object(value:unknown,keys:readonly string[]):Input {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k))) fail(422,'VALIDATION_ERROR','请求包含未知字段或结构无效');
  return value as Input;
}
export function text(value:unknown,name:string,max=200,empty=false):string {
  if(typeof value!=='string'||value.length>max||(!empty&&!value.trim())||value.includes('\u0000')) fail(422,'VALIDATION_ERROR',`${name}无效`);
  return value;
}
export function id(value:unknown,name='id'):string { const result=text(value,name,36);if(!uuidPattern.test(result))fail(422,'VALIDATION_ERROR',`${name}须为UUID`);return result.toLowerCase(); }
export function integer(value:unknown,name:string,min=1,max=Number.MAX_SAFE_INTEGER):number {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)fail(422,'VALIDATION_ERROR',`${name}无效`);return value;}
export function ids(value:unknown,name:string,max=20):string[] {if(!Array.isArray(value)||value.length>max)fail(422,'VALIDATION_ERROR',`${name}数量无效`);const result=value.map(v=>id(v,name));if(new Set(result).size!==result.length)fail(422,'VALIDATION_ERROR',`${name}不能重复`);return result;}
export function license(value:unknown):License { const v=object(value,['source','granted','expires_at']); const source=text(v.source,'授权来源',1000,true); if(typeof v.granted!=='boolean')fail(422,'VALIDATION_ERROR','授权确认无效');if(v.expires_at!==null&&(typeof v.expires_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v.expires_at)||!Number.isFinite(Date.parse(v.expires_at))))fail(422,'VALIDATION_ERROR','授权截止时间无效');return {source,granted:v.granted,expires_at:v.expires_at===null?null:new Date(v.expires_at as string).toISOString()}; }
export function dto(value:Record<string,unknown>):Record<string,unknown> {const {_id,...rest}=value;return {id:_id,...rest};}
export function canonical(value:unknown):string {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Input)[k])).join(',')+'}';return JSON.stringify(value);}
export function scoringRule(value:unknown):ScoringRule|null {
  if(value===null)return null;
  const rule=object(value,['version','strategy','max_score']);
  if(rule.version!==1||!['single_exact','multiple_exact_set','numeric_exact_decimal'].includes(rule.strategy as string))fail(422,'SCORING_RULE_INVALID','评分规则版本或策略无效');
  const score=text(rule.max_score,'max_score',6);
  if(!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/.test(score))fail(422,'SCORING_RULE_INVALID','满分须为正十进制字符串');
  const [whole,fraction='']=score.split('.');const cents=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(cents<=0||cents>10000)fail(422,'SCORING_RULE_INVALID','满分须大于0且不超过100');
  return {version:1,strategy:rule.strategy as ScoringRule['strategy'],max_score:score};
}
export function knowledgeWeights(value:unknown):KnowledgeWeight[] {
  if(!Array.isArray(value)||value.length>100)fail(422,'KNOWLEDGE_WEIGHTS_INVALID','知识权重数量无效');
  const result=value.map(raw=>{const row=object(raw,['knowledge_point_id','weight_bps']);return {knowledge_point_id:id(row.knowledge_point_id),weight_bps:integer(row.weight_bps,'weight_bps',1,10000)};});
  if(new Set(result.map(row=>row.knowledge_point_id)).size!==result.length)fail(422,'KNOWLEDGE_WEIGHTS_INVALID','知识权重不能重复');
  return result;
}
export function validateQuestion(q:QuestionVersion):void {
  if(!q.prompt.trim()||!q.knowledge_point_ids.length||!q.difficulty_basis?.trim()||!q.scoring_rule)fail(422,'QUESTION_INCOMPLETE','题干、知识点、评分规则与难度依据须补齐');
  const rule=scoringRule(q.scoring_rule)!;const weights=knowledgeWeights(q.knowledge_weights);
  if(rule.strategy!==({single:'single_exact',multiple:'multiple_exact_set',numeric:'numeric_exact_decimal'} as const)[q.question_type])fail(422,'SCORING_RULE_INVALID','策略与题型不匹配');
  if(weights.length!==q.knowledge_point_ids.length||weights.some(w=>!q.knowledge_point_ids.includes(w.knowledge_point_id))||weights.reduce((sum,w)=>sum+w.weight_bps,0)!==10000)fail(422,'KNOWLEDGE_WEIGHTS_INVALID','权重须覆盖全部知识点并合计10000');
  if(q.question_type==='numeric'){
    const answer=q.answer.trim();const match=/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE]([-+]?\d+))?$/.exec(answer);
    if(q.options.length||q.answer.length>100||!match||(match[1]!==undefined&&Math.abs(Number(match[1]))>100))fail(422,'ANSWER_INVALID','数值答案须为100字符内十进制文本，指数绝对值不超过100');
    return;
  }
  if(q.options.length<2||new Set(q.options.map(o=>o.id)).size!==q.options.length||q.options.some(o=>!o.text.trim()||!/^[A-Za-z0-9_-]+$/.test(o.id)))fail(422,'ANSWER_INVALID','选择题须有至少两个非空选项，选项id须合法且唯一');
  const answers=q.answer.split(',').map(v=>v.trim());
  if((q.question_type==='single'&&answers.length!==1)||(q.question_type==='multiple'&&answers.length<2)||new Set(answers).size!==answers.length||answers.some(a=>!q.options.some(o=>o.id===a)))fail(422,'ANSWER_INVALID','答案须为有效选项id，多选用英文逗号分隔');
}
export function studentEdition(version:BaseVersion):Record<string,unknown> {
  return {id:version._id,textbook_id:version.textbook_id,title:version.title,edition_code:version.edition_code,revision:version.revision,resource_ids:version.resource_ids};
}
export function studentChapter(chapter:ChapterRecord,revision:number):Record<string,unknown> {
  return {id:chapter._id,textbook_edition_id:chapter.textbook_edition_id,edition_revision:revision,parent_id:chapter.parent_id,position:chapter.position,title:chapter.title,body:chapter.body,knowledge_point_ids:chapter.knowledge_point_ids,resource_ids:chapter.resource_ids};
}
export function safeVersion(version:BaseVersion):Record<string,unknown> {
  const identity=version.textbook_id!==undefined?{textbook_id:version.textbook_id,edition_code:version.edition_code}:{question_id:version.question_id,version_no:version.version_no};
  return {id:version._id,title:version.title,...identity,status:version.status,revision:version.revision,access_revision:version.access_revision,access_revoked_at:version.access_revoked_at,access_revoked_by:version.access_revoked_by,access_revoked_reason:version.access_revoked_reason,retired_at:version.retired_at,retired_by:version.retired_by,retired_reason:version.retired_reason,created_at:version.created_at,updated_at:version.updated_at};
}
