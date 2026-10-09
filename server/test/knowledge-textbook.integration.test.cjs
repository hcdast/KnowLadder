const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  assessmentFixture,
  good,
  request,
  grant,
} = require("./assessment-helpers.cjs");
const { status } = require("./helpers.cjs");
const { processKnowledgeOne } = require("../dist/training/knowledge-worker");
test(
  "教材知识库：真实内容发布事件、答案排除、许可到期及撤销清理",
  { timeout: 180000 },
  async (t) => {
    const f = await assessmentFixture(t, {
      env: { KL_TRAINING_ENABLED: "true", KL_KNOWLEDGE_ENABLED: "true" },
    });
    await grant(f, f.student, "ai:assist");
    await grant(f, f.editor, "ai:manage");
    await grant(f, f.editor, "ai:generate");
    const input = {
      query: "整数",
      scope: [{ kind: "chapter", id: f.chapterId }],
    };
    assert.equal(await processKnowledgeOne(f.db), true);
    assert.equal(await processKnowledgeOne(f.db), false);
    const found = await good(f.student, "/training/knowledge/search", {
      method: "POST",
      body: input,
    });
    assert.equal(found.citations.length, 1);
    assert.equal(found.citations[0].text, "原创整数正文");
    const rows = await f.db
      .collection("knowledge_sources")
      .find({ org_id: f.org })
      .toArray();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "chapter");
    assert.ok(!JSON.stringify(rows).includes("原创验收解析"));
    assert.ok(!JSON.stringify(rows).includes("question_version_id"));
    await f.db
      .collection("textbook_editions")
      .updateOne(
        { _id: f.book.id },
        {
          $set: {
            "license.expires_at": new Date(Date.now() - 1000).toISOString(),
          },
        },
      );
    status(
      await request(f.student, "/training/knowledge/search", {
        method: "POST",
        body: input,
      }),
      404,
    );
    await f.db
      .collection("textbook_editions")
      .updateOne({ _id: f.book.id }, { $set: { "license.expires_at": null } });
    assert.equal(
      (
        await good(f.student, "/training/knowledge/search", {
          method: "POST",
          body: input,
        })
      ).citations.length,
      1,
    );
    await grant(f, f.editor, "content:revoke");
    const current = await good(
      f.editor,
      `/admin/textbook-editions/${f.book.id}`,
    );
    await good(
      f.editor,
      `/admin/textbook-editions/${f.book.id}/revoke-access`,
      {
        method: "POST",
        body: {
          expected_access_revision: current.access_revision,
          reason: "原创教材授权撤销",
        },
      },
    );
    status(
      await request(f.student, "/training/knowledge/search", {
        method: "POST",
        body: input,
      }),
      404,
    );
    assert.equal(await processKnowledgeOne(f.db), true);
    assert.equal(
      await f.db
        .collection("knowledge_sources")
        .countDocuments({ org_id: f.org }),
      0,
    );
    // Management can request cleanup again without reading revoked original text.
    const accepted = await good(f.editor, "/training/knowledge/rebuild", {
      method: "POST",
      body: { source: input.scope[0] },
    });
    assert.equal(accepted.status, "pending");
    assert.equal(await processKnowledgeOne(f.db), true);
    assert.equal(
      await f.db
        .collection("knowledge_sources")
        .countDocuments({ org_id: f.org }),
      0,
    );
  },
);
