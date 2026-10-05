"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fixture } = require("./helpers.cjs");
const { administrationFixture } = require("./administration-helpers.cjs");

for (const topology of ["replicaSet", "standalone"]) {
  test(`IAM ${topology}：未首次改密的初始化账号也占治理引导配额`, { timeout: 240000, concurrency: false }, async t => {
    const f = await fixture(t, { topology, app: false, env: { FILE_SCAN_ENABLED: "false" } });
    const org = (await f.ops.createOrganization(f.context, { name: "IAM CLI引导平台", kind: "platform" })).organization_id;
    const actors = [];
    for (let index = 0; index < 3; index++) {
      const user = await f.ops.createUser(f.context, { login_name: `boot_${randomUUID().replaceAll("-", "")}`, display_name: "IAM 未改密治理候选" });
      const member = await f.ops.setMembership(f.context, { user_id: user.user_id, org_id: org, roles: ["platform_ops"] });
      actors.push({ user, member });
    }
    for (const actor of actors.slice(0, 2)) await f.ops.bootstrapGovernance(f.context, { user_id: actor.user.user_id, org_id: org, expected_revision: actor.member.authorization_revision });
    assert.equal(await f.db.collection("users").countDocuments({ _id: { $in: actors.map(actor => actor.user.user_id) }, must_change_password: true }), 3);
    await assert.rejects(f.ops.bootstrapGovernance(f.context, { user_id: actors[2].user.user_id, org_id: org, expected_revision: actors[2].member.authorization_revision }));
    assert.equal(await f.db.collection("administrative_grants").countDocuments({ capability: "platform:govern", status: "active" }), 2);
    assert.equal(await f.db.collection("administrative_grants").countDocuments({ subject_member_id: actors[2].member.member_id }), 0);
  });
  test(`IAM ${topology}：必须改密的治理者不算可用，CLI不能停用最后可登录治理者`, { timeout: 300000, concurrency: false }, async t => {
    const f = await administrationFixture(t, topology);
    await f.ops.resetPassword(f.context, { user_id: f.approver.user.user_id });
    const reset = await f.db.collection("users").findOne({ _id: f.approver.user.user_id });
    assert.equal(reset.must_change_password, true);
    await assert.rejects(f.ops.setUserStatus(f.context, { user_id: f.governor.user.user_id, status: "disabled" }));
    assert.equal((await f.db.collection("users").findOne({ _id: f.governor.user.user_id })).status, "active");
    assert.equal((await f.db.collection("administrative_grants").findOne({ subject_member_id: f.governor.memberId, capability: "platform:govern" })).status, "active");
  });
}
