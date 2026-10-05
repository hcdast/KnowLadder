import { createHash } from 'node:crypto';
import { fail } from '../errors';
import { canonical, id, integer, object, text } from '../content/dto';
import type { AssessmentContext, AssessmentSession, Quiz, SessionItem, StudentAnswer } from './contracts';
import { scoreCents, scoreText } from './scoring';
export { canonical, id, ids, integer, object, text } from '../content/dto';
export function difficulty(value:unknown):'基础'|'提升'|'挑战'|null {
  if(value===undefined)return null;
  if(value!=='基础'&&value!=='提升'&&value!=='挑战')fail(422,'VALIDATION_ERROR','难度无效');
  return value;
}
export function sessionDto(row:AssessmentSession,now:Date){return {id:row._id,mode:row.mode,status:row.status,revision:row.revision,server_time:now,started_at:row.started_at,deadline_at:row.deadline_at,submission_id:row.submission_id,item_count:row.item_count,quiz_id:row.quiz_id,textbook_edition_id:row.textbook_edition_id};}
export function quizDto(row:Quiz){return {id:row._id,title:row.title,subject_id:row.subject_id,status:row.status,revision:row.revision,opens_at:row.opens_at,closes_at:row.closes_at,release_at:row.release_at,duration_seconds:row.duration_seconds,max_attempts:row.max_attempts,...(row.source_class_ids?{source_class_ids:row.source_class_ids}:{})};}
export function itemDto(row:SessionItem,answer:StudentAnswer){const q=row.snapshot;return {id:row._id,position:row.position,question_type:q.question_type,title:q.title,prompt:q.prompt,options:q.options,resource_ids:q.resource_ids,max_score:scoreText(scoreCents(row.max_score)),answer};}
export function pageInput(raw:unknown,ctx:AssessmentContext,resource:string,keys:string[]=[],revision?:{name:string,value:number}) {
  const q=object(raw,['cursor','limit',...keys,...(revision?[revision.name]:[])]);
  const limit=q.limit===undefined?20:integer(Number(q.limit),'limit',1,50);
  if(revision){if(q.cursor!==undefined&&q[revision.name]===undefined)fail(422,'REVISION_REQUIRED','续页需要修订号');if(q[revision.name]!==undefined&&integer(Number(q[revision.name]),revision.name)!==revision.value)fail(409,'REVISION_CONFLICT','数据修订已变化，请重新读取');}
  const filters=Object.fromEntries(keys.map(k=>[k,q[k]??null]));
  const scope=createHash('sha256').update(canonical({org:ctx.orgId,user:ctx.userId,member:ctx.memberId,resource,limit,filters,revision:revision?.value??null})).digest('hex');
  let after:string|undefined;
  if(q.cursor!==undefined){try{const c=JSON.parse(Buffer.from(text(q.cursor,'cursor',1000),'base64url').toString('utf8'));if(c.scope!==scope)throw Error();after=id(c.after);}catch{fail(422,'CURSOR_INVALID','分页游标无效');}}
  return {q,limit,after,next:(key:string)=>Buffer.from(JSON.stringify({scope,after:key})).toString('base64url')};
}
export function boundedSnapshots(rows:SessionItem[]|{snapshot:unknown}[]){let total=0;for(const row of rows){const size=Buffer.byteLength(JSON.stringify(row.snapshot));if(size>128*1024)fail(422,'SNAPSHOT_LIMIT','单题快照超限');total+=size;}if(total>4*1024*1024)fail(422,'SNAPSHOT_LIMIT','试卷快照超限');}
