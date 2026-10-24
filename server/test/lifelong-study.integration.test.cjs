"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { setup } = require("./lifelong-fixture.cjs");
const { status } = require("./helpers.cjs");
const { LEARNING_COURSES } = require("../dist/lifelong/courses");
const input = (extra = {}) => ({
  title: "观察的证据与猜想",
  note: "先记录事实，再说明依据。.*",
  bookmarked: true,
  course_id: null,
  course_version: null,
  unit_id: null,
  due_on: "2026-10-15",
  ...extra,
});

test(
  "私人笔记：保存、收藏、文字搜索、日期筛选和分页游标隔离",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t),
      owner = await f.person(false),
      other = await f.person();
    const created = await f.good(owner, "/study-items", input());
    await f.good(
      owner,
      "/study-items",
      input({ title: "明天再看", due_on: "2026-10-16", bookmarked: false }),
    );
    await f.good(
      owner,
      "/study-items",
      input({ title: "未安排", due_on: null, bookmarked: false }),
    );
    const all = await f.good(owner, "/study-items?limit=1");
    assert.equal(all.items.length, 1);
    assert.ok(all.next_cursor);
    assert.equal(
      (
        await f.good(
          owner,
          `/study-items?limit=1&cursor=${encodeURIComponent(all.next_cursor)}`,
        )
      ).items.length,
      1,
    );
    status(
      await f.request(
        other,
        `/study-items?limit=1&cursor=${encodeURIComponent(all.next_cursor)}`,
      ),
      422,
    );
    status(
      await f.request(
        owner,
        `/study-items?limit=2&cursor=${encodeURIComponent(all.next_cursor)}`,
      ),
      422,
    );
    assert.equal(
      (await f.good(owner, "/study-items?filter=bookmarked")).items.length,
      1,
    );
    assert.equal(
      (await f.good(owner, "/study-items?filter=due&as_of=2026-10-15")).items[0]
        .id,
      created.resource_id,
    );
    assert.equal(
      (await f.good(owner, "/study-items?filter=due&as_of=2026-10-14")).items
        .length,
      0,
    );
    assert.equal(
      (await f.good(owner, "/study-items?q=" + encodeURIComponent(".*"))).items
        .length,
      3,
    );
    assert.equal(
      (await f.good(owner, "/study-items?q=missing")).items.length,
      0,
    );
    assert.equal((await f.good(other, "/study-items")).items.length, 0);
    for (const url of [
      "/study-items?filter=due",
      "/study-items?as_of=2026-02-30",
      "/study-items?org_id=anything",
    ])
      status(await f.request(owner, url), 422);
    for (const body of [
      input({ due_on: "2026-02-30" }),
      input({ bookmarked: "true" }),
      input({ course_id: "unknown" }),
      input({ user_id: other.id }),
    ])
      status(await f.request(owner, "/study-items", body), 422);
    const document = await (
      await fetch(f.browser.base + "/api/openapi.json")
    ).json();
    assert.ok(document.paths["/api/v1/personal/study-items/{id}/review"]);
  },
);

test(
  "课程笔记与复习：原单元绑定、回顾及下次安排独立于课程完成",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t),
      owner = await f.person(),
      course = LEARNING_COURSES[0],
      unit = course.units[0];
    await f.good(owner, `/courses/${course.id}/enroll`, {
      version: course.version,
    });
    const base = await f.good(owner, `/courses/${course.id}`);
    const payload = input({
      course_id: course.id,
      course_version: course.version,
      unit_id: unit.id,
    });
    const key = randomUUID(),
      created = await f.good(owner, "/study-items", payload, key);
    assert.deepEqual(
      await f.good(owner, "/study-items", payload, key),
      created,
    );
    assert.equal(
      (await f.good(owner, "/study-items")).items[0].source_available,
      true,
    );
    const review = {
      answer: unit.answer,
      revision: 1,
      reviewed_on: "2026-10-15",
      next_due_on: "2026-10-18",
      note: "能区分故事中事实与自己的猜想，还需再次复述。",
    };
    status(
      await f.request(owner, `/study-items/${created.resource_id}/review`, {
        ...review,
        answer: (unit.answer + 1) % 3,
      }),
      422,
    );
    const reviewKey = randomUUID(),
      result = await f.good(
        owner,
        `/study-items/${created.resource_id}/review`,
        review,
        reviewKey,
      );
    assert.deepEqual(
      await f.good(
        owner,
        `/study-items/${created.resource_id}/review`,
        review,
        reviewKey,
      ),
      result,
    );
    assert.equal(
      (await f.good(owner, `/operations/${reviewKey}`)).resource_id,
      created.resource_id,
    );
    const row = (await f.good(owner, "/study-items")).items[0];
    assert.equal(row.review_count, 1);
    assert.equal(row.reviewed_on, "2026-10-15");
    assert.equal(row.due_on, "2026-10-18");
    assert.equal(
      (await f.good(owner, "/study-items?filter=due&as_of=2026-10-15")).items
        .length,
      0,
    );
    assert.deepEqual(
      (await f.good(owner, `/courses/${course.id}`)).learning,
      base.learning,
    );
    assert.equal((await f.good(owner, "/activities")).items.length, 0);
    status(
      await f.request(owner, `/study-items/${row.id}/review`, review),
      409,
    );
    status(
      await f.request(owner, `/study-items/${row.id}/review`, {
        ...review,
        revision: 2,
        next_due_on: "2026-10-15",
      }),
      422,
    );
    status(
      await f.request(owner, `/study-items/${row.id}/review`, {
        ...review,
        revision: 2,
      }),
      409,
    );
    await f.good(owner, `/study-items/${row.id}/review`, {
      ...review,
      revision: 2,
      reviewed_on: "2026-10-18",
      next_due_on: null,
    });
    assert.equal(
      (await f.good(owner, "/study-items")).items[0].review_count,
      2,
    );
    status(
      await f.request(owner, "/study-items", {
        ...payload,
        course_version: 999,
      }),
      409,
    );
    // Simulate a previously valid version withdrawn after saving, without exposing any old course body.
    await f.db
      .collection("lifelong_study_items")
      .updateOne(
        { _id: row.id },
        { $set: { course_version: 999, due_on: "2026-10-18" } },
      );
    const stale = (await f.good(owner, "/study-items")).items[0];
    assert.equal(stale.source_available, false);
    assert.equal(stale.source_title, null);
    status(
      await f.request(owner, `/study-items/${row.id}/review`, {
        ...review,
        revision: 3,
        reviewed_on: "2026-10-18",
        next_due_on: null,
      }),
      409,
    );
    await f.good(
      owner,
      `/study-items/${row.id}`,
      { ...input(), revision: 3 },
      randomUUID(),
      "PATCH",
    );
    assert.equal(
      (await f.good(owner, "/study-items")).items[0].source_available,
      true,
    );
  },
);

test(
  "笔记写入边界：当前所有权、修订冲突、取消晚到和移除",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t),
      owner = await f.person(),
      other = await f.person();
    const created = await f.good(owner, "/study-items", input()),
      path = `/study-items/${created.resource_id}`;
    for (const [suffix, body, method] of [
      ["", { ...input(), revision: 1 }, "PATCH"],
      [
        "/review",
        {
          answer: null,
          revision: 1,
          reviewed_on: "2026-10-15",
          next_due_on: null,
          note: "复习",
        },
        "POST",
      ],
      ["/remove", { revision: 1 }, "POST"],
    ])
      status(
        await f.request(other, path + suffix, body, randomUUID(), method),
        404,
      );
    const key = randomUUID();
    await f.good(owner, `/operations/${key}/cancel`, {});
    status(await f.request(owner, "/study-items", input(), key), 409);
    await f.good(
      owner,
      path,
      { ...input({ title: "修改后的重点" }), revision: 1 },
      randomUUID(),
      "PATCH",
    );
    status(
      await f.request(
        owner,
        path,
        { ...input(), revision: 1 },
        randomUUID(),
        "PATCH",
      ),
      409,
    );
    const removeKey = randomUUID();
    const removed = await f.good(
      owner,
      path + "/remove",
      { revision: 2 },
      removeKey,
    );
    assert.deepEqual(
      await f.good(owner, path + "/remove", { revision: 2 }, removeKey),
      removed,
    );
    assert.equal((await f.good(owner, "/study-items")).items.length, 0);
    const tombstone = await f.db
      .collection("lifelong_study_items")
      .findOne({ _id: created.resource_id });
    assert.equal(tombstone.note, "");
    assert.equal(tombstone.due_on, null);
    status(
      await f.request(
        owner,
        path,
        { ...input(), revision: 3 },
        randomUUID(),
        "PATCH",
      ),
      404,
    );
  },
);

test(
  "笔记迁移：v23不改校验和、v24重复执行与严格schema漂移拒绝",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t);
    const {
      migrateLifelong,
      assertLifelongCollections,
    } = require("../dist/migrations/lifelong-v23");
    const {
      STUDY_CHECKSUM,
      STUDY_SCHEMAS,
    } = require("../dist/lifelong/study-schema");
    const { OBJECT_ID_CHECKSUM } = require("../dist/migrations/schema");
    const before = await f.db
      .collection("schema_migrations")
      .findOne({ version: 23 });
    const definition = {
      version: 24,
      checksum: STUDY_CHECKSUM,
      schemas: STUDY_SCHEMAS,
    };
    await migrateLifelong(f.db, OBJECT_ID_CHECKSUM, definition);
    assert.deepEqual(
      await f.db.collection("schema_migrations").findOne({ version: 23 }),
      before,
    );
    await assert.rejects(() =>
      f.db
        .collection("lifelong_study_items")
        .insertOne({
          _id: require("../dist/database/object-id").newId(),
          unexpected: true,
        }),
    );
    await f.db.collection("lifelong_study_items").dropIndex("study_due");
    await assert.rejects(
      () => assertLifelongCollections(f.db, STUDY_SCHEMAS),
      /LIFELONG_INDEX_MISMATCH/,
    );
    await assert.rejects(
      () => migrateLifelong(f.db, OBJECT_ID_CHECKSUM, definition),
      /LIFELONG_INDEX_MISMATCH/,
    );
  },
);
