"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { setup } = require("./lifelong-fixture.cjs");
const { status } = require("./helpers.cjs");
const { LEARNING_COURSES, courseMarker } = require("../dist/lifelong/courses");
const response = (course, unit, learning) => ({
  version: course.version,
  goal_id: learning.goal_id,
  revision: learning.revision,
  answer: unit.answer,
  practice: "根据本课案例完成实践，并注明示例与实际观察的区别。",
  reflection: "结论需要对应证据；下一次进一步检查遗漏。",
});

test(
  "原创课程：六场景发现、筛选、详情、加入、顺序练习、刷新续学和完成",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t),
      person = await f.person(false);
    const list = await f.good(person, "/courses");
    assert.equal(list.items.length, 6);
    assert.equal(new Set(list.items.map((c) => c.stage)).size, 6);
    assert.ok(
      list.items.every(
        (c) => c.learning === null && c.unit_count === 3 && c.minutes > 0,
      ),
    );
    assert.equal(
      (await f.good(person, "/courses?stage=senior&field=digital")).items
        .length,
      1,
    );
    assert.equal(
      (await f.good(person, `/courses?q=${encodeURIComponent("交接")}`))
        .items[0].id,
      "work-improvement",
    );
    assert.equal((await f.good(person, "/courses?q=absent")).items.length, 0);
    status(await f.request(person, "/courses?stage=unknown"), 422);
    status(await f.request(person, "/courses?org_id=anything"), 422);
    status(await f.request(person, "/courses/missing"), 404);
    const course = LEARNING_COURSES[0],
      base = `/courses/${course.id}`;
    const detail = await f.good(person, base);
    assert.equal(detail.units.length, 3);
    assert.ok(
      detail.units.every(
        (u) => !Object.hasOwn(u, "answer") && u.paragraphs.length >= 2,
      ),
    );
    const key = randomUUID(),
      joined = await f.good(person, `${base}/enroll`, { version: 1 }, key);
    assert.deepEqual(
      await f.good(person, `${base}/enroll`, { version: 1 }, key),
      joined,
    );
    assert.equal(
      (await f.good(person, `${base}/enroll`, { version: 1 })).resource_id,
      joined.resource_id,
    );
    assert.equal(
      await f.db
        .collection("lifelong_goals")
        .countDocuments({
          user_id: person.id,
          template_id: courseMarker(course),
        }),
      1,
    );
    let learning = (await f.good(person, base)).learning;
    assert.equal(learning.next_unit_id, course.units[0].id);
    status(
      await f.request(
        person,
        `${base}/units/${course.units[1].id}/complete`,
        response(course, course.units[1], learning),
      ),
      409,
    );
    const incorrect = {
      ...response(course, course.units[0], learning),
      answer: (course.units[0].answer + 1) % 3,
    };
    const wrong = await f.request(
      person,
      `${base}/units/${course.units[0].id}/complete`,
      incorrect,
    );
    status(wrong, 422);
    assert.equal(wrong.data.error.code, "COURSE_PRACTICE_RETRY");
    assert.equal(
      (await f.good(person, base)).learning.completed_unit_ids.length,
      0,
    );
    for (const [index, unit] of course.units.entries()) {
      learning = (await f.good(person, base)).learning;
      const key = randomUUID(),
        payload = response(course, unit, learning);
      const result = await f.good(
        person,
        `${base}/units/${unit.id}/complete`,
        payload,
        key,
      );
      assert.deepEqual(
        await f.good(person, `${base}/units/${unit.id}/complete`, payload, key),
        result,
      );
      assert.equal(
        (await f.good(person, `/operations/${key}`)).resource_id,
        joined.resource_id,
      );
      assert.equal(
        (await f.good(person, base)).learning.completed_unit_ids.length,
        index + 1,
      );
    }
    learning = (await f.good(person, base)).learning;
    assert.equal(learning.state, "completed");
    assert.equal(learning.next_unit_id, null);
    const activities = (await f.good(person, "/activities")).items;
    assert.equal(activities.length, 3);
    assert.ok(
      activities.every(
        (a) => a.minutes === 0 && a.evidence === "self_reported",
      ),
    );
    // A fresh key on an already-completed unit is also harmless.
    await f.good(
      person,
      `${base}/units/${course.units[0].id}/complete`,
      response(course, course.units[0], learning),
    );
    assert.equal((await f.good(person, "/activities")).items.length, 3);
    assert.equal((await f.good(person, "/goals")).items[0].state, "completed");
  },
);

test(
  "原创课程：跨账号、陈旧修订、取消晚到、并发加入与隐私所有权边界",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t),
      owner = await f.person(),
      other = await f.person();
    const course = LEARNING_COURSES[1],
      base = `/courses/${course.id}`,
      unit = course.units[0];
    const joins = await Promise.all([
      f.request(owner, `${base}/enroll`, { version: 1 }),
      f.request(owner, `${base}/enroll`, { version: 1 }),
    ]);
    for (const joined of joins) status(joined, 200);
    assert.equal(
      joins[0].data.data.resource_id,
      joins[1].data.data.resource_id,
    );
    const learning = (await f.good(owner, base)).learning;
    assert.equal((await f.good(other, base)).learning, null);
    status(
      await f.request(
        other,
        `${base}/units/${unit.id}/complete`,
        response(course, unit, learning),
      ),
      404,
    );
    status(
      await f.request(owner, `${base}/units/${unit.id}/complete`, {
        ...response(course, unit, learning),
        reflection: "   ",
      }),
      422,
    );
    status(
      await f.request(owner, `${base}/units/${unit.id}/complete`, {
        ...response(course, unit, learning),
        revision: 50,
      }),
      409,
    );
    status(await f.request(owner, `${base}/enroll`, { version: 999 }), 409);
    status(
      await f.request(
        owner,
        `/goals/${learning.goal_id}`,
        { ...f.goal(), revision: learning.revision },
        randomUUID(),
        "PATCH",
      ),
      422,
    );
    status(
      await f.request(owner, "/goals", {
        ...f.goal(),
        template_id: courseMarker(course),
      }),
      422,
    );
    const key = randomUUID();
    await f.good(owner, `/operations/${key}/cancel`, {});
    const late = await f.request(
      owner,
      `${base}/units/${unit.id}/complete`,
      response(course, unit, learning),
      key,
    );
    status(late, 409);
    assert.equal(late.data.error.code, "OPERATION_CANCELLED");
    assert.equal((await f.good(owner, "/activities")).items.length, 0);
    const completed = await f.good(
      owner,
      `${base}/units/${unit.id}/complete`,
      response(course, unit, learning),
    );
    status(
      await f.request(other, `/goals/${learning.goal_id}/remove`, {
        revision: completed.revision,
      }),
      404,
    );
    await f.good(owner, `/goals/${learning.goal_id}/remove`, {
      revision: completed.revision,
    });
    assert.equal((await f.good(owner, base)).learning, null);
    const restarted = await f.good(owner, `${base}/enroll`, { version: 1 });
    assert.notEqual(restarted.resource_id, learning.goal_id);
    assert.deepEqual(
      (await f.good(owner, base)).learning.completed_unit_ids,
      [],
    );
    assert.ok(
      await f.db
        .collection("lifelong_receipts")
        .findOne({ user_id: owner.id, resource_id: learning.goal_id }),
    );
  },
);

test(
  "原创课程：六门课程均可完成全部单元，内容与实际存储校验一致",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t),
      person = await f.person();
    for (const course of LEARNING_COURSES) {
      const base = `/courses/${course.id}`;
      await f.good(person, `${base}/enroll`, { version: course.version });
      for (const unit of course.units) {
        const detail = await f.good(person, base);
        await f.good(
          person,
          `${base}/units/${unit.id}/complete`,
          response(course, unit, detail.learning),
        );
      }
      assert.equal((await f.good(person, base)).learning.state, "completed");
    }
    assert.equal(
      (await f.good(person, "/courses")).items.filter(
        (c) => c.learning.state === "completed",
      ).length,
      6,
    );
    assert.equal(
      await f.db
        .collection("lifelong_activities")
        .countDocuments({ user_id: person.id }),
      18,
    );
  },
);
