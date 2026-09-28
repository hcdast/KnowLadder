"use strict";

// Stage-one authentication only: bounded in-memory EJSON, never plaintext on disk.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { MongoClient, BSON } = require("../server/node_modules/mongodb");
const { ROLE_CAPABILITIES } = require("../server/dist/database/contracts.js");
const { migrate } = require("../server/dist/migrations/schema.js");
const EJSON = BSON.EJSON;
const LIMIT = 32 * 1024 * 1024;
const HEADER = Buffer.from("KLAUTHBACKUP\x01", "binary");
const OVERHEAD = HEADER.length + 12 + 16;
const COLLECTIONS = [
  "users",
  "organizations",
  "organization_members",
  "roles",
  "member_roles",
  "audit_events",
];
const HELP = `阶段一认证格式兼容读取（不是全业务备份或生产RPO保证）
  node ops/auth-backup.cjs backup --file ABS （只限尚未升级v7的历史源）
  node ops/auth-backup.cjs inspect --file ABS
  node ops/auth-backup.cjs verify --file ABS
环境变量：AUTH_BACKUP_KEY（64位十六进制，独立安全保管）；backup另需MONGODB_URI。
先构建server；backup需要真实副本集。inspect/verify只解密校验原格式，不连接数据库。
最大明文EJSON 32MiB；超限失败，磁盘仅保存AES-256-GCM密文，备份绝不覆盖。
新schema/隐私模型备份及隔离恢复必须使用system-backup。旧格式restore明确拒绝，不能证明全业务与最新删除/保全账本。`;

function fail(message) {
  const error = new Error(message);
  error.safe = true;
  throw error;
}
function ensure(condition, message = "备份结构或字段类型不合法，拒绝恢复") {
  if (!condition) fail(message);
}
function object(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function keys(value, expected) {
  ensure(
    object(value) &&
      Object.keys(value).length === expected.length &&
      expected.every((k) => Object.hasOwn(value, k)),
  );
}
function text(value) {
  return typeof value === "string" && value.length > 0;
}
function date(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}
function revision(value) {
  return (
    Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER
  );
}
function uuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}
function status(value) {
  return value === "active" || value === "disabled";
}
function dates(doc, fields) {
  ensure(fields.every((k) => date(doc[k])));
}
function strings(doc, fields) {
  ensure(fields.every((k) => text(doc[k])));
}
function knownRole(value) {
  return typeof value === "string" && Object.hasOwn(ROLE_CAPABILITIES, value);
}

function validate(data) {
  keys(data, ["version", "created_at", "collections"]);
  ensure(data.version === 1 && date(data.created_at));
  keys(data.collections, COLLECTIONS);
  const maps = {};
  for (const name of COLLECTIONS) {
    const rows = data.collections[name];
    ensure(Array.isArray(rows));
    maps[name] = new Map();
    for (const doc of rows) {
      ensure(object(doc) && text(doc._id) && !maps[name].has(doc._id));
      if (name !== "roles") ensure(uuid(doc._id));
      maps[name].set(doc._id, doc);
      if (name === "users") {
        keys(doc, [
          "_id",
          "login_key",
          "display_name",
          "status",
          "password_hash",
          "credential_version",
          "identity_revision",
          "must_change_password",
          "temporary_password_expires_at",
          "password_changed_at",
          "created_at",
          "updated_at",
        ]);
        strings(doc, ["login_key", "display_name", "password_hash"]);
        ensure(
          /^[a-z0-9_-]{3,64}$/.test(doc.login_key) &&
            /^\$argon2id\$/.test(doc.password_hash) &&
            status(doc.status) &&
            revision(doc.credential_version) &&
            doc.credential_version >= 1 &&
            revision(doc.identity_revision) &&
            typeof doc.must_change_password === "boolean",
        );
        ensure(
          doc.temporary_password_expires_at === null ||
            date(doc.temporary_password_expires_at),
        );
        dates(doc, ["password_changed_at", "created_at", "updated_at"]);
        ensure(
          doc.created_at <= doc.password_changed_at &&
            doc.password_changed_at <= doc.updated_at,
        );
        ensure(
          doc.must_change_password
            ? date(doc.temporary_password_expires_at) &&
                (doc.status === "disabled" ||
                  doc.temporary_password_expires_at > doc.password_changed_at)
            : doc.temporary_password_expires_at === null,
        );
      } else if (name === "organizations") {
        keys(doc, [
          "_id",
          "name",
          "kind",
          "status",
          "created_at",
          "updated_at",
        ]);
        ensure(
          text(doc.name) &&
            ["school", "personal", "platform"].includes(doc.kind) &&
            status(doc.status),
        );
        dates(doc, ["created_at", "updated_at"]);
      } else if (name === "organization_members") {
        keys(doc, [
          "_id",
          "org_id",
          "user_id",
          "status",
          "authorization_revision",
          "created_at",
          "updated_at",
        ]);
        ensure(uuid(doc.org_id) && uuid(doc.user_id));
        ensure(status(doc.status) && revision(doc.authorization_revision));
        dates(doc, ["created_at", "updated_at"]);
      } else if (name === "roles") {
        keys(doc, ["_id", "code", "capabilities"]);
        ensure(
          knownRole(doc.code) &&
            doc._id === doc.code &&
            Array.isArray(doc.capabilities),
        );
        const allowed = ROLE_CAPABILITIES[doc.code];
        ensure(
          doc.capabilities.length === allowed.length &&
            new Set(doc.capabilities).size === allowed.length &&
            doc.capabilities.every((c) => allowed.includes(c)),
          "备份角色包含未知或不匹配权限，拒绝恢复",
        );
      } else if (name === "member_roles") {
        keys(doc, ["_id", "org_id", "member_id", "role_id"]);
        ensure(uuid(doc.org_id) && uuid(doc.member_id));
        ensure(knownRole(doc.role_id));
      } else {
        keys(doc, [
          "_id",
          "actor_id",
          "org_id",
          "action",
          "resource_id",
          "reason",
          "request_id",
          "created_at",
        ]);
        strings(doc, ["actor_id", "action", "resource_id", "reason"]);
        ensure(
          uuid(doc.request_id) && (doc.org_id === null || uuid(doc.org_id)),
        );
        dates(doc, ["created_at"]);
      }
      if (Object.hasOwn(doc, "updated_at"))
        ensure(doc.created_at <= doc.updated_at);
    }
  }
  ensure(
    new Set(data.collections.users.map((d) => d.login_key)).size ===
      data.collections.users.length,
  );
  const memberKeys = new Set();
  for (const member of data.collections.organization_members) {
    ensure(
      maps.users.has(member.user_id) && maps.organizations.has(member.org_id),
    );
    const key = JSON.stringify([member.org_id, member.user_id]);
    ensure(!memberKeys.has(key));
    memberKeys.add(key);
  }
  const grantKeys = new Set();
  for (const grant of data.collections.member_roles) {
    ensure(
      maps.organization_members.get(grant.member_id)?.org_id === grant.org_id &&
        maps.roles.has(grant.role_id),
    );
    const key = JSON.stringify([grant.member_id, grant.role_id]);
    ensure(!grantKeys.has(key));
    grantKeys.add(key);
  }
}

async function externalFile(input, writing) {
  ensure(
    typeof input === "string" && path.isAbsolute(input),
    "--file 必须是绝对路径",
  );
  const root = await fs.realpath(path.resolve(__dirname, ".."));
  const resolved = writing
    ? path.join(await fs.realpath(path.dirname(input)), path.basename(input))
    : await fs.realpath(input);
  const relative = path.relative(root, resolved);
  ensure(
    relative !== "" &&
      (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)),
    "备份文件不得位于仓库内",
  );
  if (writing) {
    try {
      await fs.lstat(resolved);
      fail("目标文件已存在，拒绝覆盖");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return resolved;
}

async function publish(file, encrypted) {
  const temporary = path.join(
    path.dirname(file),
    `.kl-auth-${crypto.randomUUID()}.tmp`,
  );
  let handle;
  let created = false;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    created = true;
    await handle.writeFile(encrypted);
    await handle.sync();
    await handle.close();
    handle = null;
    // An atomic hard link, unlike rename, cannot replace an existing destination.
    await fs.link(temporary, file);
  } finally {
    if (handle) await handle.close();
    if (created) await fs.unlink(temporary);
  }
}

async function backup(client, db, file, key) {
  const chunks = [];
  let bytes = 0;
  let plaintext;
  const append = (value) => {
    const length = Buffer.byteLength(value);
    ensure(bytes + length <= LIMIT, "备份超过32MiB上限，已中止，未截断");
    bytes += length;
    chunks.push(Buffer.from(value));
  };
  const session = client.startSession();
  try {
    session.startTransaction({
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      readPreference: "primary",
    });
    const counts = {};
    append(
      `{"version":1,"created_at":${EJSON.stringify(new Date(), { relaxed: false })},"collections":{`,
    );
    for (const [index, name] of COLLECTIONS.entries()) {
      if (index) append(",");
      append(`${JSON.stringify(name)}:[`);
      counts[name] = 0;
      const cursor = db.collection(name).find({}, { session, batchSize: 64 });
      try {
        for await (const doc of cursor) {
          if (counts[name]) append(",");
          append(EJSON.stringify(doc, { relaxed: false }));
          counts[name]++;
        }
      } finally {
        await cursor.close();
      }
      append("]");
    }
    append("}}");
    await session.commitTransaction();
    plaintext = Buffer.concat(chunks, bytes);
    try {
      // Use the identical original decoder/validator as inspect and verify.
      validate(EJSON.parse(plaintext.toString("utf8"), { relaxed: true }));
    } catch {
      fail("LEGACY_BACKUP_UNSUPPORTED_DATA：当前认证/审计字段不符合旧格式，未发布备份；请使用system-backup");
    }
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(HEADER);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    await publish(
      file,
      Buffer.concat([HEADER, nonce, cipher.getAuthTag(), ciphertext]),
    );
    console.log(
      JSON.stringify({
        command: "backup",
        counts,
        plaintext_bytes: bytes,
        sessions: "excluded-and-invalid-on-restore",
      }),
    );
  } finally {
    if (session.inTransaction())
      await session.abortTransaction().catch(() => {});
    await session.endSession();
    plaintext?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function decrypt(file, key) {
  let handle;
  let plaintext;
  let first;
  let last;
  try {
    handle = await fs.open(file, "r");
    const stat = await handle.stat();
    ensure(
      stat.isFile() && stat.size > OVERHEAD && stat.size <= LIMIT + OVERHEAD,
      "密文文件大小或类型不合法",
    );
    const encrypted = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < encrypted.length) {
      const result = await handle.read(
        encrypted,
        offset,
        encrypted.length - offset,
        offset,
      );
      ensure(result.bytesRead > 0, "密文文件读取不完整");
      offset += result.bytesRead;
    }
    const extra = Buffer.alloc(1);
    ensure(
      (await handle.read(extra, 0, 1, offset)).bytesRead === 0,
      "密文文件在读取期间发生变化",
    );
    ensure(
      encrypted.subarray(0, HEADER.length).equals(HEADER),
      "不支持的备份版本",
    );
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      encrypted.subarray(HEADER.length, HEADER.length + 12),
    );
    decipher.setAAD(HEADER);
    decipher.setAuthTag(encrypted.subarray(HEADER.length + 12, OVERHEAD));
    try {
      first = decipher.update(encrypted.subarray(OVERHEAD));
      last = decipher.final();
    } catch {
      fail("备份密钥错误或密文校验失败；未连接或写入目标数据库");
    }
    plaintext = Buffer.concat([first, last]);
    let data;
    try {
      data = EJSON.parse(plaintext.toString("utf8"), { relaxed: true });
    } catch {
      fail("备份EJSON格式不合法");
    }
    validate(data);
    return data;
  } finally {
    plaintext?.fill(0);
    first?.fill(0);
    last?.fill(0);
    if (handle) await handle.close();
  }
}

async function restore(client, db, uri, data) {
  ensure(
    /^kl_restore_[a-zA-Z0-9_-]+$/.test(db.databaseName),
    "恢复目标库必须使用kl_restore_前缀",
  );
  ensure(
    (await db.listCollections({}, { nameOnly: true }).toArray()).length === 0,
    "恢复目标必须是新的空库（不允许已有集合）",
  );
  await migrate(uri);
  const now = new Date();
  for (const user of data.collections.users) {
    user.status = "disabled";
    user.must_change_password = true;
    user.temporary_password_expires_at = new Date(0);
    user.credential_version++;
    user.identity_revision++;
    user.updated_at = now;
  }
  for (const member of data.collections.organization_members) {
    member.status = "disabled";
    member.authorization_revision++;
    member.updated_at = now;
  }
  const session = client.startSession();
  try {
    await session.withTransaction(
      async () => {
        // Detect accidental use between the empty-database check and transaction.
        for (const name of [
          ...COLLECTIONS.filter((n) => n !== "roles"),
          "auth_sessions",
        ]) {
          ensure(
            (await db.collection(name).countDocuments({}, { session })) === 0,
            "目标库不再为空，拒绝恢复",
          );
        }
        for (const name of [
          "users",
          "organizations",
          "organization_members",
          "audit_events",
        ]) {
          const rows = data.collections[name];
          if (rows.length)
            await db
              .collection(name)
              .insertMany(rows, { session, ordered: true });
        }
        await db.collection("auth_sessions").deleteMany({}, { session });
        await db.collection("audit_events").insertOne(
          {
            _id: crypto.randomUUID(),
            actor_id: "system:isolated-restore",
            org_id: null,
            action: "auth.backup.restore",
            resource_id: db.databaseName,
            reason:
              "隔离恢复：所有身份/成员禁用，旧会话失效，未恢复角色分配；需安全核验及密码重置后重新授权启用",
            request_id: crypto.randomUUID(),
            created_at: now,
          },
          { session },
        );
      },
      {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
      },
    );
    console.log(
      JSON.stringify({
        command: "restore",
        backup_counts: Object.fromEntries(
          COLLECTIONS.map((name) => [name, data.collections[name].length]),
        ),
        counts: Object.fromEntries(
          [
            "users",
            "organizations",
            "organization_members",
            "audit_events",
          ].map((name) => [
            name,
            data.collections[name].length + (name === "audit_events" ? 1 : 0),
          ]),
        ),
        discarded_role_assignments: data.collections.member_roles.length,
        sessions: 0,
        identities: "disabled",
        memberships: "disabled",
        roles: "current-trusted-schema-only",
      }),
    );
  } finally {
    await session.endSession();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length === 0 ||
    (args.length === 1 && ["--help", "-h"].includes(args[0]))
  ) {
    console.log(HELP);
    return;
  }
  const [command, flag, input, confirm] = args;
  ensure(
    flag === "--file" &&
      ((["backup", "inspect", "verify"].includes(command) && args.length === 3) ||
        (command === "restore" &&
          args.length === 4 &&
          confirm === "--confirm-isolated-restore")),
    HELP,
  );
  ensure(command !== "restore", "LEGACY_RESTORE_BLOCKED：旧认证包缺少全业务与独立删除账本证明；请使用system-backup隔离恢复，旧包仅支持inspect/verify读取");
  let key;
  let client;
  try {
    ensure(
      /^[a-fA-F0-9]{64}$/.test(process.env.AUTH_BACKUP_KEY || ""),
      "AUTH_BACKUP_KEY必须是64位十六进制密钥",
    );
    key = Buffer.from(process.env.AUTH_BACKUP_KEY, "hex");
    delete process.env.AUTH_BACKUP_KEY;
    if (command === "inspect" || command === "verify") {
      const data = await decrypt(await externalFile(input, false), key);
      console.log(JSON.stringify({ command, format: "legacy-auth-v1", whole_business: false, restore_allowed: false, counts: Object.fromEntries(COLLECTIONS.map(name => [name, data.collections[name].length])) }));
      return;
    }
    const uri = process.env.MONGODB_URI;
    const database =
      typeof uri === "string" &&
      /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)(?:\?.*)?$/.exec(uri);
    ensure(database, "MONGODB_URI必须显式指定数据库");
    const name = decodeURIComponent(database[1]);
    if (command === "restore")
      ensure(
        /^kl_restore_[a-zA-Z0-9_-]+$/.test(name),
        "恢复目标库必须使用kl_restore_前缀",
      );
    const file = await externalFile(input, command === "backup");
    // Authenticate and validate the entire backup before any database connection.
    const data = command === "restore" ? await decrypt(file, key) : null;
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    const db = client.db(name);
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(row => row.name);
    ensure(!names.some(name => ["operational_state", "privacy_tombstones", "privacy_deletion_requests"].includes(name)), "LEGACY_BACKUP_BLOCKED：新schema/隐私模型必须使用system-backup，不能绕过维护闸门");
    ensure(!(await db.collection("schema_migrations").findOne({ version: { $gte: 7 } })), "LEGACY_BACKUP_BLOCKED：新schema必须使用system-backup");
    ensure(await db.collection("schema_migrations").findOne({ version: 1, status: "completed" }), "LEGACY_BACKUP_BLOCKED：只接受真实已部署历史schema");
    ensure(!(await db.collection("users").findOne({ privacy_state: { $exists: true } })), "LEGACY_BACKUP_BLOCKED：隐私模型必须使用system-backup");
    const hello = await db.admin().command({ hello: 1 });
    ensure(
      typeof hello.setName === "string",
      "仅支持真实副本集的snapshot备份及事务恢复",
    );
    if (command === "backup") await backup(client, db, file, key);
    else await restore(client, db, uri, data);
  } finally {
    key?.fill(0);
    delete process.env.AUTH_BACKUP_KEY;
    if (client) await client.close();
  }
}

main().catch((error) => {
  // Driver errors can contain URIs, document bodies or hashes: never print them.
  console.error(
    error.safe
      ? error.message
      : "操作失败（连接、schema、文件权限或数据库约束错误）；未输出敏感详情。恢复失败的目标库必须保持隔离，重试请使用另一新空库。",
  );
  process.exitCode = 1;
});
