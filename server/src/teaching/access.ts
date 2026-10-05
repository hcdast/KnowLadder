import { Injectable } from '@nestjs/common';
import { AssessmentAccess } from '../assessment/access';
import type { AssessmentContext } from '../assessment/contracts';
import { ApiRequest, fail } from '../errors';
import { id } from '../assessment/dto';
import {
  currentlyValid,
  type ClassRecord,
  type TeachingAssignmentRecord,
  type TeachingContext,
} from './contracts';

@Injectable()
export class TeachingAccess {
  constructor(readonly assessment: AssessmentAccess) {}

  run<T>(req: ApiRequest, write: boolean, work: (ctx: TeachingContext) => Promise<T>): Promise<T> {
    let rated = false;
    return this.assessment.run(req, write, async ctx => {
      if (!rated) {
        await this.assessment.auth.rate('teaching', `${ctx.orgId}:${ctx.memberId}:${write ? 'write' : 'read'}`, write ? 120 : 240);
        rated = true;
      }
      return work(ctx);
    });
  }

  require(ctx: TeachingContext, capability: string): void {
    if (!ctx.capabilities.includes(capability)) fail(403, 'FORBIDDEN', '未获教师业务能力');
  }

  requireAny(ctx: TeachingContext, capabilities: string[]): void {
    if (!capabilities.some(capability => ctx.capabilities.includes(capability))) {
      fail(403, 'FORBIDDEN', '未获教师业务能力');
    }
  }

  now(ctx: TeachingContext) {
    return this.assessment.now(ctx);
  }

  idempotent<T>(
    ctx: TeachingContext,
    req: ApiRequest,
    operation: string,
    resourceId: string,
    payload: unknown,
    work: () => Promise<T>,
    responseStatus = 200,
  ): Promise<T> {
    return this.assessment.idempotent(ctx, req, operation, resourceId, payload, work, responseStatus);
  }

  audit(
    ctx: TeachingContext,
    resourceType: string,
    resourceId: string,
    action: string,
    reason: string,
    evidence: object = {},
  ): Promise<void> {
    return this.assessment.audit(ctx, resourceType, resourceId, action, reason, evidence);
  }

  /** Report/expand gate: subjectId optional = any subject on class; archived class → NOT_FOUND. */
  async requireAssignment(
    ctx: TeachingContext,
    classId: string,
    subjectId?: string,
  ): Promise<{ clazz: ClassRecord; assignment: TeachingAssignmentRecord }> {
    const classKey = id(classId);
    const subjectKey = subjectId === undefined ? undefined : id(subjectId);
    const now = await this.now(ctx);
    const clazz = await this.assessment.database.db
      .collection<ClassRecord>('classes')
      .findOne({ _id: classKey, org_id: ctx.orgId }, { session: ctx.session });
    if (!clazz || clazz.status === 'archived') fail(404, 'NOT_FOUND', '班级不存在');
    const filter: Record<string, unknown> = {
      org_id: ctx.orgId,
      class_id: classKey,
      member_id: ctx.memberId,
      status: 'active',
    };
    if (subjectKey !== undefined) filter.subject_id = subjectKey;
    const rows = await this.assessment.database.db
      .collection<TeachingAssignmentRecord>('teaching_assignments')
      .find(filter, { session: ctx.session })
      .limit(20)
      .toArray();
    const assignment = rows.find(row => currentlyValid(row, now));
    if (!assignment) fail(404, 'NOT_FOUND', '班级不存在');
    return { clazz, assignment };
  }
}

export type { AssessmentContext };
