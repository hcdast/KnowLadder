const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  KnowledgeSourceService,
} = require("../dist/training/knowledge-source.service");
const id = "a".repeat(24),
  org = "b".repeat(24);
function fixture() {
  const calls = [];
  const course = {
    _id: id,
    revision: 3,
    status: "published",
    lessons: [
      {
        key: "intro",
        kind: "text",
        title: "原创课程",
        body: "授权培训正文",
        answer: "不可投影",
      },
      { key: "video", kind: "video" },
    ],
  };
  const chapter = {
    textbook_edition_id: id,
    title: "原创章节",
    body: "教材正文",
    answer: "不可投影",
  };
  const training = {
    col: () => ({
      findOne: async (filter) => {
        calls.push(filter);
        return chapter;
      },
    }),
    require: (ctx, cap) => {
      if (!ctx.capabilities.includes(cap)) throw Error("FORBIDDEN");
    },
    courseAccess: async (ctx, key, teacher) => {
      calls.push({ teacher, key });
      return course;
    },
  };
  const content = {
    access: {
      require: () => {},
      owner: async () => ({ _id: id, revision: 2 }),
    },
  };
  return {
    service: new KnowledgeSourceService(training, content),
    calls,
    course,
    content,
    ctx: { orgId: org, capabilities: ["learning:self"], session: {} },
  };
}
test("知识来源严格限制类型及字段", () => {
  const { service } = fixture();
  assert.deepEqual(service.parse({ kind: "chapter", id }), {
    kind: "chapter",
    id,
  });
  for (const input of [
    { kind: "answer", id },
    { kind: "chapter", id, lesson_key: "intro" },
    { kind: "chapter", id, body: "注入" },
  ])
    assert.throws(() => service.parse(input));
});
test("章节复用当前 owner 授权，组织查询及输出字段白名单", async () => {
  const f = fixture();
  const result = await f.service.read(f.ctx, { kind: "chapter", id });
  assert.deepEqual(f.calls[0], { _id: id, org_id: org });
  assert.equal(result.revision, 2);
  assert.equal(result.body, "教材正文");
  assert.equal(result.answer, undefined);
  f.content.access.owner = async () => {
    throw Error("REVOKED");
  };
  await assert.rejects(
    f.service.read(f.ctx, { kind: "chapter", id }),
    /REVOKED/,
  );
});
test("课程使用当前范围授权且拒绝草稿及非文本课时", async () => {
  const f = fixture(),
    source = { kind: "course-text", id, lesson_key: "intro" };
  assert.equal((await f.service.read(f.ctx, source)).revision, 3);
  assert.equal(f.calls[0].teacher, false);
  assert.equal(
    (await f.service.read({ ...f.ctx, capabilities: ["ai:generate"] }, source))
      .answer,
    undefined,
  );
  assert.equal(f.calls[1].teacher, true);
  await assert.rejects(
    f.service.read(f.ctx, { ...source, lesson_key: "video" }),
  );
  f.course.status = "draft";
  await assert.rejects(f.service.read(f.ctx, source));
  await assert.rejects(
    f.service.read({ ...f.ctx, capabilities: [] }, source),
    /FORBIDDEN/,
  );
});
test("原文 grounding 无匹配明确证据不足，撤权不返回部分结果", async () => {
  const f = fixture(),
    sources = [
      { kind: "chapter", id },
      { kind: "course-text", id, lesson_key: "intro" },
    ];
  const result = await f.service.ground(f.ctx, "培训", sources);
  assert.equal(result.status, "grounded");
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].text, "授权培训正文");
  assert.equal(
    (await f.service.ground(f.ctx, "biology", sources)).status,
    "insufficient-evidence",
  );
  await assert.rejects(
    f.service.ground(f.ctx, "培训", [sources[0], sources[0]]),
  );
  f.content.access.owner = async () => {
    throw Error("REVOKED");
  };
  await assert.rejects(f.service.ground(f.ctx, "培训", sources), /REVOKED/);
});
