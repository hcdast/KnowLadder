const { test } = require("node:test");
const { fork } = require("node:child_process");
const { once } = require("node:events");
function childEvent(child, event) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(Error("child timeout:" + event));
    }, 30000);
    function cleanup() {
      clearTimeout(timeout);
      child.off("message", receive);
      child.off("exit", exit);
    }
    function receive(m) {
      if (m.event === event) {
        cleanup();
        resolve(m);
      } else if (m.event === "failed") {
        cleanup();
        reject(Error("child worker failed"));
      }
    }
    function exit() {
      cleanup();
      reject(Error("child exited before " + event));
    }
    child.on("message", receive);
    child.on("exit", exit);
  });
}

const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const {
  setup,
  createBook,
  detail,
  chapter,
  good,
  setupCourseworkLedger,
  courseworkPrivateChild,
  memberGrant,
} = require("./revision107-pdf-helpers.cjs");
const { status } = require("./helpers.cjs");
const { newId } = require("../dist/database/object-id");
const { Database } = require("../dist/database/database");
const { AuthService } = require("../dist/auth.service");
const { ContentAccess } = require("../dist/content/access");
const { processImportOne } = require("../dist/training/import-worker");
const {
  systemBackupRegistry,
  assertSchema,
} = require("../dist/migrations/schema");
const { DOCX_MIME } = require("../dist/training/import-document");

test(
  "v18停写迁移、备份注册、真实HTTP导入/领取/应用/幂等及旧来源拒绝",
  { timeout: 180000 },
  async (t) => {
    const env = await setupCourseworkLedger(t),
      root = await courseworkPrivateChild(env, "files");
    const f = await setup(t, {
      env: {
        ...env,
        KL_TRAINING_ENABLED: "true",
        KL_KNOWLEDGE_ENABLED: "true",
        KL_KNOWLEDGE_IMPORT_ENABLED: "false",
        FILE_SCAN_ENABLED: "true",
        FILE_STORAGE_ROOT: root,
      },
    });
    const old = await f.db
      .collection("schema_migrations")
      .findOne({ version: 10 });
    process.env.KL_KNOWLEDGE_IMPORT_ENABLED = "true";
    await assert.rejects(f.migrate(f.uri), /stopped writers/);
    assert.equal(
      await f.db.collection("schema_migrations").findOne({ version: 18 }),
      null,
    );
    await Promise.all(f.apps.map((a) => a.close()));
    await f.migrate(f.uri);
    await f.migrate(f.uri);
    await assertSchema(f.db);
    assert.equal(
      (await f.db.collection("schema_migrations").findOne({ version: 10 }))
        .checksum,
      old.checksum,
    );
    assert.equal(systemBackupRegistry().version, 19);
    assert.ok(
      systemBackupRegistry().collections.includes("knowledge_import_jobs"),
    );
    const restarted = await f.start();
    f.browser = f.browser.clone(restarted.browser.base);
    f.reviewer.browser = f.reviewer.browser.clone(restarted.browser.base);
    f.editor.browser = f.editor.browser.clone(restarted.browser.base);
    f.student.browser = f.student.browser.clone(restarted.browser.base);
    const api = await (
      await fetch(restarted.browser.base + "/api/openapi.json")
    ).json();
    assert.ok(api.components.schemas.ImportApply);
    assert.ok(
      api.paths[
        "/api/v1/admin/textbook-editions/{ownerId}/imports/{jobId}/apply"
      ],
    );
    await writeFile(
      join(
        __dirname,
        "../../ops/artifacts/training-validation/revision145-import-openapi.json",
      ),
      JSON.stringify(api, null, 2),
    );
    const book = await createBook(f),
      base = `/admin/textbook-editions/${book.id}/imports`;
    const zip = new (require("jszip"))();
    zip.file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    zip.file(
      "_rels/.rels",
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    );
    zip.file(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>原创隔离导入整数材料</w:t></w:r></w:p></w:body></w:document>',
    );
    const bytes = await zip.generateAsync({ type: "nodebuffer" }),
      checksum = createHash("sha256").update(bytes).digest("hex"),
      fileId = newId(),
      storageKey = randomUUID(),
      now = new Date();
    await require("../dist/files/config").storageRoot();
    await writeFile(join(root, "ready", storageKey), bytes);
    // Explicit controlled scanned-state fixture; this is NOT an actual ClamAV acceptance.
    await f.db.collection("file_resources").insertOne({
      _id: fileId,
      org_id: f.org,
      owner_type: "textbook",
      owner_version_id: book.id,
      created_by: f.editor.user.user_id,
      display_name: "原创隔离.docx",
      storage_key: storageKey,
      declared_size: bytes.length,
      declared_mime: DOCX_MIME,
      declared_checksum: checksum,
      size: bytes.length,
      mime: DOCX_MIME,
      checksum,
      status: "ready",
      scan_status: "clean",
      scan_attempt: 1,
      lease_token: null,
      lease_until: null,
      available_at: now,
      uploaded_at: now,
      error_code: null,
      created_at: now,
      updated_at: now,
      retention_until: null,
      legal_hold: false,
      deletion_requested_at: null,
      deletion_requested_by: null,
      deletion_requested_reason: null,
      deleted_at: null,
      deletion_lease_token: null,
      deletion_lease_until: null,
      deletion_attempt: 0,
      upload_key: null,
      upload_lease_token: null,
      upload_lease_until: null,
      upload_storage_key: null,
      upload_storage_keys: [],
      upload_owner_revision: null,
      upload_result_revision: null,
      scan_engine_version: "fixture",
      scan_database_version: "fixture",
      scan_database_updated_at: now,
      scanned_at: now,
    });
    const input = { file_id: fileId, expected_revision: book.revision },
      key = randomUUID();
    const job = await good(f.editor, base, {
      method: "POST",
      key,
      body: input,
    });
    assert.equal(job.status, "queued");
    assert.equal(job.preview, undefined);
    assert.deepEqual(
      await good(f.editor, base, { method: "POST", key, body: input }),
      job,
    );
    const app = restarted.app,
      args = [app.get(Database), app.get(AuthService), app.get(ContentAccess)];
    assert.equal(
      (
        await Promise.all([
          processImportOne(...args),
          processImportOne(...args),
        ])
      ).filter(Boolean).length,
      1,
    );
    const preview = await good(f.editor, `${base}/${job.id}`);
    assert.equal(preview.status, "preview-ready");
    assert.equal(preview.preview[0].text, "原创隔离导入整数材料");
    assert.equal(
      await f.db
        .collection("knowledge_sources")
        .countDocuments({ owner_id: book.id }),
      0,
    );
    status(
      await f.student.browser.request(`${base}/${job.id}`, {
        headers: { "X-Org-Id": f.org },
      }),
      404,
    );
    const body = {
        job_revision: preview.revision,
        expected_revision: book.revision,
        chapters: [chapter(f, { body: preview.preview[0].text })],
        license: { source: "原创合成导入", granted: true, expires_at: null },
        rights_type: "original",
        proof_reference: "隔离测试原创声明",
        usage_restrictions: "",
      },
      applyKey = randomUUID();
    status(
      await f.editor.browser.request(`${base}/${job.id}/apply`, {
        method: "POST",
        body: {
          ...body,
          chapters: [chapter(f, { knowledge_point_ids: [newId()] })],
        },
        headers: { "X-Org-Id": f.org, "Idempotency-Key": randomUUID() },
      }),
      422,
    );
    assert.equal((await detail(f, book.id)).revision, book.revision);
    assert.equal(
      (await good(f.editor, `${base}/${job.id}`)).status,
      "preview-ready",
    );
    const applied = await good(f.editor, `${base}/${job.id}/apply`, {
      method: "POST",
      key: applyKey,
      body,
    });
    assert.equal(applied.status, "applied");
    assert.deepEqual(
      await good(f.editor, `${base}/${job.id}/apply`, {
        method: "POST",
        key: applyKey,
        body,
      }),
      applied,
    );
    const owner = await detail(f, book.id);
    assert.equal(owner.status, "draft");
    assert.equal(owner.revision, book.revision + 1);
    assert.equal(
      await f.db
        .collection("chapters")
        .countDocuments({ textbook_edition_id: book.id }),
      1,
    );
    const receipt = await good(f.editor, base + "/requests/" + applyKey);
    assert.equal(receipt.status, "resolved");
    assert.equal(receipt.result.id, job.id);
    assert.deepEqual(Object.keys(receipt.result).sort(), [
      "id",
      "revision",
      "status",
    ]);
    assert.equal(
      (await good(f.editor, base + "/requests/" + randomUUID())).status,
      "unknown",
    );
    status(
      await f.student.browser.request(base + "/requests/" + applyKey, {
        headers: { "X-Org-Id": f.org },
      }),
      403,
    );
    const provenance = await good(f.editor, base + "/provenance");
    assert.equal(provenance.items.length, 1);
    assert.equal(provenance.items[0].proof_reference, "隔离测试原创声明");
    assert.equal(provenance.items[0].applied_revision, owner.revision);
    status(
      await f.student.browser.request(base + "/provenance", {
        headers: { "X-Org-Id": f.org },
      }),
      403,
    );
    const cleaner = await f.actor(["teacher"]);
    const cleanerMember = await f.db
      .collection("organization_members")
      .findOne({ user_id: cleaner.user.user_id, org_id: f.org });
    await memberGrant(f, cleanerMember._id, "file:delete");
    status(
      await cleaner.browser.request(base + "/provenance", {
        headers: { "X-Org-Id": f.org },
      }),
      403,
    );
    const reviewed = await good(f.reviewer, base + "/provenance");
    assert.equal(reviewed.items.length, 1);
    const stored = await f.db
      .collection("knowledge_import_jobs")
      .findOne({ _id: job.id });
    assert.deepEqual(stored.preview, []);
    assert.equal(stored.chapter_ids.length, 1);
    const cancelled = await good(f.editor, base, {
      method: "POST",
      body: { file_id: fileId, expected_revision: owner.revision },
    });
    await good(f.editor, `${base}/${cancelled.id}/cancel`, {
      method: "POST",
      body: { job_revision: cancelled.revision },
    });
    assert.equal(await processImportOne(...args), false);
    const expired = await good(f.editor, base, {
      method: "POST",
      body: { file_id: fileId, expected_revision: owner.revision },
    });
    await processImportOne(...args);
    await f.db
      .collection("knowledge_import_jobs")
      .updateOne(
        { _id: expired.id },
        { $set: { expires_at: new Date(Date.now() - 1000) } },
      );
    assert.equal(await processImportOne(...args), false);
    const cleared = await f.db
      .collection("knowledge_import_jobs")
      .findOne({ _id: expired.id });
    assert.equal(cleared.error_code, "IMPORT_PREVIEW_EXPIRED");
    assert.deepEqual(cleared.preview, []);
    assert.equal(cleared.lease_token, null);
    await processImportOne(...args);
    assert.equal(
      (
        await f.db
          .collection("knowledge_import_jobs")
          .findOne({ _id: expired.id })
      ).revision,
      cleared.revision,
    );
    const interrupted = await good(f.editor, base, {
      method: "POST",
      body: { file_id: fileId, expected_revision: owner.revision },
    });
    const heldToken = randomUUID();
    await f.db.collection("knowledge_import_jobs").updateOne(
      { _id: interrupted.id },
      {
        $set: {
          status: "running",
          lease_token: heldToken,
          lease_until: new Date(Date.now() + 60000),
        },
      },
    );
    assert.equal(await processImportOne(...args), false);
    assert.equal(
      (
        await f.db
          .collection("knowledge_import_jobs")
          .findOne({ _id: interrupted.id })
      ).lease_token,
      heldToken,
    );
    await f.db
      .collection("knowledge_import_jobs")
      .updateOne(
        { _id: interrupted.id },
        { $set: { lease_until: new Date(Date.now() - 1000) } },
      );
    assert.equal(
      (
        await Promise.all([
          processImportOne(...args),
          processImportOne(...args),
        ])
      ).filter(Boolean).length,
      1,
    );
    const resumed = await f.db
      .collection("knowledge_import_jobs")
      .findOne({ _id: interrupted.id });
    assert.equal(resumed.status, "preview-ready");
    assert.equal(resumed.lease_token, null);
    const killed = await good(f.editor, base, {
      method: "POST",
      body: { file_id: fileId, expected_revision: owner.revision },
    });
    const child = fork(join(__dirname, "import-worker-child.cjs"), [], {
      env: { ...process.env },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    await childEvent(child, "parsing");
    const running = await f.db
      .collection("knowledge_import_jobs")
      .findOne({ _id: killed.id });
    assert.equal(running.status, "running");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    assert.match(f.db.databaseName, /^kl_test_/);
    // Dispose only this fixture registration after observing that exact child exit.
    const deadWriter = await f.db
      .collection("operational_writers")
      .findOne({ pid: child.pid, state: "running" });
    assert.ok(deadWriter);
    await f.db.collection("operational_writers").updateOne(
      {
        _id: deadWriter._id,
        pid: child.pid,
        token: deadWriter.token,
        state: "running",
      },
      {
        $set: {
          state: "stopped",
          stopped_at: new Date(),
          heartbeat_at: new Date(),
        },
      },
    );
    assert.equal(
      await processImportOne(...args),
      false,
      "进程退出后仍须等待租约过期，不能立即抢占",
    );
    await f.db
      .collection("knowledge_import_jobs")
      .updateOne(
        { _id: killed.id },
        { $set: { lease_until: new Date(Date.now() - 1000) } },
      );
    assert.equal(await processImportOne(...args), true);
    assert.equal(
      (
        await f.db
          .collection("knowledge_import_jobs")
          .findOne({ _id: killed.id })
      ).status,
      "preview-ready",
    );
    const next = await good(f.editor, base, {
      method: "POST",
      body: { file_id: fileId, expected_revision: owner.revision },
    });
    await good(f.editor, `/admin/textbook-editions/${book.id}`, {
      method: "PATCH",
      body: { expected_revision: owner.revision, title: "变更后的草稿" },
    });
    await processImportOne(...args);
    const failed = await f.db
      .collection("knowledge_import_jobs")
      .findOne({ _id: next.id });
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.preview, []);
    status(
      await f.editor.browser.request(`${base}/${next.id}`, {
        headers: { "X-Org-Id": f.org },
      }),
      409,
    );
    const changed = await detail(f, book.id),
      revoked = await good(f.editor, base, {
        method: "POST",
        body: { file_id: fileId, expected_revision: changed.revision },
      });
    const crossing = fork(join(__dirname, "import-worker-child.cjs"), [], {
      env: { ...process.env },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    t.after(() => {
      if (crossing.exitCode === null) crossing.kill("SIGKILL");
    });
    await childEvent(crossing, "parsing");
    const leaseBefore = await f.db
      .collection("knowledge_import_jobs")
      .findOne({ _id: revoked.id });
    await require("node:timers/promises").setTimeout(11500);
    const leaseAfter = await f.db
      .collection("knowledge_import_jobs")
      .findOne({ _id: revoked.id });
    assert.ok(
      leaseAfter.lease_until > leaseBefore.lease_until,
      "真实执行进程慢解析时续期",
    );
    const member = await f.db
      .collection("organization_members")
      .findOne({ user_id: f.editor.user.user_id, org_id: f.org });
    await f.ops.setMembership(f.context, {
      user_id: f.editor.user.user_id,
      org_id: f.org,
      roles: ["student"],
      expected_revision: member.authorization_revision,
    });
    const finished = childEvent(crossing, "finished");
    crossing.send("resume");
    await finished;
    if (crossing.exitCode === null) await once(crossing, "exit");

    assert.equal(
      (
        await f.db
          .collection("knowledge_import_jobs")
          .findOne({ _id: revoked.id })
      ).status,
      "failed",
    );
    status(
      await f.editor.browser.request(`${base}/${revoked.id}`, {
        headers: { "X-Org-Id": f.org },
      }),
      403,
    );
    await Promise.all(f.apps.map((app) => app.close()));
    const before18 = await f.db
      .collection("schema_migrations")
      .findOne({ version: 18 });
    assert.match(f.db.databaseName, /^kl_test_/);
    await f.db.collection("knowledge_import_provenance").drop();
    await f.db.collection("schema_migrations").deleteOne({ version: 19 });
    const previousJson = stored.license_json;
    await f.db
      .collection("knowledge_import_jobs")
      .updateOne({ _id: job.id }, { $set: { license_json: "{}" } });
    await assert.rejects(f.migrate(f.uri));
    assert.equal(
      (await f.db.collection("schema_migrations").findOne({ version: 19 }))
        .status,
      "failed",
    );
    await f.db
      .collection("knowledge_import_jobs")
      .updateOne({ _id: job.id }, { $set: { license_json: previousJson } });
    await f.migrate(f.uri);
    const retained = await f.db
      .collection("knowledge_import_provenance")
      .findOne({ _id: job.id });
    assert.equal(retained.license_json, previousJson);
    assert.ok(!("user_id" in retained));
    assert.ok(!("member_id" in retained));
    assert.ok(!("preview" in retained));
    assert.equal(
      (await f.db.collection("schema_migrations").findOne({ version: 18 }))
        .checksum,
      before18.checksum,
    );
  },
);
