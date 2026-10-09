const { test } = require("node:test");
const assert = require("node:assert/strict");
const { assessmentFixture } = require("./assessment-helpers.cjs");
const {
  systemBackupRegistry,
  assertSchema,
} = require("../dist/migrations/schema");
const { processKnowledgeOne } = require("../dist/training/knowledge-worker");
test(
  "知识v17：v16停写升级、既有出版来源回填、重复迁移及备份注册",
  { timeout: 180000 },
  async (t) => {
    const f = await assessmentFixture(t, {
      env: {
        KL_TRAINING_ENABLED: "true",
        KL_KNOWLEDGE_ENABLED: "false",
        KL_TRAINING_REPORTS_ENABLED: "true",
        KL_TRAINING_PHASE2_ENABLED: "true",
        KL_AI_POLICY_ENABLED: "true",
        KL_AI_LEARNING_REPORTS_ENABLED: "true",
      },
    });
    const previous = await f.db
      .collection("schema_migrations")
      .findOne({ version: 10 });
    assert.equal(
      (await f.db.collection("schema_migrations").findOne({ version: 16 }))
        .status,
      "completed",
    );
    process.env.KL_KNOWLEDGE_ENABLED = "true";
    await assert.rejects(f.migrate(f.uri), /stopped writers/);
    assert.equal(
      await f.db.collection("schema_migrations").findOne({ version: 17 }),
      null,
    );
    await Promise.all(f.apps.map((app) => app.close()));
    await f.migrate(f.uri);
    await assertSchema(f.db);
    const event = await f.db
      .collection("knowledge_outbox")
      .findOne({ org_id: f.org, owner_id: f.book.id });
    assert.equal(event.status, "pending");
    assert.equal(event.generation, 1);
    assert.ok(!JSON.stringify(event).includes("原创整数正文"));
    assert.equal(await processKnowledgeOne(f.db), true);
    await f.migrate(f.uri);
    assert.equal(await processKnowledgeOne(f.db), false);
    assert.equal(
      (await f.db.collection("schema_migrations").findOne({ version: 10 }))
        .checksum,
      previous.checksum,
    );
    const registry = systemBackupRegistry();
    assert.equal(registry.version, 17);
    assert.ok(registry.collections.includes("knowledge_sources"));
    assert.ok(registry.collections.includes("knowledge_outbox"));
    assert.ok(registry.checksums["17"]);
    assert.ok(!registry.collections.includes("auth_sessions"));
  },
);
