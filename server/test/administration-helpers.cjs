"use strict";
const { randomUUID } = require("node:crypto");
const { fixture, Browser, PASSWORD, status } = require("./helpers.cjs");
const { scopeFingerprint, assertGrantPolicy } = require("../dist/administration/catalog.js");
const { executeAdministrationOperation } = require("../dist/administration/operations.js");

function consoleRequest(actor, path, { method = "GET", body, key = randomUUID(), headers = {} } = {}) {
  return actor.browser.request(`/console${path}`, { method, body, headers: { "X-Org-Id": actor.org, ...(method === "GET" ? {} : { "Idempotency-Key": key }), ...headers } });
}
async function administrativeGrant(f, actor, capability, organizationIds = [actor.org], options = {}) {
  const member = await f.db.collection("organization_members").findOne({ _id: actor.memberId });
  if (capability === "platform:govern") {
    await f.ops.bootstrapGovernance(f.context, { user_id: actor.user.user_id, org_id: actor.org, expected_revision: member.authorization_revision });
    return f.db.collection("administrative_grants").findOne({ subject_member_id: actor.memberId, capability });
  }
  const organization = await f.db.collection("organizations").findOne({ _id: actor.org });
  const assignments = await f.db.collection("member_roles").find({ member_id: actor.memberId }).toArray();
  const scope = options.all ? { kind: "all_organizations", organization_ids: [] } : { kind: "organization_ids", organization_ids: [...organizationIds].sort() };
  assertGrantPolicy(capability, scope, assignments.map(row => row.role_id), organization.kind, options.delegates ?? []);
  const clock = (await f.db.command({ hello: 1 })).localTime;
  const valid_from = options.validFrom ?? new Date(clock.getTime() - 1000);
  const valid_to = options.validTo !== undefined ? options.validTo : new Date(clock.getTime() + 3600000);
  const grantId = require("../dist/database/object-id.js").newId();
  await executeAdministrationOperation({ client: f.client, db: f.db, actor: f.context.actor, reason: "IAM 合成数据受审计初始化授权", action: "iam.fixture.grant",
    targets: { user_ids: [actor.user.user_id], member_ids: [actor.memberId], org_ids: [actor.org] },
    payload: { grant_id: grantId, subject_member_id: actor.memberId, capability, scope, valid_from: valid_from.toISOString(), valid_to: valid_to?.toISOString() ?? null, delegate_capabilities: options.delegates ?? [] },
    apply: async ({ session, now, operation_id }) => {
      await f.db.collection("administrative_grants").insertOne({ _id: grantId, subject_member_id: actor.memberId, actor_org_id: actor.org, capability, scope, scope_key: scopeFingerprint(scope), delegate_capabilities: options.delegates ?? [], status: "pending", revision: 1, valid_from, valid_to, operation_id, authority: "cli", approval_id: null, created_at: now, updated_at: now }, { session });
      await f.db.collection("organization_members").updateOne({ _id: actor.memberId }, { $inc: { authorization_revision: 1 } }, { session });
      await f.db.collection("users").updateOne({ _id: actor.user.user_id }, { $inc: { identity_revision: 1 } }, { session });
      return { grant_id: grantId };
    },
    verify: async ({ session, operation_id }) => {
      const published = await f.db.collection("administrative_grants").updateOne({ _id: grantId, operation_id, status: "pending" }, { $set: { status: options.status ?? "active" } }, { session });
      if (published.modifiedCount !== 1) throw new Error("Fixture grant publication failed");
    },
  });
  return f.db.collection("administrative_grants").findOne({ _id: grantId });
}
async function administrationFixture(t, topology = "replicaSet", options = {}) {
  const f = await fixture(t, { topology, ...options, env: { FILE_SCAN_ENABLED: "false", ...options.env } });
  f.platform = (await f.ops.createOrganization(f.context, { name: "IAM 平台合成组织", kind: "platform" })).organization_id;
  f.schoolA = (await f.ops.createOrganization(f.context, { name: "IAM 学校A", kind: "school" })).organization_id;
  f.schoolB = (await f.ops.createOrganization(f.context, { name: "IAM 学校B", kind: "school" })).organization_id;
  f.actor = async (org, roles) => {
    const browser = new Browser(f.browser.base), user = await f.authenticated(browser);
    const member = await f.ops.setMembership(f.context, { user_id: user.user_id, org_id: org, roles, ...(roles.includes("content_reviewer") ? { reviewer_valid_to: new Date(Date.now() + 3600000) } : {}) });
    return { browser, user, org, memberId: member.member_id };
  };
  f.governor = await f.actor(f.platform, ["platform_ops"]);
  f.approver = await f.actor(f.platform, ["platform_ops"]);
  f.accounts = await f.actor(f.platform, ["platform_ops"]);
  f.organizationAdmin = await f.actor(f.schoolA, ["org_admin"]);
  f.business = await f.actor(f.platform, ["platform_ops"]);
  f.studentA = await f.actor(f.schoolA, ["student"]);
  f.studentB = await f.actor(f.schoolB, ["student"]);
  await administrativeGrant(f, f.governor, "platform:govern");
  await administrativeGrant(f, f.approver, "platform:govern");
  await administrativeGrant(f, f.accounts, "account:platform-manage");
  await administrativeGrant(f, f.organizationAdmin, "account:manage");
  return f;
}
async function approvalRow(f, id) { return f.db.collection("authorization_requests").findOne({ _id: id }); }
async function grantRequest(f, actor, target, capability, orgIds, extras = {}) {
  const member = await f.db.collection("organization_members").findOne({ _id: target.memberId });
  return consoleRequest(actor, "/grants", { method: "POST", body: { subject_member_id: target.memberId, capability, scope: { kind: "organization_ids", organization_ids: orgIds }, valid_from: new Date(Date.now() - 1000).toISOString(), valid_to: new Date(Date.now() + 3600000).toISOString(), expected_revision: member.authorization_revision, reason: "IAM 合成数据授权验证", current_password: PASSWORD, ...extras } });
}
async function decide(f, actor, id, decision = "approve", extras = {}) {
  const row = await approvalRow(f, id);
  return consoleRequest(actor, `/approvals/${id}/decision`, { method: "POST", body: { decision, expected_revision: row.revision, reason: "独立核对精确范围", current_password: PASSWORD, ...extras } });
}
module.exports = { administrationFixture, administrativeGrant, consoleRequest, grantRequest, decide, approvalRow, PASSWORD, status };
