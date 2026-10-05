import { newId } from "../database/object-id";
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { collections, type Member, type User } from '../database/contracts';
import { ApiRequest, fail } from '../errors';
import { id, ids, integer, object, text } from '../assessment/dto';
import { RULE_VERSION, type MasteryRow } from '../learning/contracts';
import { percentage } from '../learning/projection';
import { readTargetLearningView } from '../learning/view';
import { TeachingAccess } from './access';
import { activeMemberGrants, activeMemberRoles, scopedBusinessCapabilities } from '../administration/authorization';
import {
  CLASS_STUDENT_LIMIT,
  ROSTER_CONFLICTS,
  assignmentView,
  classView,
  currentlyValid,
  type AssignmentView,
  type ClassMemberRecord,
  type ClassRecord,
  type ClassSubjectReportView,
  type ClassView,
  type RosterEntryView,
  type StudentSubjectReportView,
  type TeachingAssignmentRecord,
  type TeachingContext,
} from './contracts';

function dateOrNull(value: unknown, name: string): Date | null {
  if (value === undefined || value === null) return null;
  const raw = text(value, name, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    fail(422, 'VALIDATION_ERROR', `${name}无效`);
  }
  return new Date(raw);
}

@Injectable()
export class TeachingService {
  constructor(readonly access: TeachingAccess) {}

  private classes() {
    return this.access.assessment.database.db.collection<ClassRecord>('classes');
  }
  private members() {
    return this.access.assessment.database.db.collection<ClassMemberRecord>('class_members');
  }
  private assignments() {
    return this.access.assessment.database.db.collection<TeachingAssignmentRecord>('teaching_assignments');
  }

  private async loadClass(ctx: TeachingContext, classId: string): Promise<ClassRecord> {
    const row = await this.classes().findOne({ _id: id(classId), org_id: ctx.orgId }, { session: ctx.session });
    if (!row) fail(404, 'NOT_FOUND', '班级不存在');
    return row;
  }

  private async assertWritableClass(ctx: TeachingContext, classId: string): Promise<ClassRecord> {
    const row = await this.loadClass(ctx, classId);
    if (row.status === 'archived') fail(409, 'CLASS_ARCHIVED', '归档班级不可修改名册或作为展开源');
    return row;
  }

  private async assertRosterWriter(ctx: TeachingContext, classId: string): Promise<void> {
    if (ctx.capabilities.includes('teaching:assign')) return;
    this.access.require(ctx, 'teaching:roster');
    const now = await this.access.now(ctx);
    const rows = await this.assignments()
      .find({ org_id: ctx.orgId, class_id: id(classId), member_id: ctx.memberId, status: 'active' }, { session: ctx.session })
      .limit(20)
      .toArray();
    if (!rows.some(row => currentlyValid(row, now))) fail(404, 'NOT_FOUND', '班级不存在');
  }

  private async validateStudentMembers(ctx: TeachingContext, memberIds: string[]): Promise<void> {
    if (!memberIds.length) return;
    const c = collections(this.access.assessment.database.db);
    const options = { session: ctx.session };
    const members = await c.members.find({ org_id: ctx.orgId, _id: { $in: memberIds }, status: 'active' }, options).toArray();
    if (members.length !== memberIds.length) fail(422, 'PARTICIPANT_INVALID', '名册成员须为有效组织学生');
    const users = await c.users
      .find({ _id: { $in: members.map(m => m.user_id) }, status: 'active', must_change_password: false,
        $or: [{ privacy_state: 'active' }, { privacy_state: { $exists: false } }] }, options)
      .toArray();
    const userMap = new Map(users.map(user => [user._id, user]));
    const roleRows = await activeMemberRoles(this.access.assessment.database.db,
      { org_id: ctx.orgId, member_id: { $in: memberIds } }, ctx.session);
    const roles = await c.roles.find({ _id: { $in: [...new Set(roleRows.map(r => r.role_id))] } }, options).toArray();
    const roleMap = new Map(roles.map(role => [role._id, role.capabilities]));
    const grants = await activeMemberGrants(this.access.assessment.database.db,
      { org_id: ctx.orgId, member_id: { $in: memberIds } }, ctx.session);
    const caps = new Map<string, string[]>();
    for (const row of roleRows) caps.set(row.member_id, [...(caps.get(row.member_id) ?? []), ...(roleMap.get(row.role_id) ?? [])]);
    for (const grant of grants) caps.set(grant.member_id, [...(caps.get(grant.member_id) ?? []), grant.capability]);
    for (const member of members) {
      const user = userMap.get(member.user_id);
      const capabilities = caps.get(member._id) ?? [];
      if (
        !user ||
        !capabilities.includes('learning:self') ||
        !capabilities.includes('account:read') ||
        capabilities.some(cap => (ROSTER_CONFLICTS as readonly string[]).includes(cap))
      ) {
        fail(422, 'PARTICIPANT_INVALID', '名册成员须为有效且无职责冲突的学习成员');
      }
      const scoped = await scopedBusinessCapabilities(this.access.assessment.database.db, user._id, ctx.orgId, ctx.session);
      if (scoped.some(cap => (ROSTER_CONFLICTS as readonly string[]).includes(cap)))
        fail(422, 'PARTICIPANT_INVALID', '名册成员须为有效且无职责冲突的学习成员');
    }
  }

  private async bumpClassRevision(ctx: TeachingContext, clazz: ClassRecord, expected: number, now: Date): Promise<ClassRecord> {
    const result = await this.classes().findOneAndUpdate(
      { _id: clazz._id, org_id: ctx.orgId, revision: expected },
      { $inc: { revision: 1 }, $set: { updated_at: now } },
      { session: ctx.session, returnDocument: 'after' },
    );
    if (!result) fail(409, 'REVISION_CONFLICT', '班级已变化，请重新载入');
    return result;
  }

  async createClass(req: ApiRequest, raw: unknown): Promise<ClassView> {
    const body = object(raw, ['name', 'year_label']);
    const name = text(body.name, 'name', 200);
    const year_label = text(body.year_label, 'year_label', 64);
    return this.access.run(req, true, async ctx => {
      this.access.require(ctx, 'teaching:assign');
      return this.access.idempotent(ctx, req, 'teaching.class.create', 'new', body, async () => {
        const now = await this.access.now(ctx);
        const row: ClassRecord = {
          _id: newId(),
          org_id: ctx.orgId,
          name,
          year_label,
          status: 'active',
          revision: 1,
          created_by: ctx.userId,
          created_at: now,
          updated_at: now,
        };
        await this.classes().insertOne(row, { session: ctx.session });
        await this.access.audit(ctx, 'class', row._id, 'teaching.class.create', '创建班级', { revision_before: null, revision_after: 1 });
        return classView(row);
      });
    });
  }

  async patchClass(req: ApiRequest, classId: string, raw: unknown): Promise<ClassView> {
    const body = object(raw, ['expected_revision', 'name', 'year_label', 'status']);
    const expected = integer(body.expected_revision, 'expected_revision');
    const name = body.name === undefined ? undefined : text(body.name, 'name', 200);
    const year_label = body.year_label === undefined ? undefined : text(body.year_label, 'year_label', 64);
    const status = body.status === undefined ? undefined : text(body.status, 'status', 16);
    if (status !== undefined && status !== 'active' && status !== 'archived') fail(422, 'VALIDATION_ERROR', 'status无效');
    if (name === undefined && year_label === undefined && status === undefined) fail(422, 'VALIDATION_ERROR', '至少提供一项变更');
    return this.access.run(req, true, async ctx => {
      this.access.require(ctx, 'teaching:assign');
      const before = await this.loadClass(ctx, classId);
      return this.access.idempotent(ctx, req, 'teaching.class.patch', before._id, body, async () => {
        if (before.revision !== expected) fail(409, 'REVISION_CONFLICT', '班级已变化，请重新载入');
        const now = await this.access.now(ctx);
        const $set: Partial<ClassRecord> = { updated_at: now };
        if (name !== undefined) $set.name = name;
        if (year_label !== undefined) $set.year_label = year_label;
        if (status !== undefined) $set.status = status as ClassRecord['status'];
        const result = await this.classes().findOneAndUpdate(
          { _id: before._id, org_id: ctx.orgId, revision: expected },
          { $inc: { revision: 1 }, $set },
          { session: ctx.session, returnDocument: 'after' },
        );
        if (!result) fail(409, 'REVISION_CONFLICT', '班级已变化，请重新载入');
        await this.access.audit(ctx, 'class', before._id, 'teaching.class.patch', '更新班级', {
          revision_before: expected,
          revision_after: result.revision,
        });
        return classView(result);
      });
    });
  }

  async addMembers(req: ApiRequest, classId: string, raw: unknown): Promise<{ class: ClassView; added: number }> {
    const body = object(raw, ['expected_revision', 'member_ids']);
    const expected = integer(body.expected_revision, 'expected_revision');
    const memberIds = ids(body.member_ids, 'member_ids', CLASS_STUDENT_LIMIT).sort();
    if (!memberIds.length) fail(422, 'VALIDATION_ERROR', 'member_ids不能为空');
    return this.access.run(req, true, async ctx => {
      this.access.requireAny(ctx, ['teaching:roster', 'teaching:assign']);
      await this.assertRosterWriter(ctx, classId);
      const clazz = await this.assertWritableClass(ctx, classId);
      return this.access.idempotent(ctx, req, 'teaching.roster.add', clazz._id, body, async () => {
        if (clazz.revision !== expected) fail(409, 'REVISION_CONFLICT', '班级已变化，请重新载入');
        await this.validateStudentMembers(ctx, memberIds);
        const now = await this.access.now(ctx);
        const active = await this.members()
          .find({ org_id: ctx.orgId, class_id: clazz._id, status: 'active' }, { session: ctx.session })
          .project({ member_id: 1 })
          .toArray();
        const present = new Set(active.map(row => row.member_id));
        const fresh = memberIds.filter(memberId => !present.has(memberId));
        if (present.size + fresh.length > CLASS_STUDENT_LIMIT) {
          fail(422, 'CLASS_TOO_LARGE', `班级学生上限为${CLASS_STUDENT_LIMIT}，请拆班`);
        }
        for (const member_id of fresh) {
          const ended = await this.members().findOne(
            { org_id: ctx.orgId, class_id: clazz._id, member_id, status: 'ended' },
            { session: ctx.session },
          );
          if (ended) {
            const revived = await this.members().updateOne(
              { _id: ended._id, org_id: ctx.orgId, status: 'ended' },
              { $set: { status: 'active', valid_from: null, valid_to: null, updated_at: now } },
              { session: ctx.session },
            );
            if (revived.modifiedCount !== 1) fail(409, 'REVISION_CONFLICT', '名册并发冲突，请重试');
          } else {
            const row: ClassMemberRecord = {
              _id: newId(),
              org_id: ctx.orgId,
              class_id: clazz._id,
              member_id,
              kind: 'student',
              status: 'active',
              valid_from: null,
              valid_to: null,
              created_at: now,
              updated_at: now,
            };
            await this.members().insertOne(row, { session: ctx.session });
          }
        }
        const after = await this.bumpClassRevision(ctx, clazz, expected, now);
        await this.access.audit(ctx, 'class', clazz._id, 'teaching.roster.add', '添加名册学生', {
          revision_before: expected,
          revision_after: after.revision,
        });
        return { class: classView(after), added: fresh.length };
      });
    });
  }

  async removeMembers(req: ApiRequest, classId: string, raw: unknown): Promise<{ class: ClassView; removed: number }> {
    const body = object(raw, ['expected_revision', 'member_ids']);
    const expected = integer(body.expected_revision, 'expected_revision');
    const memberIds = ids(body.member_ids, 'member_ids', CLASS_STUDENT_LIMIT).sort();
    if (!memberIds.length) fail(422, 'VALIDATION_ERROR', 'member_ids不能为空');
    return this.access.run(req, true, async ctx => {
      this.access.requireAny(ctx, ['teaching:roster', 'teaching:assign']);
      await this.assertRosterWriter(ctx, classId);
      const clazz = await this.assertWritableClass(ctx, classId);
      return this.access.idempotent(ctx, req, 'teaching.roster.remove', clazz._id, body, async () => {
        if (clazz.revision !== expected) fail(409, 'REVISION_CONFLICT', '班级已变化，请重新载入');
        const now = await this.access.now(ctx);
        let removed = 0;
        for (const member_id of memberIds) {
          const result = await this.members().updateOne(
            { org_id: ctx.orgId, class_id: clazz._id, member_id, status: 'active' },
            { $set: { status: 'ended', valid_to: now, updated_at: now } },
            { session: ctx.session },
          );
          removed += result.modifiedCount;
        }
        const activeLeft = await this.members().countDocuments(
          { org_id: ctx.orgId, class_id: clazz._id, status: 'active' },
          { session: ctx.session },
        );
        const after = activeLeft
          ? await this.bumpClassRevision(ctx, clazz, expected, now)
          : await this.classes().findOneAndUpdate(
              { _id: clazz._id, org_id: ctx.orgId, revision: expected, status: 'active' },
              { $inc: { revision: 1 }, $set: { status: 'archived', updated_at: now } },
              { session: ctx.session, returnDocument: 'after' },
            );
        if (!after) fail(409, 'REVISION_CONFLICT', '班级已变化，请重新载入');
        await this.access.audit(ctx, 'class', clazz._id, 'teaching.roster.remove', activeLeft ? '移除名册学生' : '移除名册学生并归档空班', {
          revision_before: expected,
          revision_after: after.revision,
        });
        return { class: classView(after), removed };
      });
    });
  }

  async createAssignment(req: ApiRequest, raw: unknown): Promise<AssignmentView> {
    const body = object(raw, ['class_id', 'member_id', 'subject_id', 'valid_from', 'valid_to']);
    const class_id = id(body.class_id);
    const member_id = id(body.member_id);
    const subject_id = id(body.subject_id);
    const valid_from = dateOrNull(body.valid_from, 'valid_from');
    const valid_to = dateOrNull(body.valid_to, 'valid_to');
    if (valid_from && valid_to && valid_from > valid_to) fail(422, 'VALIDATION_ERROR', '有效区间无效');
    return this.access.run(req, true, async ctx => {
      this.access.require(ctx, 'teaching:assign');
      return this.access.idempotent(ctx, req, 'teaching.assignment.create', 'new', body, async () => {
        const clazz = await this.loadClass(ctx, class_id);
        if (clazz.status === 'archived') fail(409, 'CLASS_ARCHIVED', '归档班级不可写入授课关系');
        const subject = await this.access.assessment.database.db
          .collection<{ _id: string }>('subjects')
          .findOne({ _id: subject_id }, { session: ctx.session });
        if (!subject) fail(422, 'VALIDATION_ERROR', '学科不存在');
        const member = await collections(this.access.assessment.database.db).members.findOne(
          { _id: member_id, org_id: ctx.orgId, status: 'active' },
          { session: ctx.session },
        );
        if (!member) fail(422, 'VALIDATION_ERROR', '教师成员无效');
        const teacherRole = await activeMemberRoles(this.access.assessment.database.db,
          { org_id: ctx.orgId, member_id, role_id: 'teacher' }, ctx.session);
        if (!teacherRole.length) fail(422, 'VALIDATION_ERROR', '授课对象须具备teacher角色');
        const now = await this.access.now(ctx);
        const existing = await this.assignments().findOne(
          { org_id: ctx.orgId, class_id, member_id, subject_id, status: 'active' },
          { session: ctx.session },
        );
        if (existing) fail(409, 'ASSIGNMENT_EXISTS', '该班科授课关系已存在');
        const ended = await this.assignments().findOne(
          { org_id: ctx.orgId, class_id, member_id, subject_id, status: 'ended' },
          { session: ctx.session },
        );
        if (ended) {
          const revived = await this.assignments().findOneAndUpdate(
            { _id: ended._id, org_id: ctx.orgId, status: 'ended', revision: ended.revision },
            {
              $set: { status: 'active', valid_from, valid_to, updated_at: now },
              $inc: { revision: 1 },
            },
            { session: ctx.session, returnDocument: 'after' },
          );
          if (!revived) fail(409, 'REVISION_CONFLICT', '授课关系并发冲突，请重试');
          await this.access.audit(ctx, 'teaching_assignment', revived._id, 'teaching.assignment.create', '恢复授课关系', {
            revision_before: ended.revision,
            revision_after: revived.revision,
          });
          return assignmentView(revived);
        }
        const row: TeachingAssignmentRecord = {
          _id: newId(),
          org_id: ctx.orgId,
          class_id,
          member_id,
          subject_id,
          status: 'active',
          valid_from,
          valid_to,
          revision: 1,
          created_at: now,
          updated_at: now,
        };
        await this.assignments().insertOne(row, { session: ctx.session });
        await this.access.audit(ctx, 'teaching_assignment', row._id, 'teaching.assignment.create', '创建授课关系', {
          revision_before: null,
          revision_after: 1,
        });
        return assignmentView(row);
      });
    });
  }

  async endAssignment(req: ApiRequest, assignmentId: string, raw: unknown): Promise<AssignmentView> {
    const body = object(raw, ['expected_revision']);
    const expected = integer(body.expected_revision, 'expected_revision');
    return this.access.run(req, true, async ctx => {
      this.access.require(ctx, 'teaching:assign');
      const before = await this.assignments().findOne(
        { _id: id(assignmentId), org_id: ctx.orgId },
        { session: ctx.session },
      );
      if (!before) fail(404, 'NOT_FOUND', '授课关系不存在');
      return this.access.idempotent(ctx, req, 'teaching.assignment.end', before._id, body, async () => {
        if (before.status !== 'active') fail(409, 'INVALID_TRANSITION', '授课关系已结束');
        if (before.revision !== expected) fail(409, 'REVISION_CONFLICT', '授课关系已变化，请重新载入');
        const now = await this.access.now(ctx);
        const result = await this.assignments().findOneAndUpdate(
          { _id: before._id, org_id: ctx.orgId, status: 'active', revision: expected },
          { $set: { status: 'ended', valid_to: before.valid_to ?? now, updated_at: now }, $inc: { revision: 1 } },
          { session: ctx.session, returnDocument: 'after' },
        );
        if (!result) fail(409, 'REVISION_CONFLICT', '授课关系已变化，请重新载入');
        await this.access.audit(ctx, 'teaching_assignment', before._id, 'teaching.assignment.end', '结束授课关系', {
          revision_before: expected,
          revision_after: result.revision,
        });
        return assignmentView(result);
      });
    });
  }

  async listClasses(req: ApiRequest): Promise<{ items: ClassView[] }> {
    return this.access.run(req, false, async ctx => {
      this.access.require(ctx, 'teaching:class');
      const now = await this.access.now(ctx);
      const assignments = await this.assignments()
        .find({ org_id: ctx.orgId, member_id: ctx.memberId, status: 'active' }, { session: ctx.session })
        .limit(500)
        .toArray();
      const classIds = [...new Set(assignments.filter(row => currentlyValid(row, now)).map(row => row.class_id))];
      if (!classIds.length) return { items: [] };
      const rows = await this.classes()
        .find({ org_id: ctx.orgId, _id: { $in: classIds }, status: 'active' }, { session: ctx.session })
        .sort({ _id: 1 })
        .limit(200)
        .toArray();
      return { items: rows.map(classView) };
    });
  }

  async roster(req: ApiRequest, classId: string): Promise<{ class: ClassView; items: RosterEntryView[] }> {
    return this.access.run(req, false, async ctx => {
      this.access.require(ctx, 'teaching:class');
      const { clazz } = await this.access.requireAssignment(ctx, classId);
      const now = await this.access.now(ctx);
      const rows = await this.members()
        .find({ org_id: ctx.orgId, class_id: clazz._id, status: 'active' }, { session: ctx.session })
        .sort({ member_id: 1 })
        .limit(CLASS_STUDENT_LIMIT + 1)
        .toArray();
      if (rows.length > CLASS_STUDENT_LIMIT) fail(409, 'CLASS_TOO_LARGE', '名册超过上限');
      const active = rows.filter(row => currentlyValid(row, now));
      const memberIds = active.map(row => row.member_id);
      const c = collections(this.access.assessment.database.db);
      const members = await c.members
        .find({ org_id: ctx.orgId, _id: { $in: memberIds }, status: 'active' }, { session: ctx.session })
        .toArray();
      const users = await c.users
        .find({ _id: { $in: members.map((m: Member) => m.user_id) } }, { session: ctx.session, projection: { display_name: 1 } })
        .toArray();
      const userById = new Map(users.map((user: User) => [user._id, user]));
      const memberById = new Map(members.map((member: Member) => [member._id, member]));
      const items: RosterEntryView[] = [];
      for (const memberId of memberIds) {
        const member = memberById.get(memberId);
        const user = member ? userById.get(member.user_id) : undefined;
        if (!member || !user) continue;
        items.push({ member_id: memberId, display_name: user.display_name });
      }
      return { class: classView(clazz), items };
    });
  }

  private async activeRosterMembers(ctx: TeachingContext, classId: string, now: Date): Promise<Member[]> {
    const rows = await this.members()
      .find({ org_id: ctx.orgId, class_id: classId, status: 'active' }, { session: ctx.session })
      .sort({ member_id: 1 })
      .limit(CLASS_STUDENT_LIMIT + 1)
      .maxTimeMS(5000)
      .toArray();
    if (rows.length > CLASS_STUDENT_LIMIT) fail(409, 'CLASS_TOO_LARGE', '名册超过上限');
    const activeIds = rows.filter(row => currentlyValid(row, now)).map(row => row.member_id);
    if (!activeIds.length) return [];
    const members = await collections(this.access.assessment.database.db).members
      .find({ org_id: ctx.orgId, _id: { $in: activeIds }, status: 'active' }, { session: ctx.session })
      .maxTimeMS(5000)
      .toArray();
    const byId = new Map(members.map(member => [member._id, member]));
    return activeIds.map(key => byId.get(key)).filter((row): row is Member => !!row);
  }

  async classSubjectReport(req: ApiRequest, classId: string, subjectId: string): Promise<ClassSubjectReportView> {
    return this.access.run(req, false, async ctx => {
      this.access.require(ctx, 'teaching:report');
      return (await this.classSubjectReportFacts(ctx, classId, subjectId)).report;
    });
  }

  async classSubjectReportFacts(ctx: TeachingContext, classId: string, subjectId: string) {
      const source: unknown[] = [];
      let validUntil = new Date(Date.now()+60000);
      const subjectKey = id(subjectId);
      if (!await this.access.assessment.database.db.collection<{ _id: string }>('subjects').findOne({ _id: subjectKey }, { session: ctx.session })) {
        fail(404, 'NOT_FOUND', '学科不存在');
      }
      const { clazz } = await this.access.requireAssignment(ctx, classId, subjectKey);
      const now = await this.access.now(ctx);
      const roster = await this.activeRosterMembers(ctx, clazz._id, now);
      const bands = { insufficient_evidence: 0, weak: 0, developing: 0, mastered: 0 };
      let projected = 0;
      let submissions7d = 0;
      let submissions30d = 0;
      const weakCounts = new Map<string, number>();
      const db = this.access.assessment.database.db;

      for (const member of roster) {
        const view = await readTargetLearningView(db, ctx, { memberId: member._id, userId: member.user_id }, subjectKey);
        source.push([member._id, view.status, view.source_watermark, view.build?.manifest_digest ?? null]);
        if(view.checked_until && view.checked_until < validUntil) validUntil = view.checked_until;
        if (view.status === 'ready' || view.status === 'insufficient_evidence') {
          if (view.mastery.length || view.reports.length) projected += 1;
        }
        const report7 = view.reports.find(row => row.period === '7d');
        const report30 = view.reports.find(row => row.period === '30d');
        if (report7) submissions7d += report7.submission_count;
        if (report30) submissions30d += report30.submission_count;
        const primary = this.primaryMastery(view.mastery);
        if (primary) bands[primary.classification] += 1;
        for (const row of view.mastery) {
          if (row.classification !== 'weak') continue;
          weakCounts.set(row.knowledge_point_id, (weakCounts.get(row.knowledge_point_id) ?? 0) + 1);
        }
      }

      const topWeak = [...weakCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10);
      const titles = topWeak.length
        ? await db.collection<{ _id: string; name: string }>('knowledge_points')
          .find({ _id: { $in: topWeak.map(([key]) => key) }, subject_id: subjectKey }, { session: ctx.session, projection: { name: 1 } })
          .maxTimeMS(5000)
          .toArray()
        : [];
      const titleById = new Map(titles.map(row => [row._id, row.name]));
      const status = projected === 0 ? 'insufficient' : 'ready';
      const result: ClassSubjectReportView = {
        class_id: clazz._id,
        subject_id: subjectKey,
        status,
        roster_count: roster.length,
        projected_count: projected,
        mastery_bands: status === 'insufficient'
          ? { insufficient_evidence: 0, weak: 0, developing: 0, mastered: 0 }
          : bands,
        submission_count_7d: submissions7d,
        submission_count_30d: submissions30d,
        weak_knowledge_points: status === 'insufficient'
          ? []
          : topWeak.map(([knowledge_point_id, student_count]) => ({
            knowledge_point_id,
            title: titleById.get(knowledge_point_id) ?? knowledge_point_id,
            student_count,
          })),
        rule_version: RULE_VERSION,
      };
      await this.access.audit(ctx, 'class', clazz._id, 'teaching.report.class', '读取班级学科聚合报告', {
        subject_id: subjectKey,
        roster_count: roster.length,
        projected_count: projected,
      });
      return {report:result, source, validUntil};
  }

  async studentSubjectReport(
    req: ApiRequest,
    classId: string,
    subjectId: string,
    memberId: string,
    periodRaw?: unknown,
  ): Promise<StudentSubjectReportView> {
    return this.access.run(req, false, async ctx => {
      this.access.require(ctx, 'teaching:report');
      const subjectKey = id(subjectId);
      const targetMemberId = id(memberId);
      const period = periodRaw === undefined || periodRaw === null || periodRaw === '' ? '30d' : text(periodRaw, 'period', 8);
      if (period !== '7d' && period !== '30d') fail(422, 'VALIDATION_ERROR', '报告周期必须为7d或30d');
      if (!await this.access.assessment.database.db.collection<{ _id: string }>('subjects').findOne({ _id: subjectKey }, { session: ctx.session })) {
        fail(404, 'NOT_FOUND', '学科不存在');
      }
      const { clazz } = await this.access.requireAssignment(ctx, classId, subjectKey);
      const now = await this.access.now(ctx);
      const rosterRow = await this.members().findOne(
        { org_id: ctx.orgId, class_id: clazz._id, member_id: targetMemberId, status: 'active' },
        { session: ctx.session },
      );
      if (!rosterRow || !currentlyValid(rosterRow, now)) fail(404, 'NOT_FOUND', '学生不在本班名册');
      const member = await collections(this.access.assessment.database.db).members.findOne(
        { _id: targetMemberId, org_id: ctx.orgId, status: 'active' },
        { session: ctx.session },
      );
      if (!member) fail(404, 'NOT_FOUND', '学生不在本班名册');
      const view = await readTargetLearningView(
        this.access.assessment.database.db,
        ctx,
        { memberId: member._id, userId: member.user_id },
        subjectKey,
      );
      const report = view.reports.find(row => row.period === period);
      const activity = report
        ? {
          submission_count: report.submission_count,
          attempt_count: report.attempt_count,
          correct_count: report.correct_count,
          incorrect_count: report.incorrect_count,
          unanswered_count: report.unanswered_count,
          independent_question_count: report.independent_question_count,
          numerator: report.numerator,
          denominator: report.denominator,
          correctness: percentage(BigInt(report.numerator), BigInt(report.denominator)),
        }
        : null;
      const result: StudentSubjectReportView = {
        class_id: clazz._id,
        subject_id: subjectKey,
        member_id: member._id,
        status: view.status,
        source_watermark: view.source_watermark,
        generated_at: view.generated_at,
        rule_version: view.rule_version,
        period,
        activity: view.status === 'ready' || view.status === 'insufficient_evidence' ? activity : null,
        mastery_window_days: 90,
        mastery: (view.status === 'ready' || view.status === 'insufficient_evidence')
          ? view.mastery.map(row => ({
            knowledge_point_id: row.knowledge_point_id,
            independent_question_count: row.independent_question_count,
            numerator: row.numerator,
            denominator: row.denominator,
            mastery: row.mastery,
            status: row.classification,
            last_evidence_at: row.last_evidence_at.toISOString(),
          }))
          : [],
      };
      await this.access.audit(ctx, 'class', clazz._id, 'teaching.report.student', '读取单生学科报告', {
        subject_id: subjectKey,
        target_member_id: member._id,
      });
      return result;
    });
  }

  private primaryMastery(rows: MasteryRow[]): MasteryRow | null {
    if (!rows.length) return null;
    const rank = (row: MasteryRow) => {
      if (row.classification === 'weak') return 0;
      if (row.classification === 'insufficient_evidence') return 1;
      if (row.classification === 'developing') return 2;
      return 3;
    };
    return [...rows].sort((a, b) => {
      const delta = rank(a) - rank(b);
      if (delta !== 0) return delta;
      const left = BigInt(a.numerator) * BigInt(b.denominator);
      const right = BigInt(b.numerator) * BigInt(a.denominator);
      if (left < right) return -1;
      if (left > right) return 1;
      return a.knowledge_point_id.localeCompare(b.knowledge_point_id);
    })[0];
  }

}
