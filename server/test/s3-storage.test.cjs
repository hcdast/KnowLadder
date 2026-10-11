"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto");
const storage = require("../dist/files/storage"),
  config = require("../dist/files/config");
const { setup } = require("./fixtures/s3-setup.cjs");
test("S3 HTTPS/v4 protocol and storage lifecycle", async (t) => {
  const f = await setup(t),
    key = crypto.randomUUID(),
    bytes = Buffer.from("Original S3 teaching test\n"),
    checksum = storage.bytesChecksum(bytes);
  await t.test(
    "configuration rejects unsafe endpoint, prefix and style without values",
    () => {
      for (const change of [
        { S3_ENDPOINT: "http://insecure.invalid" },
        { S3_ENDPOINT: "https://user:secret@example.com" },
        { S3_PREFIX: "../other" },
        { S3_FORCE_PATH_STYLE: "false" },
        { S3_ACCESS_KEY_ID: "" },
      ])
        assert.throws(
          () => storage.s3Configuration({ ...process.env, ...change }),
          /^Error: INVALID_CONFIG_/,
        );
    },
  );
  await t.test(
    "Data Capsule client header is exact and limited to its endpoints",
    async () => {
      const sdk = require("@aws-sdk/client-s3"),
        https = require("node:https");
      for (const [endpoint, expected] of [
        ["https://s3.cstcloud.cn", "S3Drive"],
        ["https://s3.data.cstcloud.cn", "S3Drive"],
        ["https://s3.cstcloud.cn.attacker.invalid", null],
        [f.endpoint, null],
      ]) {
        const client = new sdk.S3Client({
          endpoint: f.endpoint,
          region: "us-east-1",
          credentials: { accessKeyId: f.access, secretAccessKey: f.secret },
          forcePathStyle: true,
          maxAttempts: 1,
          requestHandler: {
            httpsAgent: new https.Agent({ ca: await fs.readFile(f.ca) }),
          },
        });
        let observed;
        storage.applyS3ClientCompatibility(client, endpoint);
        client.middlewareStack.add(
          (next) => async (args) => {
            observed = args.request.headers["user-agent"];
            return next(args);
          },
          { step: "finalizeRequest", priority: "low", name: "observeHeader" },
        );
        try {
          await client.send(
            new sdk.HeadBucketCommand({ Bucket: "test-bucket" }),
          );
          if (expected) assert.equal(observed, expected);
          else assert.match(observed, /aws-sdk-js/);
        } finally {
          client.destroy();
        }
      }
    },
  );
  await t.test(
    "preflight is read-only and validates real TLS and SigV4",
    async () => {
      await storage.assertStorageBackendReady();
      assert.equal(f.objects.size, 0);
      assert.ok(
        f.requests.every((x) => x.method === "GET" || x.method === "HEAD"),
      );
    },
  );
  await t.test('complete preflight reuses one TLS connection and cancels pending request',async()=>{
    const start=f.requests.length,events=[],sdk=require('@aws-sdk/client-s3'),original=sdk.S3Client.prototype.destroy;let destroyed=0;
    sdk.S3Client.prototype.destroy=function(){destroyed++;return original.call(this);};
    try{await storage.assertStorageBackendReady({run:async(stage,work)=>{events.push(stage);return work();}});}finally{sdk.S3Client.prototype.destroy=original;}
    assert.equal(destroyed,1);
    const requests=f.requests.slice(start);
    assert.equal(requests.length,6);assert.ok(new Set(requests.map(r=>r.remotePort)).size<=2,'six commands share at most two TLS connections');
    assert.deepEqual(events,['storage.local','storage.bucket','storage.versioning','storage.lock','storage.list-tmp','storage.list-quarantine','storage.list-ready']);
    const controller=new AbortController();let timer;
    f.modes.stallHead=true;
    try{await assert.rejects(storage.assertStorageBackendReady({signal:controller.signal,run:async(stage,work)=>{if(stage==='storage.bucket')timer=setTimeout(()=>controller.abort(),100);return work();}}),/S3_TIMEOUT/);}finally{clearTimeout(timer);f.modes.stallHead=false;}
    await storage.assertStorageBackendReady();
  });
  await t.test("immutable writes, integrity read and Path-Style", async () => {
    await storage.putStorageBytes("quarantine", key, bytes);
    await storage.putStorageBytes("quarantine", key, bytes);
    assert.deepEqual(await storage.readStorageBytes("quarantine", key), bytes);
    assert.equal(
      (await storage.storageHead("quarantine", key)).size,
      bytes.length,
    );
    await assert.rejects(
      storage.putStorageBytes("quarantine", key, Buffer.from("different")),
      /S3_OBJECT_CONFLICT/,
    );
    assert.ok(f.requests.every((x) => x.path.startsWith("/test-bucket")));
  });
  await t.test(
    "promotion keeps recovery source and rejects altered expected hash",
    async () => {
      await assert.rejects(
        storage.publishStorageFile("quarantine", "ready", key, {
          size: bytes.length,
          checksum: "0".repeat(64),
        }),
        /STORAGE_INTEGRITY_MISMATCH/,
      );
      await storage.publishStorageFile("quarantine", "ready", key, {
        size: bytes.length,
        checksum,
      });
      assert.deepEqual(await storage.readStorageBytes("ready", key), bytes);
      assert.ok(await storage.storageHead("quarantine", key));
    },
  );
  await t.test(
    "spool descriptor is readable from zero and close removes bytes",
    async () => {
      const h = await config.openPrivate("ready", key);
      assert.deepEqual(await h.readFile(), bytes);
      assert.equal((await fs.readdir(path.join(f.root, "tmp"))).length, 1);
      await h.close();
      assert.equal((await fs.readdir(path.join(f.root, "tmp"))).length, 0);
    },
  );
  await t.test(
    "pagination is complete and confined to application prefix",
    async () => {
      for (let i = 0; i < 4; i++)
        await storage.putStorageBytes("ready", crypto.randomUUID(), bytes);
      f.objects.set("another-app/ready/" + crypto.randomUUID(), {
        bytes,
        modified: new Date(),
      });
      assert.equal((await storage.listStorage("ready")).length, 5);
      f.modes.brokenPage = true;
      await assert.rejects(
        storage.listStorage("ready"),
        /STORAGE_INVENTORY_INCOMPLETE/,
      );
      f.modes.brokenPage = false;
    },
  );
  await t.test(
    "access denied is never treated as missing or successful deletion",
    async () => {
      f.modes.deny = true;
      await assert.rejects(
        storage.storageHead("ready", key),
        /S3_ACCESS_DENIED/,
      );
      await assert.rejects(
        storage.deleteStorageObject("ready", key),
        /S3_ACCESS_DENIED/,
      );
      f.modes.deny = false;
      assert.ok(await storage.storageHead("ready", key));
    },
  );
  await t.test(
    "HTTP 401 is a credential rejection and never missing",
    async () => {
      f.modes.unauthorized = true;
      try {
        await assert.rejects(
          storage.assertStorageBackendReady(),
          /S3_CREDENTIALS_REJECTED/,
        );
        await assert.rejects(
          storage.storageHead("ready", key),
          /S3_CREDENTIALS_REJECTED/,
        );
        await assert.rejects(
          storage.deleteStorageObject("ready", key),
          /S3_CREDENTIALS_REJECTED/,
        );
      } finally {
        f.modes.unauthorized = false;
      }
      assert.ok(await storage.storageHead("ready", key));
    },
  );
  await t.test(
    "inventory accepts only the exact empty area marker",
    async () => {
      const marker = "isolated/ready/";
      f.objects.set(marker, { bytes: Buffer.alloc(0), modified: new Date() });
      try {
        assert.ok(
          (await storage.listStorage("ready")).some((x) => x.key === key),
        );
        f.objects.set(marker, {
          bytes: Buffer.from("not empty"),
          modified: new Date(),
        });
        await assert.rejects(
          storage.listStorage("ready"),
          /STORAGE_INVENTORY_INVALID/,
        );
        f.objects.delete(marker);
        f.objects.set(marker + "nested/", {
          bytes: Buffer.alloc(0),
          modified: new Date(),
        });
        await assert.rejects(
          storage.listStorage("ready"),
          /STORAGE_INVENTORY_INVALID/,
        );
      } finally {
        f.objects.delete(marker);
        f.objects.delete(marker + "nested/");
      }
    },
  );
  await t.test("versioned or locked buckets refuse erasure", async () => {
    f.modes.versioned = true;
    await assert.rejects(
      storage.deleteStorageObject("ready", key),
      /S3_VERSIONED_BUCKET_UNSUPPORTED/,
    );
    f.modes.versioned = false;
    f.modes.locked = true;
    await assert.rejects(
      storage.assertStorageBackendReady(),
      /S3_OBJECT_LOCK_UNSUPPORTED/,
    );
    f.modes.locked = false;
  });

  await t.test(
    "cancellation and shared spool limit release all temporary bytes",
    async () => {
      const releases = Array.from({ length: 4 }, () => storage.reserveSpool());
      try {
        await assert.rejects(
          storage.materializeStorage("ready", key),
          /STORAGE_SPOOL_BUSY/,
        );
      } finally {
        for (const release of releases) release();
      }
      await assert.rejects(
        storage.materializeStorage("ready", key, AbortSignal.abort()),
      );
      assert.deepEqual(await fs.readdir(path.join(f.root, "tmp")), []);
      const temp = await storage.materializeStorage("ready", key);
      await temp.dispose();
      assert.deepEqual(await fs.readdir(path.join(f.root, "tmp")), []);
    },
  );
  await t.test(
    "capability probe writes only its random keys and cleans them",
    async () => {
      const count = f.objects.size,
        result = await require("../../ops/s3-storage.cjs").check(true);
      assert.equal(result.objects_cleaned, true);
      assert.equal(f.objects.size, count);
      assert.equal(
        (await require("../../ops/s3-storage.cjs").spool()).spool_files,
        0,
      );
    },
  );

  await t.test(
    "version configuration changing during Delete cannot prove erasure",
    async () => {
      const probe = crypto.randomUUID();
      await storage.putStorageBytes("quarantine", probe, bytes);
      f.modes.versionOnDelete = true;
      try {
        await assert.rejects(
          storage.deleteStorageObject("quarantine", probe),
          /S3_VERSIONED_BUCKET_UNSUPPORTED/,
        );
      } finally {
        f.modes.versionOnDelete = false;
        f.modes.versioned = false;
      }
    },
  );

  await t.test(
    "HTTP headers without response body are canceled and spool is removed",
    { timeout: 10000 },
    async () => {
      const controller = new AbortController();
      f.modes.stallGet = true;
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        await assert.rejects(
          storage.materializeStorage("ready", key, controller.signal),
          /S3_TIMEOUT/,
        );
        assert.deepEqual(await fs.readdir(path.join(f.root, "tmp")), []);
      } finally {
        clearTimeout(timer);
        f.modes.stallGet = false;
      }
    },
  );
  await t.test(
    "remote capacity is unknown; delete verifies absence and is repeatable",
    async () => {
      const health = await storage.storageHealthDetails();
      assert.equal(health.total_bytes, null);
      assert.equal(health.available_bytes, null);
      assert.match(health.spool_available_bytes, /^\d+$/);
      await storage.deleteStorageObject("ready", key);
      await storage.deleteStorageObject("ready", key);
      assert.equal(await storage.storageHead("ready", key), null);
      assert.ok(await storage.storageHead("quarantine", key));
    },
  );
});
