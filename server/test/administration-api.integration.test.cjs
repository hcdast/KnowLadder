const { newId } = require("../dist/database/object-id");
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { administrationFixture, administrativeGrant, consoleRequest, grantRequest, decide, PASSWORD, status } = require("./administration-helpers.cjs");
const { error } = require("./helpers.cjs");

for (const topology of ["replicaSet", "standalone"]) {
  test(`IAM ${topology}：管理范围、独立审批与密码交付安全`, { timeout: 480000, concurrency: false }, async t => {
    const f = await administrationFixture(t, topology);
    await t.test("账号平台全局、本组织范围与治理无业务权限", async () => {
      const global = await consoleRequest(f.accounts, "/users?limit=50");
      status(global, 200);
      assert.ok(global.data.data.items.some(user => user.id === f.studentA.user.user_id));
      assert.ok(global.data.data.items.some(user => user.id === f.studentB.user.user_id));
      const local = await consoleRequest(f.organizationAdmin, "/users?limit=50");
      status(local, 200);
      assert.ok(local.data.data.items.some(user => user.id === f.studentA.user.user_id));
      assert.equal(local.data.data.items.some(user => user.id === f.studentB.user.user_id), false);
      error(await consoleRequest(f.organizationAdmin, `/organizations/${f.schoolB}/members`), 404);
      error(await consoleRequest(f.governor, "/users"), 403);
      error(await consoleRequest(f.governor, "/business/content/admin/textbook-editions", { headers: { "X-Target-Org-Id": f.schoolA } }), 403);
    });
    await t.test("普通账号创建单次密码；原key重放不新建、不回显", async () => {
      const key = randomUUID(), login_name = `iam_${randomUUID().replaceAll("-", "")}`;
      const options = { method: "POST", key, body: { login_name, display_name: "IAM 新建普通账号", org_id: f.schoolA, roles: ["student"], reason: "单次密码隔离验收", current_password: PASSWORD } };
      const first = await consoleRequest(f.accounts, "/users", options);
      status(first, 200);
      assert.equal(typeof first.data.data.temporary_password, "string");
      const id = first.data.data.user_id;
      const replay = await consoleRequest(f.accounts, "/users", options);
      status(replay, 200);
      assert.equal(replay.data.data.temporary_password, undefined);
      assert.equal(await f.db.collection("users").countDocuments({ login_key: login_name }), 1);
      const op = await f.db.collection("administration_operations").findOne({ _id: first.data.data.operation_id });
      assert.equal(JSON.stringify(op).includes(first.data.data.temporary_password), false);
      assert.equal((await f.db.collection("users").findOne({ _id: id })).must_change_password, true);
    });
    await t.test("角色派生审核权走202；批准前无账号，独立批准后才生效", async () => {
      const login_name = `review_${randomUUID().replaceAll("-", "")}`;
      const valid_to = new Date(Date.now() + 3600000).toISOString();
      const response = await consoleRequest(f.accounts, "/users", { method: "POST", body: { login_name, display_name: "IAM 独立内容审核", org_id: f.schoolA, roles: ["content_reviewer"], valid_to, reason: "审核角色敏感审批", current_password: PASSWORD } });
      status(response, 202);
      assert.equal(await f.db.collection("users").countDocuments({ login_key: login_name }), 0);
      const approvalId = response.data.data.approval_id;
      const applied = await decide(f, f.approver, approvalId);
      status(applied, 200);
      const target = await f.db.collection("users").findOne({ login_key: login_name });
      assert.ok(target);
      const member = await f.db.collection("organization_members").findOne({ user_id: target._id, org_id: f.schoolA });
      assert.equal(await f.db.collection("member_roles").countDocuments({ member_id: member._id, role_id: "content_reviewer" }), 1);
      const reviewerRole = await f.db.collection("member_roles").findOne({ member_id: member._id, role_id: "content_reviewer" });
      assert.equal(reviewerRole.valid_to.toISOString(), valid_to);
      assert.equal(reviewerRole.approval_id, approvalId);
      error(await consoleRequest(f.accounts, `/users/${target._id}/password-reset`, { method: "POST", body: { expected_identity_revision: target.identity_revision, reason: "敏感审核角色接管负例", current_password: PASSWORD } }), 403);
      assert.equal((await f.db.collection("users").findOne({ _id: target._id })).credential_version, target.credential_version);
    });
    await t.test("三方独立及能力组织元组不串权", async () => {
      const request = await grantRequest(f, f.governor, f.business, "content:edit", [f.schoolA]);
      status(request, 202);
      const approvalId = request.data.data.approval_id;
      error(await decide(f, f.governor, approvalId), 403);
      error(await decide(f, f.business, approvalId), 403);
      status(await decide(f, f.approver, approvalId), 200);
      await administrativeGrant(f, f.business, "report:read", [f.schoolB]);
      status(await consoleRequest(f.business, "/business/content/admin/textbook-editions", { headers: { "X-Target-Org-Id": f.schoolA } }), 200);
      error(await consoleRequest(f.business, "/business/content/admin/textbook-editions", { headers: { "X-Target-Org-Id": f.schoolB } }), 403);
      status(await consoleRequest(f.business, "/business/reports/options?resource=classes&limit=20", { headers: { "X-Target-Org-Id": f.schoolB } }), 200);
      error(await consoleRequest(f.business, "/business/reports/options?resource=classes&limit=20", { headers: { "X-Target-Org-Id": f.schoolA } }), 403);
      error(await f.business.browser.request("/admin/textbook-editions", { headers: { "X-Org-Id": f.platform, "X-Target-Org-Id": f.schoolA } }), 403);
      await f.ops.setMembership(f.context, { user_id: f.business.user.user_id, org_id: f.schoolA, roles: ["student"] });
      const identity = await f.business.browser.request("/me", { headers: { "X-Org-Id": f.schoolA } });
      status(identity, 200);
      assert.equal(identity.data.data.context.student_conflict, true);
      assert.equal(identity.data.data.context.capabilities.includes("content:edit"), false, "平台业务权不得注入普通组织上下文");
      const subject = newId(), now = new Date();
      await f.db.collection("subjects").insertOne({ _id: subject, code: `iam-${subject}`, name: "IAM 有效学科", created_at: now, updated_at: now });
      error(await f.business.browser.request(`/me/reports?subject_id=${subject}&period=30d`, { headers: { "X-Org-Id": f.schoolA } }), 403);
    });
    await t.test("all授权包含审批后的未来组织，停用目标立即失效", async () => {
      const request = await grantRequest(f, f.governor, f.business, "report:read", [], { scope: { kind: "all_organizations", organization_ids: [] } });
      status(request, 202);
      status(await decide(f, f.approver, request.data.data.approval_id), 200);
      const futureOrg = (await f.ops.createOrganization(f.context, { name: "IAM 授权后新学校", kind: "school" })).organization_id;
      status(await consoleRequest(f.business, "/business/reports/options?resource=classes&limit=20", { headers: { "X-Target-Org-Id": futureOrg } }), 200);
      await f.ops.setOrganizationStatus(f.context, { org_id: futureOrg, status: "disabled" });
      error(await consoleRequest(f.business, "/business/reports/options?resource=classes&limit=20", { headers: { "X-Target-Org-Id": futureOrg } }), 403);
    });
    await t.test("清理能力不能隐含题目答案或私有附件预览权", async () => {
      const cleaner = await f.actor(f.platform, ["student"]);
      await administrativeGrant(f, cleaner, "file:delete", [f.schoolA]);
      const options = { headers: { "X-Target-Org-Id": f.schoolA } };
      error(await consoleRequest(cleaner, "/business/content/admin/question-versions", options), 403);
      error(await consoleRequest(cleaner, `/business/content/admin/files/${newId()}/content`, options), 403);
      const organizationCleaner = await f.actor(f.schoolA, ["student"]);
      const member = await f.db.collection("organization_members").findOne({ _id: organizationCleaner.memberId });
      await f.ops.setCapability(f.context, { org_id: f.schoolA, member_id: member._id, capability: "file:delete", granted: true, expected_revision: member.authorization_revision, valid_to: new Date(Date.now() + 3600000) });
      error(await organizationCleaner.browser.request(`/admin/files/${newId()}/content`, { headers: { "X-Org-Id": f.schoolA } }), 403);
    });
    await t.test("未来业务授权身份不可被普通账号管理员重置接管", async () => {
      const future = await f.actor(f.platform, ["student"]);
      await administrativeGrant(f, future, "report:read", [f.schoolA], { validFrom: new Date(Date.now() + 60000), validTo: new Date(Date.now() + 3600000) });
      const user = await f.db.collection("users").findOne({ _id: future.user.user_id });
      error(await consoleRequest(f.accounts, `/users/${user._id}/password-reset`, { method: "POST", body: { expected_identity_revision: user.identity_revision, reason: "未来授权接管负例", current_password: PASSWORD } }), 403);
      assert.equal((await f.db.collection("users").findOne({ _id: user._id })).credential_version, user.credential_version);
    });
    await t.test("本组织敏感权限防接管，撤销后以新审批续授原元组", async () => {
      const target = await f.actor(f.schoolA, ["teacher"]);
      const first = await grantRequest(f, f.governor, target, "assessment:review", [f.schoolA]);
      status(first, 202);
      status(await decide(f, f.approver, first.data.data.approval_id), 200);
      const grants = f.db.collection("member_capability_grants");
      const granted = await grants.findOne({ member_id: target.memberId, capability: "assessment:review" });
      const user = await f.db.collection("users").findOne({ _id: target.user.user_id });
      error(await consoleRequest(f.accounts, `/users/${user._id}/password-reset`, { method: "POST", body: { expected_identity_revision: user.identity_revision, reason: "本组织敏感授权接管负例", current_password: PASSWORD } }), 403);
      assert.equal((await f.db.collection("users").findOne({ _id: user._id })).credential_version, user.credential_version);
      status(await consoleRequest(f.governor, `/grants/${granted._id}/revoke`, { method: "POST", body: { expected_revision: granted.revision, reason: "显式撤销后重新审批", current_password: PASSWORD } }), 200);
      assert.equal((await grants.findOne({ _id: granted._id })).status, "revoked");
      const renewed = await grantRequest(f, f.governor, target, "assessment:review", [f.schoolA]);
      status(renewed, 202);
      status(await decide(f, f.approver, renewed.data.data.approval_id), 200);
      assert.equal(await grants.countDocuments({ member_id: target.memberId, capability: "assessment:review" }), 1);
      assert.equal((await grants.findOne({ _id: granted._id })).status, "active");
      await target.browser.prepare();
      status(await target.browser.login(target.user.login_name, PASSWORD), 200);
      await target.browser.prepare();
      status(await target.browser.request("/admin/quizzes", { headers: { "X-Org-Id": f.schoolA } }), 200);
    });
    await t.test("原键申请遭独立拒绝后不得把操作回执误报为授权已生效", async () => {
      const member = await f.db.collection("organization_members").findOne({ _id: f.business.memberId });
      const key = randomUUID();
      const body = { subject_member_id: member._id, capability: "content:revoke",
        scope: { kind: "organization_ids", organization_ids: [f.schoolA] },
        valid_from: new Date(Date.now() - 1000).toISOString(),
        valid_to: new Date(Date.now() + 3600000).toISOString(),
        expected_revision: member.authorization_revision, reason: "原申请已拒绝不能显示生效",
        current_password: PASSWORD };
      const request = await consoleRequest(f.governor, "/grants", { method: "POST", body, key });
      status(request, 202);
      const approvalId = request.data.data.approval_id;
      const registration = await consoleRequest(f.governor, `/operations?key=${encodeURIComponent(key)}`);
      status(registration, 200);
      assert.equal(registration.data.data.items[0].status, "applied", "申请登记操作本身已完成");
      assert.equal(registration.data.data.items[0].approval_status, "pending", "回执须区分审批尚未发生");
      status(await decide(f, f.approver, approvalId, "reject"), 200);
      const replay = await consoleRequest(f.governor, "/grants", { method: "POST", body, key });
      status(replay, 200);
      assert.equal(replay.data.data.status, "rejected");
      assert.equal(replay.data.data.approval_id, approvalId);
      const outcome = await consoleRequest(f.governor, `/operations/${request.data.data.operation_id}`);
      status(outcome, 200);
      assert.equal(outcome.data.data.approval_status, "rejected");
      assert.equal(await f.db.collection("administrative_grants").countDocuments({ subject_member_id: member._id, capability: "content:revoke", status: "active" }), 0);
    });
    await t.test("本人扩权拒绝；申请人失权后旧审批不能应用", async () => {
      error(await grantRequest(f, f.governor, f.governor, "report:read", [f.schoolA]), 403);
      const request = await grantRequest(f, f.governor, f.business, "assessment:review", [f.schoolA]);
      status(request, 202);
      await f.db.collection("administrative_grants").updateOne({ subject_member_id: f.governor.memberId, capability: "platform:govern" }, { $set: { status: "revoked" } });
      const response = await decide(f, f.approver, request.data.data.approval_id);
      assert.ok([403, 409].includes(response.status), "申请人失权必须拒绝旧审批");
      assert.equal(await f.db.collection("administrative_grants").countDocuments({ subject_member_id: f.business.memberId, capability: "assessment:review", status: "active" }), 0);
    });
  });
}
