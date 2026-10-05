"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { administrationFixture, consoleRequest, PASSWORD, status } = require("./administration-helpers.cjs");

for (const topology of ["replicaSet", "standalone"]) {
  test(`IAM ${topology}：并发原key申请仅登记一次且两回执都不冒称已批准`, { timeout: 240000 }, async t => {
    const f = await administrationFixture(t, topology);
    const member = await f.db.collection("organization_members").findOne({ _id: f.business.memberId });
    const key = randomUUID();
    const body = { subject_member_id: member._id, capability: "content:review",
      scope: { kind: "organization_ids", organization_ids: [f.schoolA] },
      valid_from: new Date(Date.now() - 1000).toISOString(), valid_to: new Date(Date.now() + 3600000).toISOString(),
      expected_revision: member.authorization_revision, reason: "真实并发原键独立审批", current_password: PASSWORD };
    const { Collection } = require("mongoose").mongo;
    const original = Collection.prototype.findOne;
    const secondReady = Promise.withResolvers();
    const firstRelease = Promise.withResolvers(), secondRelease = Promise.withResolvers();
    let entered = 0;
    Collection.prototype.findOne = async function (...args) {
      const row = await original.apply(this, args);
      if (this.namespace === `${f.db.databaseName}.administration_operations` && row === null &&
          args[0]?.key === key && args[0]?.actor_id === f.governor.user.user_id &&
          args[0]?.action === "approval.request.grant.create" && entered < 2) {
        entered++;
        if (entered === 1) await firstRelease.promise;
        else { secondReady.resolve(); await secondRelease.promise; }
      }
      return row;
    };
    try {
      const send = () => consoleRequest(f.governor, "/grants", { method: "POST", body, key });
      const requests = [send(), send()];
      // Both reads must finish against real Mongo before either inserts intent.
      const timer = setTimeout(() => secondReady.reject(new Error("并发请求未同时进入真实原键查验")), 15000);
      try { await secondReady.promise; } finally { clearTimeout(timer); }
      firstRelease.resolve();
      const first = await Promise.race(requests);
      status(first, 202);
      secondRelease.resolve();
      const [a, b] = await Promise.all(requests);
      for (const response of [a, b]) {
        assert.ok(response.status === 200 || response.status === 202);
        assert.equal(response.data.data.status, "pending", "不能把仅登记的敏感申请冒称已应用");
        assert.equal(response.data.data.approval_id, first.data.data.approval_id);
      }
      assert.equal(await f.db.collection("authorization_requests").countDocuments({ _id: first.data.data.approval_id, status: "pending" }), 1);
      assert.equal(await f.db.collection("administration_operations").countDocuments({ actor_id: f.governor.user.user_id, action: "approval.request.grant.create", key }), 1);
      assert.equal(await f.db.collection("administrative_grants").countDocuments({ subject_member_id: member._id, capability: "content:review", status: "active" }), 0);
    } finally { firstRelease.resolve(); secondRelease.resolve(); Collection.prototype.findOne = original; }
  });
}
