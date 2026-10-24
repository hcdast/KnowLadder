"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { fixture, Browser, status } = require("./helpers.cjs");
const { newId, rawDatabase } = require("../dist/database/object-id");
const { setup } = require("./lifelong-fixture.cjs");
test(
  "终身学习：取消收据与晚到请求串行，未知结果不会重复创建；默认关闭不影响身份",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t),
      owner = await f.person(),
      stranger = await f.person();
    const key = randomUUID();
    assert.equal(
      (await f.good(owner, `/operations/${key}/cancel`, {})).state,
      "cancelled",
    );
    status(await f.request(owner, "/goals", f.goal(), key), 409);
    assert.equal((await f.good(owner, "/goals")).items.length, 0);
    status(await f.request(stranger, `/operations/${key}`), 404);
    for (let i = 0; i < 3; i++) {
      const raceKey = randomUUID();
      const [write, cancellation] = await Promise.all([
        f.request(owner, "/goals", f.goal(`竞态${i}`), raceKey),
        f.request(owner, `/operations/${raceKey}/cancel`, {}),
      ]);
      status(cancellation, 200);
      assert.ok([200, 409].includes(write.status));
      assert.equal(
        cancellation.data.data.state,
        write.status === 200 ? "applied" : "cancelled",
      );
      const receipt = await f.good(owner, `/operations/${raceKey}`);
      assert.equal(receipt.state, cancellation.data.data.state);
    }
    process.env.KL_LIFELONG_ENABLED = "false";
    assert.equal((await f.good(owner, "/capabilities")).enabled, false);
    status(await f.request(owner, "/goals"), 503);
    status(await owner.browser.request("/me"), 200);
    process.env.KL_LIFELONG_ENABLED = "true";
  },
);
test(
  "终身学习：零组织本人目标、活动、版本、幂等、分页、删除与数据隔离",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t),
      learner = await f.person(false),
      stranger = await f.person();
    assert.equal(
      (await learner.browser.request("/me")).data.data.organizations.length,
      0,
    );
    const cap = await f.good(learner, "/capabilities");
    assert.equal(cap.templates.length, 6);
    const key = randomUUID(),
      goalBody = f.goal();
    const goal = await f.good(learner, "/goals", goalBody, key);
    assert.deepEqual(await f.good(learner, "/goals", goalBody, key), goal);
    status(await f.request(learner, "/goals", f.goal("另一个目标"), key), 409);
    assert.equal(
      (await f.good(learner, `/operations/${key}`)).state,
      "applied",
    );
    status(await f.request(stranger, `/operations/${key}`), 404);
    assert.equal((await f.good(stranger, "/goals")).items.length, 0);
    const activity = await f.good(
      learner,
      "/activities",
      f.activity(goal.resource_id),
    );
    status(
      await f.request(stranger, "/activities", f.activity(goal.resource_id)),
      404,
    );
    const row = (await f.good(learner, "/activities")).items[0];
    assert.equal(row.evidence, "self_reported");
    status(
      await f.request(
        stranger,
        `/activities/${activity.resource_id}`,
        { ...f.activity(null), revision: 1 },
        randomUUID(),
        "PATCH",
      ),
      404,
    );
    const update = await f.good(
      learner,
      `/goals/${goal.resource_id}`,
      { ...goalBody, state: "completed", revision: 1 },
      randomUUID(),
      "PATCH",
    );
    assert.equal(update.revision, 2);
    status(
      await f.request(
        learner,
        `/goals/${goal.resource_id}`,
        { ...goalBody, revision: 1 },
        randomUUID(),
        "PATCH",
      ),
      409,
    );
    await f.good(learner, "/goals", f.goal("第二个目标"));
    const page = await f.good(learner, "/goals?limit=1");
    assert.ok(page.next_cursor);
    assert.equal(
      (
        await f.good(
          learner,
          `/goals?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`,
        )
      ).items.length,
      1,
    );
    status(
      await f.request(
        stranger,
        `/goals?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`,
      ),
      422,
    );
    status(
      await f.request(learner, "/activities", {
        ...f.activity(null),
        occurred_on: "2026-02-30",
      }),
      422,
    );
    status(
      await f.request(learner, "/goals", { ...goalBody, user_id: stranger.id }),
      422,
    );
    status(
      await learner.browser.request("/personal/goals", {
        method: "POST",
        body: goalBody,
        csrf: "wrong",
      }),
      403,
    );
    status(await new Browser(f.browser.base).request("/personal/goals"), 401);
    await f.good(learner, `/goals/${goal.resource_id}/remove`, { revision: 2 });
    assert.equal((await f.good(learner, "/activities")).items[0].goal_id, null);
    assert.equal((await f.good(learner, "/goals")).items.length, 1);
    await f.good(learner, `/activities/${activity.resource_id}/remove`, {
      revision: 2,
    });
    assert.equal((await f.good(learner, "/activities")).items.length, 0);
    assert.equal(
      await rawDatabase(f.db)
        .collection("lifelong_goals")
        .countDocuments({ user_id: { $type: "objectId" } }),
      2,
    );
    const url = new URL("/api/openapi.json", f.browser.base).href,
      spec = await (await fetch(url)).json();
    assert.ok(spec.paths["/api/v1/personal/goals"].post.requestBody);
    assert.ok(!spec.paths["/api/v1/personal/{kind}"]);
    if (process.env.GENERATE_LIFELONG_API === "true") {
      const child = spawn(process.execPath, ["scripts/generate-api.mjs"], {
        cwd: path.resolve(__dirname, "../../web"),
        windowsHide: true,
        stdio: "inherit",
        env: { ...process.env, OPENAPI_URL: url },
      });
      assert.equal(
        await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", resolve);
        }),
        0,
      );
    }
  },
);
test(
  "终身学习：成年本人邀请只读指定记录，反馈、撤回、过期与重放均受当前授权约束",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t),
      owner = await f.person(),
      supporter = await f.person(),
      stranger = await f.person(),
      noAdmission = await f.person(false);
    const goal = await f.good(owner, "/goals", f.goal()),
      activity = await f.good(
        owner,
        "/activities",
        f.activity(goal.resource_id),
      );
    await f.good(owner, "/activities", {
      ...f.activity(null),
      title: "不分享的活动",
    });
    const input = {
      label: "共同学习伙伴",
      scopes: ["activities", "feedback"],
      goal_ids: [],
      activity_ids: [activity.resource_id],
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      assurance_id: null,
    };
    status(await f.request(noAdmission, "/supports", input), 403);
    const created = await f.good(owner, "/supports", input);
    assert.equal(created.invitation_code.length, 43);
    const preview = await f.good(supporter, "/support-invitation/preview", {
      code: created.invitation_code,
    });
    assert.equal(preview.selected_activity_count, 1);
    assert.equal(preview.note, undefined);
    status(
      await f.request(stranger, `/supports/${created.resource_id}/records`),
      404,
    );
    const acceptKey = randomUUID(),
      code = { code: created.invitation_code };
    await f.good(supporter, "/support-invitation/accept", code, acceptKey);
    await f.good(supporter, "/support-invitation/accept", code, acceptKey);
    status(await f.request(stranger, "/support-invitation/accept", code), 404);
    let shared = await f.good(
      supporter,
      `/supports/${created.resource_id}/records`,
    );
    assert.equal(shared.activities.length, 1);
    assert.equal(shared.activities[0].goal_id, null);
    assert.equal(shared.goals.length, 0);
    const feedbackKey = randomUUID(),
      feedback = {
        activity_id: activity.resource_id,
        note: "你的观察写得具体，可以继续比较。",
      };
    await f.good(
      supporter,
      `/supports/${created.resource_id}/feedback`,
      feedback,
      feedbackKey,
    );
    assert.equal(
      (await f.good(owner, "/feedback")).items[0].evidence,
      "supporter_feedback",
    );
    const relation = (await f.good(owner, "/supports")).items[0];
    await f.good(owner, `/supports/${relation.id}/revoke`, {
      revision: relation.revision,
    });
    status(await f.request(supporter, `/supports/${relation.id}/records`), 404);
    status(
      await f.request(
        supporter,
        `/supports/${relation.id}/feedback`,
        feedback,
        feedbackKey,
      ),
      404,
    );
    status(
      await f.request(supporter, "/support-invitation/accept", code, acceptKey),
      404,
    );
    const expired = await f.good(owner, "/supports", input);
    await f.db
      .collection("lifelong_supports")
      .updateOne(
        { _id: expired.resource_id },
        { $set: { invite_expires_at: new Date(0) } },
      );
    status(
      await f.request(supporter, "/support-invitation/preview", {
        code: expired.invitation_code,
      }),
      404,
    );
    assert.equal(
      JSON.stringify(await f.good(owner, "/supports")).includes("token_hash"),
      false,
    );
  },
);
test(
  "终身学习：监护独立审核、非当事人/跨组织隔离、明确记录与成年转段撤权",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t),
      learner = await f.person(false),
      guardian = await f.person(),
      proposer = await f.person(),
      reviewer = await f.person(),
      stranger = await f.person();
    const org = (
      await f.ops.createOrganization(f.context, {
        name: "原创全龄隔离试点",
        kind: "school",
      })
    ).organization_id;
    for (const [person, roles] of [
      [learner, ["student"]],
      [guardian, ["student"]],
      [proposer, ["org_admin"]],
      [reviewer, ["org_admin"]],
    ])
      await f.ops.setMembership(f.context, {
        user_id: person.id,
        org_id: org,
        roles,
      });
    const future = new Date(Date.now() + 86400000).toISOString();
    const input = {
      org_id: org,
      user_id: learner.id,
      guardian_user_id: guardian.id,
      evidence_reference: "isolated-simulated-proof-001",
      policy_version: "isolated-trial-v1-not-real-identity-proof",
      transition_at: future,
      expires_at: future,
    };
    status(await f.request(guardian, "/assurances", input), 403);
    const proposed = await f.good(proposer, "/assurances", input),
      decision = { revision: 1, decision: "approved" };
    status(
      await f.request(
        proposer,
        `/assurances/${proposed.resource_id}/review`,
        decision,
      ),
      403,
    );
    status(await f.request(stranger, `/institutions/${org}/assurances`), 403);
    await f.good(
      reviewer,
      `/assurances/${proposed.resource_id}/review`,
      decision,
    );
    const goal = await f.good(learner, "/goals", f.goal());
    const shared = await f.good(learner, "/supports", {
      label: "经机构核验的家庭学习支持",
      scopes: ["goals"],
      goal_ids: [goal.resource_id],
      activity_ids: [],
      expires_at: future,
      assurance_id: proposed.resource_id,
    });
    assert.equal(shared.invitation_code, null);
    assert.equal(
      (await f.good(guardian, `/supports/${shared.resource_id}/records`)).goals
        .length,
      1,
    );
    const guardianMember = await f.db
      .collection("organization_members")
      .findOne({ user_id: guardian.id, org_id: org });
    await f.ops.setMembership(f.context, {
      user_id: guardian.id,
      org_id: org,
      roles: [],
      status: "disabled",
      expected_revision: guardianMember.authorization_revision,
    });
    status(
      await f.request(guardian, `/supports/${shared.resource_id}/records`),
      404,
    );
    const disabledMember = await f.db
      .collection("organization_members")
      .findOne({ user_id: guardian.id, org_id: org });
    await f.ops.setMembership(f.context, {
      user_id: guardian.id,
      org_id: org,
      roles: ["student"],
      status: "active",
      expected_revision: disabledMember.authorization_revision,
    });
    assert.equal(
      (await f.good(guardian, `/supports/${shared.resource_id}/records`)).goals
        .length,
      1,
    );
    await f.db
      .collection("lifelong_assurances")
      .updateOne(
        { _id: proposed.resource_id },
        { $set: { transition_at: new Date(0) } },
      );
    status(
      await f.request(guardian, `/supports/${shared.resource_id}/records`),
      404,
    );
    assert.equal((await f.good(learner, "/goals")).items.length, 1);
    const before = await f.db
      .collection("lifelong_goals")
      .countDocuments({ user_id: learner.id });
    const member = await f.db
      .collection("organization_members")
      .findOne({ user_id: learner.id, org_id: org });
    await f.ops.setMembership(f.context, {
      user_id: learner.id,
      org_id: org,
      roles: [],
      status: "disabled",
      expected_revision: member.authorization_revision,
    });
    assert.equal((await f.good(learner, "/goals")).items.length, before);
  },
);
