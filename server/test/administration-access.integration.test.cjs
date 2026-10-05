"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fixture, status, error } = require("./helpers.cjs");

for (const topology of ["replicaSet", "standalone"]) {
  test(`IAM ${topology}：未生效、未来和过期组织授权不得通过 HTTP`, { timeout: 240000, concurrency: false }, async t => {
    const f = await fixture(t, { topology, env: { FILE_SCAN_ENABLED: "false" } });
    const org = (await f.ops.createOrganization(f.context, { name: "IAM 授权状态验收", kind: "school" })).organization_id;
    const user = await f.authenticated();
    const member = await f.ops.setMembership(f.context, { user_id: user.user_id, org_id: org, roles: ["teacher"] });
    await f.ops.setCapability(f.context, { org_id: org, member_id: member.member_id, capability: "assessment:manage", granted: true, expected_revision: member.authorization_revision, valid_to: new Date(Date.now() + 3600000) });
    const headers = { "X-Org-Id": org };
    const read = () => f.browser.request("/admin/quizzes", { headers });
    status(await read(), 200);
    const grants = f.db.collection("member_capability_grants");
    const grant = await grants.findOne({ member_id: member.member_id, capability: "assessment:manage" });
    assert.ok(grant);

    await t.test("pending 不赋权；恢复 active 后重新获权", async () => {
      await grants.updateOne({ _id: grant._id }, { $set: { status: "pending" } });
      error(await read(), 403);
      await grants.updateOne({ _id: grant._id }, { $set: { status: "active" } });
      status(await read(), 200);
    });
    await t.test("未来生效授权不能提前使用", async () => {
      const now = (await f.db.command({ hello: 1 })).localTime;
      await grants.updateOne({ _id: grant._id }, { $set: { valid_from: new Date(now.getTime() + 60000), valid_to: new Date(now.getTime() + 120000) } });
      error(await read(), 403);
      await grants.updateOne({ _id: grant._id }, { $set: { valid_from: grant.valid_from, valid_to: grant.valid_to } });
      status(await read(), 200);
    });
    await t.test("过期和撤销立即拒绝，角色不附带管理权", async () => {
      const now = (await f.db.command({ hello: 1 })).localTime;
      await grants.updateOne({ _id: grant._id }, { $set: { valid_from: new Date(now.getTime() - 120000), valid_to: new Date(now.getTime() - 60000) } });
      error(await read(), 403);
      await grants.updateOne({ _id: grant._id }, { $set: { valid_from: grant.valid_from, valid_to: grant.valid_to, status: "revoked" } });
      error(await read(), 403);
      const me = await f.browser.request("/me", { headers });
      status(me, 200);
      assert.equal(me.data.data.context.capabilities.includes("assessment:manage"), false);
    });
    await t.test("新审核角色有期派生能力，过期不能借基础角色继续读题", async () => {
      const current = await f.db.collection("organization_members").findOne({ _id: member.member_id });
      await f.ops.setMembership(f.context, { user_id: user.user_id, org_id: org, roles: ["teacher", "content_reviewer"], expected_revision: current.authorization_revision, reviewer_valid_to: new Date(Date.now() + 3600000) });
      status(await f.browser.request("/admin/question-versions", { headers }), 200);
      const now = (await f.db.command({ hello: 1 })).localTime;
      await f.db.collection("member_roles").updateOne({ member_id: member.member_id, role_id: "content_reviewer" }, { $set: { valid_from: new Date(now.getTime() - 120000), valid_to: new Date(now.getTime() - 60000) } });
      error(await f.browser.request("/admin/question-versions", { headers }), 403);
      const me = await f.browser.request("/me", { headers });
      status(me, 200);
      assert.equal(me.data.data.context.capabilities.includes("content:review"), false);
      assert.equal(me.data.data.context.capabilities.includes("teaching:class"), true);
    });
  });
}
