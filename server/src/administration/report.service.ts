import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { collections, type Member } from '../database/contracts';
import { Database } from '../database/database';
import { ApiRequest, fail } from '../errors';
import { id, integer, object, text } from '../assessment/dto';
import { percentage } from '../learning/projection';
import { RULE_VERSION } from '../learning/contracts';
import { readPublishedLearningView } from '../learning/view';
import { CLASS_STUDENT_LIMIT, currentlyValid, type ClassMemberRecord, type ClassRecord, type TeachingAssignmentRecord } from '../teaching/contracts';
import { PlatformBusinessAccess, type PlatformBusinessContext } from './platform-access';
import { activeMemberGrants, activeMemberRoles, assertAdministrationAccess, scopedBusinessCapabilities } from './authorization';

@Injectable()
export class PlatformReportService {
  constructor(readonly access: PlatformBusinessAccess, readonly database: Database) {}

  private async classSubject(ctx: PlatformBusinessContext, classId: string, subjectId: string) {
    const db = this.database.db, classKey = id(classId), subjectKey = id(subjectId);
    const clazz = await db.collection<ClassRecord>('classes')
      .findOne({ _id: classKey, org_id: ctx.orgId, status: 'active' }, { session: ctx.session });
    const subject = await db.collection<{ _id: string }>('subjects').findOne({ _id: subjectKey }, { session: ctx.session });
    if (!clazz || !subject) fail(404, 'NOT_FOUND', '班级或学科不存在');
    const current = await db.aggregate<{ now: Date }>([{ $documents: [{}] }, { $project: { now: '$$NOW' } }], { session: ctx.session }).next();
    if (!(current?.now instanceof Date)) fail(503, 'DATABASE_TIME_UNAVAILABLE', '数据库时间不可用');
    const assignments = await db.collection<TeachingAssignmentRecord>('teaching_assignments')
      .find({ org_id: ctx.orgId, class_id: classKey, subject_id: subjectKey, status: 'active' }, { session: ctx.session })
      .limit(20).toArray();
    if (!assignments.some(row => currentlyValid(row, current.now))) fail(404, 'NOT_FOUND', '班级学科不存在');
    return { clazz, subjectKey };
  }

  private async roster(ctx: PlatformBusinessContext, classId: string): Promise<Member[]> {
    const now = await this.access.database.db.aggregate<{ now: Date }>([{ $documents: [{}] }, { $project: { now: '$$NOW' } }], { session: ctx.session }).next();
    if (!(now?.now instanceof Date)) fail(503, 'DATABASE_TIME_UNAVAILABLE', '数据库时间不可用');
    const rows = await this.database.db.collection<ClassMemberRecord>('class_members')
      .find({ org_id: ctx.orgId, class_id: classId, kind: 'student', status: 'active' }, { session: ctx.session })
      .sort({ member_id: 1 }).limit(CLASS_STUDENT_LIMIT + 1).toArray();
    if (rows.length > CLASS_STUDENT_LIMIT) fail(409, 'CLASS_TOO_LARGE', '班级名册超过上限');
    const active = rows.filter(row => currentlyValid(row, now.now)).map(row => row.member_id);
    if (!active.length) return [];
    const users = collections(this.database.db);
    const members = await users.members.find({ org_id: ctx.orgId, _id: { $in: active }, status: 'active' }, { session: ctx.session }).toArray();
    const validUsers = await users.users.find({ _id: { $in: members.map(m => m.user_id) }, status: 'active',
      $or: [{ privacy_state: 'active' }, { privacy_state: { $exists: false } }] }, { session: ctx.session, projection: { _id: 1 } }).toArray();
    const allowed = new Set(validUsers.map(user => user._id));
    const eligible = members.filter(member => allowed.has(member.user_id));
    if (!eligible.length) return [];
    const roles = await activeMemberRoles(this.database.db, { org_id: ctx.orgId,
      member_id: { $in: eligible.map(member => member._id) } }, ctx.session);
    const roleDocs = await users.roles.find({ _id: { $in: [...new Set(roles.map(role => role.role_id))] } }, { session: ctx.session }).toArray();
    const byRole = new Map(roleDocs.map(role => [role._id, role.capabilities]));
    const caps = new Map<string, string[]>();
    for (const row of roles) caps.set(row.member_id, [...(caps.get(row.member_id) ?? []), ...(byRole.get(row.role_id) ?? [])]);
    const grants = await activeMemberGrants(this.database.db, { org_id: ctx.orgId, member_id: { $in: eligible.map(member => member._id) } }, ctx.session);
    for (const grant of grants) caps.set(grant.member_id, [...(caps.get(grant.member_id) ?? []), grant.capability]);
    const valid: Member[] = [];
    for (const member of eligible) {
      await assertAdministrationAccess(this.database.db, member.user_id, ctx.orgId, ctx.session);
      const capabilities = caps.get(member._id) ?? [];
      if (!capabilities.includes('learning:self') || !capabilities.includes('account:read') ||
          capabilities.some(cap => ['content:edit', 'content:review', 'assessment:manage', 'assessment:review'].includes(cap))) continue;
      const scoped = await scopedBusinessCapabilities(this.database.db, member.user_id, ctx.orgId, ctx.session);
      if (!scoped.some(cap => ['content:edit', 'content:review', 'assessment:manage', 'assessment:review'].includes(cap)))
        valid.push(member);
    }
    return valid;
  }

  async options(req: ApiRequest, raw: unknown) {
    const q = object(raw, ['class_id', 'resource', 'cursor', 'limit']);
    return this.access.run(req, 'report', async ctx => {
      const limit = q.limit === undefined ? 20 : integer(Number(q.limit), 'limit', 1, 50);
      const resource = q.class_id !== undefined ? 'members' : q.resource === undefined ? 'classes' : text(q.resource, 'resource', 16);
      if (!['members', 'classes', 'subjects'].includes(resource) || resource === 'members' && q.class_id === undefined ||
          resource !== 'members' && q.class_id !== undefined || q.class_id !== undefined && q.resource !== undefined && q.resource !== 'members')
        fail(422, 'VALIDATION_ERROR', '报告目录类型无效');
      const classKey = q.class_id === undefined ? null : id(q.class_id);
      const scope = JSON.stringify([ctx.userId, ctx.actorOrgId, ctx.orgId, ctx.actorMemberId, resource, classKey, limit]);
      const sign = (value: string) => createHmac('sha256', this.access.auth.config.rateLimitKey).update(`report-options:${value}`).digest('base64url');
      let after: string | null = null;
      if (q.cursor !== undefined) {
        try {
          const [payload, mac] = text(q.cursor, 'cursor', 2000).split('.');
          const actual = Buffer.from(mac ?? '', 'base64url'), expected = Buffer.from(sign(payload), 'base64url');
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
          const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
          if (decoded.scope !== scope) throw Error();
          after = id(decoded.after);
        } catch { fail(422, 'CURSOR_INVALID', '报告目录游标无效'); }
      }
      const next = (key: string) => {
        const payload = Buffer.from(JSON.stringify({ scope, after: key })).toString('base64url');
        return `${payload}.${sign(payload)}`;
      };
      if (classKey) {
        const clazz = await this.database.db.collection<ClassRecord>('classes')
          .findOne({ _id: classKey, org_id: ctx.orgId, status: 'active' }, { session: ctx.session });
        if (!clazz) fail(404, 'NOT_FOUND', '班级不存在');
        const members = (await this.roster(ctx, classKey)).filter(row => !after || row._id > after).sort((a,b) => a._id.localeCompare(b._id));
        await this.access.audit(ctx, 'report.options.members', 'class', classKey);
        return { class_id: classKey, items: members.slice(0, limit).map(m => ({ member_id: m._id })),
          next_cursor: members.length > limit ? next(members[limit - 1]._id) : null };
      }
      if (resource === 'subjects') {
        const subjects = await this.database.db.collection<{ _id: string; name: string }>('subjects')
          .find(after ? { _id: { $gt: after } } : {}, { session: ctx.session }).sort({ _id: 1 }).limit(limit + 1).toArray();
        await this.access.audit(ctx, 'report.options.subjects', 'organization', ctx.orgId);
        return { items: subjects.slice(0, limit).map(row => ({ id: row._id, name: row.name })),
          next_cursor: subjects.length > limit ? next(subjects[limit - 1]._id) : null };
      }
      const classes = await this.database.db.collection<ClassRecord>('classes').find({ org_id: ctx.orgId, status: 'active',
        ...(after ? { _id: { $gt: after } } : {}) }, { session: ctx.session }).sort({ _id: 1 }).limit(limit + 1).toArray();
      await this.access.audit(ctx, 'report.options.classes', 'organization', ctx.orgId);
      return { items: classes.slice(0, limit).map(row => ({ id: row._id, name: row.name })),
        next_cursor: classes.length > limit ? next(classes[limit - 1]._id) : null };
    });
  }


  async student(req: ApiRequest, classId: string, subjectId: string, memberId: string, periodRaw?: unknown) {
    const period = periodRaw === undefined ? '30d' : text(periodRaw, 'period', 8);
    if (period !== '7d' && period !== '30d') fail(422, 'VALIDATION_ERROR', '报告周期无效');
    return this.access.run(req, 'report', async ctx => {
      const { clazz, subjectKey } = await this.classSubject(ctx, classId, subjectId);
      const key = id(memberId), roster = await this.roster(ctx, clazz._id), member = roster.find(row => row._id === key);
      if (!member) fail(404, 'NOT_FOUND', '学生不在有效班级名册');
      const view = await readPublishedLearningView(this.database.db, ctx, { memberId: member._id, userId: member.user_id }, subjectKey);
      const report = view.reports.find(row => row.period === period);
      const available = view.status === 'ready' || view.status === 'insufficient_evidence';
      const activity = available && report ? {
        submission_count: report.submission_count, attempt_count: report.attempt_count,
        correct_count: report.correct_count, incorrect_count: report.incorrect_count,
        unanswered_count: report.unanswered_count, independent_question_count: report.independent_question_count,
        numerator: report.numerator, denominator: report.denominator,
        correctness: percentage(BigInt(report.numerator), BigInt(report.denominator)),
      } : null;
      const result = { class_id: clazz._id, subject_id: subjectKey, member_id: member._id, status: view.status,
        source_watermark: view.source_watermark, generated_at: view.generated_at, rule_version: view.rule_version,
        period, activity, mastery_window_days: 90,
        mastery: available ? view.mastery.map(row => ({ knowledge_point_id: row.knowledge_point_id,
          independent_question_count: row.independent_question_count, numerator: row.numerator, denominator: row.denominator,
          mastery: row.mastery, status: row.classification, last_evidence_at: row.last_evidence_at.toISOString() })) : [] };
      await this.access.audit(ctx, 'report.student.read', 'class', clazz._id);
      return result;
    });
  }

  async classReport(req: ApiRequest, classId: string, subjectId: string) {
    return this.access.run(req, 'report', async ctx => {
      const { clazz, subjectKey } = await this.classSubject(ctx, classId, subjectId);
      const roster = await this.roster(ctx, clazz._id);
      const bands = { insufficient_evidence: 0, weak: 0, developing: 0, mastered: 0 };
      let projected = 0, submissions7d = 0, submissions30d = 0;
      let unavailable: 'stale' | 'updating' | null = null;
      const weak = new Map<string, number>();
      for (const member of roster) {
        const view = await readPublishedLearningView(this.database.db, ctx, { memberId: member._id, userId: member.user_id }, subjectKey);
        if (view.status === 'stale' || view.status === 'updating' || view.status === 'unavailable') {
          unavailable = view.status === 'stale' ? 'stale' : unavailable ?? 'updating';
          continue;
        }
        if (view.mastery.length || view.reports.length) projected += 1;
        const report7 = view.reports.find(row => row.period === '7d'), report30 = view.reports.find(row => row.period === '30d');
        submissions7d += report7?.submission_count ?? 0;
        submissions30d += report30?.submission_count ?? 0;
        const primary = [...view.mastery].sort((a,b) => {
          const rank = { weak: 0, insufficient_evidence: 1, developing: 2, mastered: 3 };
          return rank[a.classification] - rank[b.classification] || a.knowledge_point_id.localeCompare(b.knowledge_point_id);
        })[0];
        if (primary) bands[primary.classification] += 1;
        for (const row of view.mastery) if (row.classification === 'weak') weak.set(row.knowledge_point_id, (weak.get(row.knowledge_point_id) ?? 0) + 1);
      }
      const status = unavailable ?? (projected === 0 ? 'insufficient' : 'ready');
      const top = status !== 'ready' ? [] : [...weak.entries()].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10);
      const points = await this.database.db.collection<{ _id: string; name: string }>('knowledge_points')
        .find({ _id: { $in: top.map(row => row[0]) }, subject_id: subjectKey }, { session: ctx.session }).toArray();
      const labels = new Map(points.map(point => [point._id, point.name]));
      const result = { class_id: clazz._id, subject_id: subjectKey, status, roster_count: roster.length,
        projected_count: unavailable ? null : projected,
        mastery_bands: unavailable || !projected ? null : bands,
        submission_count_7d: status !== 'ready' ? null : submissions7d,
        submission_count_30d: status !== 'ready' ? null : submissions30d,
        weak_knowledge_points: top.map(([knowledge_point_id, student_count]) => ({ knowledge_point_id, title: labels.get(knowledge_point_id) ?? knowledge_point_id, student_count })),
        rule_version: RULE_VERSION };
      await this.access.audit(ctx, 'report.class.read', 'class', clazz._id);
      return result;
    });
  }
}
