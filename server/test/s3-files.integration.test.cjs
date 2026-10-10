"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { Readable, PassThrough } = require("node:stream"),
  { EventEmitter } = require("node:events");
const { fixture } = require("./helpers.cjs"),
  { setup, protect } = require("./fixtures/s3-setup.cjs");
const storage = require("../dist/files/storage"),
  { receive } = require("../dist/files/stream"),
  { FilesService } = require("../dist/files/files.service");
const { bootstrapOperations } = require("../dist/operations/control"),
  { newId } = require("../dist/database/object-id");
const backup = require("../../ops/private-files-backup.cjs"),
  transfer = require("../../ops/s3-transfer.cjs");
function response() {
  const res = new PassThrough();
  res.headers = {};
  res.statusCode = 200;
  res.setHeader = (k, v) => (res.headers[k] = v);
  res.status = (x) => {
    res.statusCode = x;
    return res;
  };
  res.chunks = [];
  res.on("data", (x) => res.chunks.push(x));
  return res;
}
function request(range) {
  const req = new EventEmitter();
  req.get = (x) => (x === "Range" ? range : undefined);
  req.requestId = crypto.randomUUID();
  return req;
}
test(
  "S3文件业务：真实事务授权、上传、加密备份及承接",
  { concurrency: false, timeout: 180000 },
  async (t) => {
    const f = await fixture(t, { migrated: false, app: false });
    await bootstrapOperations(f.db);
    const remote = await setup(t);
    const bytes = Buffer.from("原创S3文件验收材料，禁止真实个人数据。\n"),
      checksum = storage.bytesChecksum(bytes),
      key = crypto.randomUUID();
    const row = {
      _id: newId(),
      org_id: newId(),
      storage_key: key,
      size: bytes.length,
      checksum,
      mime: "text/plain",
      display_name: "原创.txt",
      status: "ready",
      scan_status: "clean",
      deleted_at: null,
      deletion_requested_at: null,
      upload_storage_keys: [],
    };
    await f.db.collection("file_resources").insertOne(row);
    await t.test(
      "上传验证后才写入隔离对象，失败与中断均清理spool",
      async () => {
        const uploaded = crypto.randomUUID();
        assert.equal(
          (
            await receive(
              Readable.from(bytes),
              {
                declared_size: bytes.length,
                declared_mime: "text/plain",
                declared_checksum: checksum,
              },
              uploaded,
            )
          ).checksum,
          checksum,
        );
        assert.deepEqual(
          await storage.readStorageBytes("quarantine", uploaded),
          bytes,
        );
        const rejected = crypto.randomUUID();
        await assert.rejects(
          receive(
            Readable.from(bytes),
            {
              declared_size: bytes.length,
              declared_mime: "text/plain",
              declared_checksum: "0".repeat(64),
            },
            rejected,
          ),
          (e) => e.getStatus() === 422,
        );
        assert.equal(await storage.storageHead("quarantine", rejected), null);
        const interrupted = crypto.randomUUID();
        const stream = new Readable({
          read() {
            this.destroy(Error("synthetic disconnect"));
          },
        });
        await assert.rejects(
          receive(
            stream,
            {
              declared_size: bytes.length,
              declared_mime: "text/plain",
              declared_checksum: checksum,
            },
            interrupted,
          ),
        );
        assert.equal(
          await storage.storageHead("quarantine", interrupted),
          null,
        );
        assert.deepEqual(await fs.readdir(path.join(remote.root, "tmp")), []);
        await storage.deleteStorageObject("quarantine", uploaded);
      },
    );
    await storage.putStorageBytes("ready", key, bytes);
    const service = new FilesService({}, { db: f.db });
    function authorize({ revoked = false } = {}) {
      let phase = 0;
      return async (prepare) => {
        phase++;
        const session = f.client.startSession();
        try {
          return await session.withTransaction(async () => {
            const live = await f.db
              .collection("file_resources")
              .findOne({ _id: row._id }, { session });
            if (revoked && phase === 2) throw Error("synthetic revoked");
            await f.db
              .collection("delivery_audit")
              .insertOne({ _id: newId(), phase }, { session });
            await prepare(live);
            return live;
          });
        } finally {
          await session.endSession();
        }
      };
    }
    await t.test(
      "真实事务初检回滚，远程完整性校验后再次授权，Range与审计一次",
      async () => {
        const res = response();
        await service.deliverAuthorized(request("bytes=2-8"), res, authorize());
        assert.equal(res.statusCode, 206);
        assert.deepEqual(Buffer.concat(res.chunks), bytes.subarray(2, 9));
        assert.equal(res.headers["Cache-Control"], "private, no-store");
        assert.equal(
          await f.db.collection("delivery_audit").countDocuments(),
          1,
        );
        assert.equal(
          (await f.db.collection("delivery_audit").findOne()).phase,
          2,
        );
        assert.deepEqual(await fs.readdir(path.join(remote.root, "tmp")), []);
      },
    );
    await t.test("远程取回后撤权或校验失败不交付、不提交授权审计", async () => {
      const before = await f.db.collection("delivery_audit").countDocuments(),
        res = response();
      await assert.rejects(
        service.deliverAuthorized(request(), res, authorize({ revoked: true })),
        /synthetic revoked/,
      );
      assert.equal(res.chunks.length, 0);
      assert.equal(
        await f.db.collection("delivery_audit").countDocuments(),
        before,
      );
      remote.modes.corrupt = true;
      try {
        await assert.rejects(
          service.deliverAuthorized(request(), response(), authorize()),
          (e) => e.getStatus() === 503,
        );
      } finally {
        remote.modes.corrupt = false;
      }
      assert.equal(
        await f.db.collection("delivery_audit").countDocuments(),
        before,
      );
      assert.deepEqual(await fs.readdir(path.join(remote.root, "tmp")), []);
    });
    await t.test(
      "S3内容进入原加密归档，验签后仅恢复到离线本地目录",
      async () => {
        const archive = path.join(remote.root, "original.enc"),
          secret = crypto.randomBytes(32);
        const result = await backup.backup({
          db: f.db,
          root: remote.root,
          file: archive,
          key: secret,
        });
        assert.equal(result.file_count, 1);
        const inspected = await backup.inspect({ file: archive, key: secret });
        assert.equal(inspected.file_count, 1);
        const target = path.join(remote.root, "restore");
        await fs.mkdir(target, { mode: 0o700 });
        await protect(target);
        const staged = await backup.stage({
          file: archive,
          key: secret,
          target,
          storageRoot: path.join(remote.root, "ready"),
        });
        assert.equal(staged.file_count, 1);
        assert.deepEqual(
          await fs.readFile(path.join(target, "ready", key)),
          bytes,
        );
        assert.deepEqual(await fs.readdir(path.join(remote.root, "tmp")), []);
      },
    );

    await t.test("S3上传PDF/DOCX、真实子进程提取及私有spool回收", async () => {
      const { pdf, docx } = require("./fixtures/import-documents.cjs"),
        { DOCX_FILE_MIME, openPrivate } = require("../dist/files/config"),
        {
          extractInProcess,
        } = require("../dist/training/import-parser-process");
      const flags = [
          "KL_TRAINING_ENABLED",
          "KL_KNOWLEDGE_ENABLED",
          "KL_KNOWLEDGE_IMPORT_ENABLED",
        ],
        saved = Object.fromEntries(flags.map((k) => [k, process.env[k]]));
      for (const k of flags) process.env[k] = "true";
      try {
        for (const [data, mime] of [
          [pdf(), "application/pdf"],
          [await docx(), DOCX_FILE_MIME],
        ]) {
          const key = crypto.randomUUID(),
            hash = storage.bytesChecksum(data);
          await receive(
            Readable.from(data),
            {
              declared_size: data.length,
              declared_mime: mime,
              declared_checksum: hash,
            },
            key,
          );
          await storage.publishStorageFile("quarantine", "ready", key, {
            size: data.length,
            checksum: hash,
          });
          const handle = await openPrivate("ready", key);
          try {
            const text = await extractInProcess(await handle.readFile(), mime);
            assert.ok(text.segments.length > 0);
          } finally {
            await handle.close();
          }
          for (const area of storage.STORAGE_AREAS)
            await storage.deleteStorageObject(area, key);
        }
        assert.deepEqual(await fs.readdir(path.join(remote.root, "tmp")), []);
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
    await t.test(
      "S3隐私擦除使用真实独立账本，spool与403阻断，全部key物理确认后墓碑",
      async (t) => {
        const scope = await fixture(t, { migrated: false, app: false });
        const control = require("../dist/operations/control"),
          ledger = require("../dist/operations/ledger"),
          {
            eraseCourseworkFileBytes,
          } = require("../dist/privacy/coursework-files");
        await control.bootstrapOperations(scope.db);
        const primary = path.join(remote.root, "ledger-primary"),
          mirror = path.join(remote.root, "ledger-mirror");
        for (const dir of [primary, mirror]) {
          await fs.mkdir(dir, { mode: 0o700 });
          await protect(dir);
        }
        const environment = crypto.randomUUID(),
          controlUri = scope.uri.replace(
            /(mongodb(?:\+srv)?:\/\/[^/]+\/)[^?]+/,
            "$1kl_control_s3_" + environment.replaceAll("-", ""),
          );
        Object.assign(process.env, {
          KL_ENVIRONMENT_ID: environment,
          KL_CONTROL_MONGODB_URI: controlUri,
          KL_SAFETY_LEDGER_ROOT: primary,
          KL_SAFETY_LEDGER_MIRROR_ROOT: mirror,
          KL_SAFETY_LEDGER_KEY: crypto.randomBytes(32).toString("hex"),
          KL_COURSEWORK_FILES_ENABLED: "true",
          KL_TRAINING_ENABLED: "true",
        });
        const controlClient = new (require("mongodb").MongoClient)(controlUri);
        await controlClient.connect();
        t.after(async () => {
          await controlClient.db().dropDatabase();
          await controlClient.close();
        });
        await control.registerEnvironment(scope.client, scope.db, {
          environmentId: environment,
          fileRoot: null,
          actor: "s3-privacy-test",
          reason: "原创隔离材料",
        });
        const user = newId(),
          privacyRequest = newId(),
          head = newId(),
          file = newId(),
          org = newId(),
          keys = [crypto.randomUUID(), crypto.randomUUID()],
          now = new Date();
        await scope.db
          .collection("users")
          .insertOne({ _id: user, privacy_state: "erasing" });
        await scope.db
          .collection("coursework_heads")
          .insertOne({ _id: head, org_id: org, user_id: user, revision: 1 });
        const intent = await ledger.reserveSafetyIntent(scope.db, {
          operationId: crypto.randomUUID(),
          action: "subject.erase",
          subjectId: user,
          privacyRequestId: privacyRequest,
          privacyPolicyRevision: "local_privacy_v1",
          privacyRetentionBasis: "local_minimal_provenance",
        });
        await scope.db.collection("privacy_tombstones").insertOne({
          _id: newId(),
          user_id: user,
          request_id: privacyRequest,
          ledger_sequence: intent.sequence,
          state: "erasing",
        });
        await ledger.confirmSafetyIntent(scope.db, intent);
        await scope.db.collection("file_resources").insertOne({
          _id: file,
          org_id: org,
          owner_type: "coursework",
          owner_version_id: head,
          created_by: user,
          storage_key: keys[0],
          upload_storage_key: null,
          upload_storage_keys: [keys[1]],
          legal_hold: false,
          retention_until: new Date(0),
          status: "quarantined",
          scan_status: "queued",
          upload_lease_until: null,
          lease_until: null,
          deletion_lease_until: null,
          deleted_at: null,
          updated_at: now,
        });
        for (const area of storage.STORAGE_AREAS)
          for (const key of keys)
            await storage.putStorageBytes(area, key, bytes);
        const residual = path.join(remote.root, "tmp", crypto.randomUUID());
        await fs.writeFile(residual, bytes, { mode: 0o600 });
        await assert.rejects(
          eraseCourseworkFileBytes(scope.db, user, privacyRequest),
          /PRIVACY_SPOOL_CLEANUP_REQUIRED/,
        );
        await fs.unlink(residual);
        remote.modes.deny = true;
        try {
          await assert.rejects(
            eraseCourseworkFileBytes(scope.db, user, privacyRequest),
            /S3_ACCESS_DENIED/,
          );
        } finally {
          remote.modes.deny = false;
        }
        assert.equal(
          (await scope.db.collection("file_resources").findOne({ _id: file }))
            .deleted_at,
          null,
        );
        for (const area of storage.STORAGE_AREAS)
          for (const key of keys)
            assert.ok(await storage.storageHead(area, key));
        await scope.db
          .collection("file_resources")
          .updateOne(
            { _id: file },
            { $set: { deletion_lease_until: new Date(0) } },
          );
        await eraseCourseworkFileBytes(scope.db, user, privacyRequest);
        const erased = await scope.db
          .collection("file_resources")
          .findOne({ _id: file });
        assert.ok(erased.deleted_at instanceof Date);
        assert.equal(erased.display_name, "[erased]");
        for (const area of storage.STORAGE_AREAS)
          for (const key of keys)
            assert.equal(await storage.storageHead(area, key), null);
        await eraseCourseworkFileBytes(scope.db, user, privacyRequest);
      },
    );
    await t.test(
      "local→S3承接受停写门禁保护，可重放且保留源、拒绝计划变化",
      async (t) => {
        await storage.deleteStorageObject("ready", key);
        await assert.rejects(
          transfer.inspect(f.db, remote.root),
          /STORAGE_TRANSFER_SPOOL_COLLISION/,
        );
        const source = await fs.mkdtemp(
          path.join(require("node:os").homedir(), "kl-s3-source-"),
        );
        await protect(source);
        for (const area of storage.STORAGE_AREAS)
          await fs.mkdir(path.join(source, area), { mode: 0o700 });
        t.after(async () => {
          assert.ok(
            path
              .resolve(source)
              .startsWith(
                path.join(require("node:os").homedir(), "kl-s3-source-"),
              ),
          );
          await fs.rm(source, { recursive: true, force: true });
        });

        // Persistent source is a separate private directory from transient spool.
        await fs.writeFile(path.join(source, "ready", key), bytes, {
          mode: 0o600,
        });
        const inspected = await transfer.inspect(f.db, source);
        assert.equal(inspected.plan.inventory.missing.length, 0);
        await assert.rejects(
          transfer.copy(f.db, {
            sourceRoot: source,
            manifest: path.join(remote.root, "transfer.json"),
            expectedHash: inspected.hash,
            allHostsStopped: false,
          }),
          /OPERATIONS_ALL_HOSTS_STOP_REQUIRED/,
        );
        const env = crypto.randomUUID(),
          token = crypto.randomUUID();
        process.env.KL_ENVIRONMENT_ID = env;
        process.env.KL_MAINTENANCE_TOKEN = token;
        await f.db.collection("operational_state").updateOne(
          { _id: "environment" },
          {
            $set: {
              mode: "maintenance",
              environment_id: env,
              maintenance_token: token,
              owner: "synthetic-s3-test",
            },
          },
        );
        const input = {
          sourceRoot: source,
          manifest: path.join(remote.root, "transfer.json"),
          expectedHash: inspected.hash,
          allHostsStopped: true,
        };
        const copied = await transfer.copy(f.db, input);
        assert.equal(copied.files, 1);
        assert.equal(copied.source_preserved, true);
        assert.equal(copied.driver_switched, false);
        assert.equal((await transfer.copy(f.db, input)).files, 1);
        assert.deepEqual(
          await fs.readFile(path.join(source, "ready", key)),
          bytes,
        );
        await assert.rejects(
          transfer.copy(f.db, { ...input, expectedHash: "0".repeat(64) }),
          /STORAGE_TRANSFER_PLAN_CHANGED/,
        );
      },
    );
  },
);
