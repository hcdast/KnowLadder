import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Db } from 'mongodb';
const oid=/^[0-9a-f]{24}$/;
export interface AssignmentRecoveryPlan {
  orgId:string; userId:string; memberId:string; courseId:string; classId:string;
  subjectId:string; courseRevision:number; key:string; timestamp:Date;
}
/** Internal first effect only. No API admission; authorization and read gates remain external. */
export class AssignmentRecovery {
  constructor(private readonly db:Db) {}
  static identity(plan:AssignmentRecoveryPlan, kind:'assignment'|'audit'|'receipt') {
    return createHash('sha256').update(JSON.stringify(['course.assign.v1',plan.orgId,plan.userId,plan.key,plan.courseId,plan.classId,kind])).digest('hex').slice(0,24);
  }
  async ensureAssignment(plan:AssignmentRecoveryPlan) {
    if ([plan.orgId,plan.userId,plan.memberId,plan.courseId,plan.classId,plan.subjectId].some(x=>!oid.test(x)) || !Number.isSafeInteger(plan.courseRevision) || plan.courseRevision<1 || !/^[A-Za-z0-9_-]{8,128}$/.test(plan.key) || !(plan.timestamp instanceof Date) || !Number.isFinite(plan.timestamp.getTime())) throw Error('ASSIGNMENT_RECOVERY_INPUT');
    const expected={_id:AssignmentRecovery.identity(plan,'assignment'),org_id:plan.orgId,class_id:plan.classId,course_id:plan.courseId,subject_id:plan.subjectId,status:'active',revision:1,created_at:plan.timestamp,updated_at:plan.timestamp};
    const filter={org_id:plan.orgId,class_id:plan.classId,course_id:plan.courseId};
    // Caller must own and fence the resource; $setOnInsert never revives ended links.
    try {await this.db.collection<{_id:string;[key:string]:any}>('class_courses').updateOne(filter,{$setOnInsert:expected},{upsert:true});}
    catch(e){if((e as {code?:number}).code!==11000)throw e;}
    const stored=await this.db.collection<{_id:string;[key:string]:any}>('class_courses').findOne(filter);
    if(!stored)throw Error('ASSIGNMENT_RECOVERY_CONFLICT');
    if(stored.status!=='active')throw Error('ASSIGNMENT_ENDED');
    if(stored._id!==expected._id)return {status:'already_assigned' as const,assignment_id:stored._id};
    if(!isDeepStrictEqual(stored,expected))throw Error('ASSIGNMENT_RECOVERY_CHANGED');
    return {status:'assigned' as const,assignment_id:expected._id};
  }
}