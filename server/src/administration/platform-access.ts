import { newId } from "../database/object-id";
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ClientSession } from 'mongodb';
import { AuthService, type Identity } from '../auth.service';
import { Database } from '../database/database';
import { collections, type AdministrativeGrant } from '../database/contracts';
import { assertAdministrationAccess, effectiveAdministrativeGrants } from './authorization';
import { ApiRequest, fail } from '../errors';
import { assertOperationalAccess } from '../operations/control';
export type BusinessModule = 'content' | 'assessment' | 'report';
export interface PlatformBusinessContext {
  principalKind: 'platform_delegate';
  orgId: string;
  actorOrgId: string;
  userId: string;
  memberId: string;
  actorMemberId: string;
  capabilities: string[];
  grantIds: string[];
  grantRevision: number;
  grants: Array<{ id: string; revision: number; capability: string }>;
  session: ClientSession;
  requestId: string;
}

// Only the internal controller can opt a Request into the platform path. Neither
// HTTP headers nor platform_ops roles are an implicit business credential.
const businessRequests = new WeakMap<ApiRequest, { module: BusinessModule; accepted: readonly string[] }>();
export function bindPlatformBusinessRequest(req: ApiRequest, module: BusinessModule, accepted?: readonly string[]): void {
  businessRequests.set(req, { module, accepted: accepted ?? MODULE_CAPABILITIES[module] });
}
const resourceIdPattern = /^[0-9a-f]{24}$/;
export function platformBusinessModule(req: ApiRequest): BusinessModule | undefined {
  return businessRequests.get(req)?.module;
}
const MODULE_CAPABILITIES: Record<BusinessModule, readonly string[]> = {
  content: ['content:edit', 'content:review', 'content:retire', 'content:revoke', 'file:delete'],
  assessment: ['assessment:manage', 'assessment:review'],
  report: ['report:read'],
};
function covers(grant: AdministrativeGrant, target: string): boolean {
  return grant.scope.kind === 'all_organizations' ||
    grant.scope.kind === 'organization_ids' && grant.scope.organization_ids.includes(target);
}

@Injectable()
export class PlatformBusinessAccess {
  constructor(readonly database: Database, readonly auth: AuthService) {}

  async authorize(req: ApiRequest, identity: Identity, session: ClientSession, module: BusinessModule): Promise<PlatformBusinessContext> {
    const binding = businessRequests.get(req);
    if (!binding || binding.module !== module || !binding.accepted.length ||
      binding.accepted.some(capability => !MODULE_CAPABILITIES[module].includes(capability)))
      fail(403, 'FORBIDDEN', '平台业务入口无效');
    const actorOrgId = req.get('X-Org-Id'), targetOrgId = req.get('X-Target-Org-Id');
    if (!actorOrgId || !resourceIdPattern.test(actorOrgId) || !targetOrgId || !resourceIdPattern.test(targetOrgId))
      fail(422, 'ORG_REQUIRED', '请选择平台组织和目标组织');
    if (actorOrgId === targetOrgId) fail(403, 'FORBIDDEN', '目标必须是独立业务组织');
    await assertAdministrationAccess(this.database.db, identity.user._id, targetOrgId, session);
    await this.auth.authorize(identity, actorOrgId, 'account:read', session);
    const c = collections(this.database.db);
    const actorOrg = await c.organizations.findOne({ _id: actorOrgId, kind: 'platform', status: 'active' }, { session });
    const targetOrg = await c.organizations.findOne({ _id: targetOrgId, status: 'active', kind: { $ne: 'platform' } }, { session });
    const member = await c.members.findOne({ org_id: actorOrgId, user_id: identity.user._id, status: 'active' }, { session });
    if (!actorOrg || !targetOrg || !member) fail(403, 'FORBIDDEN', '平台或目标组织不可用');
    if (module !== 'report') {
      const fencedTarget = await c.organizations.updateOne({ _id: targetOrgId, status: 'active', kind: { $ne: 'platform' } },
        [{ $set: { updated_at: '$$NOW' } }], { session });
      if (fencedTarget.matchedCount !== 1) fail(403, 'FORBIDDEN', '目标组织状态已变化');
    }
    const grants = (await effectiveAdministrativeGrants(this.database.db, member._id, session))
      .filter(grant => grant.actor_org_id === actorOrgId && binding.accepted.includes(grant.capability) && covers(grant, targetOrgId));
    if (!grants.length) fail(403, 'FORBIDDEN', '目标组织无有效业务授权');
    return { principalKind: 'platform_delegate', actorOrgId, orgId: targetOrgId, userId: identity.user._id,
      memberId: member._id, actorMemberId: member._id, capabilities: [...new Set(grants.map(g => g.capability))],
      grantIds: grants.map(g => g._id), grantRevision: Math.max(...grants.map(g => g.revision)),
      grants: grants.map(g => ({ id: g._id, revision: g.revision, capability: g.capability })),
      session, requestId: req.requestId };
  }
  async assertCurrent(ctx: PlatformBusinessContext): Promise<void> {
    await assertAdministrationAccess(this.database.db, ctx.userId, ctx.orgId, ctx.session);
    const c = collections(this.database.db);
    const target = await c.organizations.findOne({ _id: ctx.orgId, status: 'active', kind: { $ne: 'platform' } }, { session: ctx.session });
    if (!target) fail(403, 'FORBIDDEN', '目标组织已失效');
    const active = await effectiveAdministrativeGrants(this.database.db, ctx.actorMemberId, ctx.session);
    if (!ctx.grants.every(proof => active.some(grant => grant._id === proof.id &&
      grant.revision === proof.revision && grant.capability === proof.capability &&
      grant.actor_org_id === ctx.actorOrgId && covers(grant, ctx.orgId))))
      fail(403, 'FORBIDDEN', '平台业务授权已过期或撤销');
  }

  /** Reads and their sensitive audit commit as one unit on replica sets. */
  async run<T>(req: ApiRequest, module: BusinessModule, work: (ctx: PlatformBusinessContext) => Promise<T>): Promise<T> {
    await assertOperationalAccess(this.database.db);
    return this.database.transaction(async session => {
      const identity = await this.auth.identify(req, true, session);
      const ctx = await this.authorize(req, identity, session, module);
      await this.auth.rate('platform-business', `${ctx.actorOrgId}:${ctx.actorMemberId}:${ctx.orgId}:${module}`, 120);
      const result = await work(ctx);
      await this.assertCurrent(ctx);
      return result;
    });
  }

  async audit(ctx: PlatformBusinessContext, action: string, resourceType: string, resourceId: string, accepted?: readonly string[]): Promise<void> {
    const grant = accepted ? ctx.grants.find(row => accepted.includes(row.capability)) : ctx.grants[0];
    if (!grant) fail(403, 'FORBIDDEN', '缺少敏感操作所需授权元组');
    await collections(this.database.db).audit.insertOne({ _id: newId(), actor_id: ctx.userId, org_id: ctx.orgId,
      actor_org_id: ctx.actorOrgId, target_org_id: ctx.orgId, grant_id: grant.id, grant_ids: ctx.grantIds,
      grant_revision: grant.revision, action, resource_type: resourceType, resource_id: resourceId,
      owner_type: null, owner_version_id: null, revision_before: null, revision_after: null,
      access_revision_before: null, access_revision_after: null,
      reason: '平台业务敏感读取', request_id: ctx.requestId, created_at: new Date() }, { session: ctx.session });
  }
}
