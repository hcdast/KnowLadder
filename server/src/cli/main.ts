import { objectIdDatabase } from "../database/object-id";
import { MongoClient } from "mongodb";
import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../config";
import type { RoleCode, Organization, ControlledCapability, AdministrationOperation } from "../database/contracts";
import { assertWindowsPrivateDirectory } from "../security/private-directory";
import { acquireWriter, type WriterRegistration } from "../operations/control";
import { assertSchema } from "../migrations/schema";
import {
  AdminError,
  createOrganization,
  createUser,
  setMembership,
  setUserStatus,
  resetPassword,
  setOrganizationStatus,
  lockRestoredAuth,
  type OperationContext,
  setCapability,
  bootstrapGovernance,
  inspectAdministration,
  recoverCliAdministration,
} from "./admin-operations";

const HELP = `受审计运维命令（先执行数据库迁移；所有变更必须 --actor 操作者 --reason 原因）：
  organization-create --name 名称 --kind school|personal|platform
  user-create --login-name 登录名 --display-name 显示名 [--secret-file 绝对路径]
  membership-set --user-id ObjectId --org-id ObjectId --roles student,org_admin [--status active|disabled] [--expected-revision 当前版本] [--valid-to UTC ISO8601 新content_reviewer必填]
  user-status --user-id ObjectId --status active|disabled
  password-reset --user-id ObjectId [--secret-file 绝对路径]
  organization-status --org-id ObjectId --status active|disabled
  lock-restored-auth --confirm LOCK_RESTORED_AUTH
  capability-set --member-id ObjectId --org-id ObjectId --capability content:retire|content:revoke|file:delete|assessment:manage|assessment:review|teaching:roster|teaching:assign|teaching:report --granted true|false --expected-revision 当前版本 [--valid-to UTC ISO8601]
  governance-bootstrap --user-id ObjectId --org-id ObjectId --expected-revision 当前版本 （两位独立已建平台账号）
  inspect [--operation-id ObjectId] （严格只读，不注册writer）
  recovery --operation-id ObjectId --mode forward|void|invalidate|release [--previous-recovery-token UUID] [--secret-file 绝对路径]
能力仅显式授予有效成员，membership-set及恢复锁定撤销全部独立能力，需重新审批分配。
密码不接受命令行输入，不向 stdout 输出。非交互必须 --secret-file；文件不得位于仓库内，且不得已存在。
POSIX父目录须由当前用户独占（0700）；Windows父目录须预先创建且DACL受保护，仅当前用户、SYSTEM和Administrators可访问，祖先不得允许非可信主体替换路径；拒绝重解析点。
`;
const flags: Record<string, string[]> = {
  "organization-create": ["name", "kind"],
  "user-create": ["login-name", "display-name", "secret-file"],
  "membership-set": [
    "user-id",
    "org-id",
    "roles",
    "status",
    "expected-revision",
    "valid-to",
  ],
  "user-status": ["user-id", "status"],
  "password-reset": ["user-id", "secret-file"],
  "organization-status": ["org-id", "status"],
  "lock-restored-auth": ["confirm"],
  "capability-set": ["member-id", "org-id", "capability", "granted", "expected-revision", "valid-to"],
  "governance-bootstrap": ["user-id", "org-id", "expected-revision"],
  "inspect": ["operation-id"],
  "recovery": ["operation-id", "mode", "previous-recovery-token", "secret-file"],
};
export function parseArguments(argv: string[]): {
  command: string;
  values: Record<string, string>;
} {
  const [command, ...args] = argv;
  if (!command || !Object.hasOwn(flags, command))
    throw new AdminError("USAGE", "未知命令；使用 --help 查看说明");
  const allowed = new Set([...flags[command], "actor", "reason"]);
  const values: Record<string, string> = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].startsWith("--") ? args[i].slice(2) : "";
    if (
      !allowed.has(key) ||
      Object.hasOwn(values, key) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw new AdminError("USAGE", "参数未知、重复或缺少值");
    values[key] = args[i + 1];
  }
  if (command !== "inspect") {
    required(values, "actor");
    required(values, "reason");
  }
  if (
    (values.actor?.length ?? 0) > 128 ||
    (values.reason?.length ?? 0) > 512 ||
    /[\x00-\x1f\x7f]/.test((values.actor ?? "") + (values.reason ?? ""))
  ) throw new AdminError("USAGE", "操作者或原因不合法");
  return { command, values };
}
function required(values: Record<string, string>, key: string): string {
  if (!values[key]?.trim()) throw new AdminError("USAGE", `缺少 --${key}`);
  return values[key];
}
interface SecretSink {
  deliver(secret: string): Promise<void>;
  close(): Promise<void>;
}
async function prepareSecretSink(path?: string): Promise<SecretSink> {
  if (!path) {
    if (!process.stdin.isTTY || !process.stderr.isTTY)
      throw new AdminError(
        "SECRET_DESTINATION",
        "非交互模式必须指定 --secret-file",
      );
    const terminal = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      if (
        (await terminal.question(
          "临时密码将仅在当前终端显示一次，请确认无录屏或旁观者。输入 RECEIVE 接收：",
        )) !== "RECEIVE"
      )
        throw new AdminError("CANCELLED", "未确认接收密码");
    } finally {
      terminal.close();
    }
    return {
      deliver: async (secret) => {
        process.stderr.write(`临时密码（请安全转交并立即修改）：${secret}\n`);
      },
      close: async () => {},
    };
  }
  if (!isAbsolute(path))
    throw new AdminError("SECRET_DESTINATION", "密码文件必须使用绝对路径");
  const repository = await realpath(resolve(__dirname, "../../.."));
  const requested = resolve(path);
  const parent = dirname(requested);
  if (process.platform === "win32") {
    if (/[.: ]$/.test(basename(requested)) || basename(requested).includes(":"))
      throw new AdminError(
        "SECRET_DESTINATION",
        "不支持Windows备用数据流或歧义文件名",
      );
    try { await assertWindowsPrivateDirectory(parent); }
    catch { throw new AdminError("SECRET_DESTINATION", "Windows密码目录不满足受保护私密ACL及可信祖先要求，或无法核验；拒绝写入"); }
  }
  const canonicalParent = await realpath(parent);
  const target = resolve(canonicalParent, basename(requested));
  const rel = relative(repository, target);
  if (
    !rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) &&
    rel !== ".." &&
    !isAbsolute(rel)
  )
    throw new AdminError("SECRET_DESTINATION", "密码文件不能位于仓库内");
  const info = await stat(canonicalParent);
  if (
    process.platform !== "win32" &&
    ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
  )
    throw new AdminError(
      "SECRET_DESTINATION",
      "密码目录必须由当前用户独占（0700）",
    );
  const file: FileHandle = await open(
    target,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  return {
    deliver: async (secret) => {
      await file.writeFile(`${secret}\n`, { encoding: "utf8" });
      await file.sync();
    },
    close: () => file.close(),
  };
}
export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(HELP);
    return;
  }
  const { command, values: v } = parseArguments(argv);
  const config = loadConfig();
  let sink: SecretSink | undefined;
  let client: MongoClient | undefined;
  let writer: WriterRegistration | undefined;
  try {
    if (command === "user-create" || command === "password-reset")
      sink = await prepareSecretSink(v["secret-file"]);
    client = new MongoClient(config.mongoUri, {
      readPreference: "primary",
      writeConcern: { w: "majority" },
      serverSelectionTimeoutMS: 10000,
    });
    await client.connect();
    await assertSchema(objectIdDatabase(client.db()));
    if (command === "inspect") {
      process.stdout.write(JSON.stringify(await inspectAdministration(objectIdDatabase(client.db()), v["operation-id"])) + "\n");
      return;
    }
    if (command === "recovery" && v.mode === "forward") {
      const op = await objectIdDatabase(client.db()).collection<AdministrationOperation>("administration_operations").findOne({ _id: required(v, "operation-id") });
      if (op && ["user.create", "user.password.reset"].includes(op.action) && op.status !== "applied")
        sink = await prepareSecretSink(v["secret-file"]);
    }
    writer = await acquireWriter(objectIdDatabase(client.db()), "admin");
    const ctx: OperationContext = {
      client,
      db: objectIdDatabase(client.db()),
      actor: v.actor,
      reason: v.reason,
      temporaryPasswordMs: config.temporaryPasswordMs,
    };
    let result: Record<string, unknown>;
    switch (command) {
      case "capability-set": {
        const granted = required(v, "granted");
        const revision = required(v, "expected-revision");
        if (!["true", "false"].includes(granted) || !/^[1-9][0-9]*$/.test(revision))
          throw new AdminError("USAGE", "granted必须为true或false，版本必须是正整数");
        const validTo = v["valid-to"];
        if (validTo && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(validTo))
          throw new AdminError("USAGE", "到期时间需UTC ISO8601");
        result = await setCapability(ctx, { member_id: required(v, "member-id"), org_id: required(v, "org-id"),
          capability: required(v, "capability") as ControlledCapability,
          granted: granted === "true", expected_revision: Number(revision),
          valid_to: validTo ? new Date(validTo) : undefined });
        break;
      }
      case "organization-create":
        result = await createOrganization(ctx, {
          name: required(v, "name"),
          kind: required(v, "kind") as Organization["kind"],
        });
        break;
      case "user-create":
        result = await createUser(ctx, {
          login_name: required(v, "login-name"),
          display_name: required(v, "display-name"),
        });
        break;
      case "membership-set": {
        const roleList = required(v, "roles");
        const revision = v["expected-revision"];
        if (revision !== undefined && !/^[1-9][0-9]*$/.test(revision))
          throw new AdminError("USAGE", "成员版本必须是正整数");
        const reviewerValidTo = v["valid-to"];
        if (reviewerValidTo && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(reviewerValidTo))
          throw new AdminError("USAGE", "角色期限需UTC ISO8601");
        result = await setMembership(ctx, {
          user_id: required(v, "user-id"),
          org_id: required(v, "org-id"),
          roles: (roleList === "none" ? [] : roleList.split(",")) as RoleCode[],
          status: v.status as "active" | "disabled" | undefined,
          expected_revision:
            revision === undefined ? undefined : Number(revision),
          reviewer_valid_to: reviewerValidTo ? new Date(reviewerValidTo) : undefined,
        });
        break;
      }
      case "user-status":
        result = await setUserStatus(ctx, {
          user_id: required(v, "user-id"),
          status: required(v, "status") as "active" | "disabled",
        });
        break;
      case "password-reset":
        result = await resetPassword(ctx, { user_id: required(v, "user-id") });
        break;
      case "organization-status":
        result = await setOrganizationStatus(ctx, {
          org_id: required(v, "org-id"),
          status: required(v, "status") as "active" | "disabled",
        });
        break;
      case "lock-restored-auth":
        result = await lockRestoredAuth(ctx, {
          confirmation: required(v, "confirm"),
        });
        break;
      case "governance-bootstrap": {
        const revision = required(v, "expected-revision");
        if (!/^[1-9][0-9]*$/.test(revision)) throw new AdminError("USAGE", "成员版本必须是正整数");
        result = await bootstrapGovernance(ctx, {
          user_id: required(v, "user-id"), org_id: required(v, "org-id"), expected_revision: Number(revision),
        });
        break;
      }
      case "recovery": {
        const mode = required(v, "mode");
        if (!["forward", "void", "invalidate", "release"].includes(mode))
          throw new AdminError("USAGE", "恢复模式仅为forward、void、invalidate或release");
        result = await recoverCliAdministration(ctx, {
          operation_id: required(v, "operation-id"),
          mode: mode as "forward" | "void" | "invalidate" | "release",
          previous_recovery_token: v["previous-recovery-token"],
        });
        break;
      }
      default:
        throw new AdminError("USAGE", "未知命令");
    }
    if ("secret" in result) {
      const secret = result.secret as string;
      delete result.secret;
      try {
        await sink!.deliver(secret);
      } catch {
        throw new AdminError(
          "SECRET_DELIVERY",
          "数据库变更已提交但密码交付失败。请修复安全目标后重新执行 password-reset；不会回显密码",
        );
      }
    }
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
  } finally {
    try { await sink?.close(); }
    finally {
      try { await writer?.release(); }
      finally { await client?.close(); }
    }
  }
}
if (require.main === module) {
  runCli().catch((error: unknown) => {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    const message =
      error instanceof AdminError
        ? error.message
        : code === 11000
          ? "对象已存在，拒绝重复创建或隐式提权"
          : code === "EEXIST"
            ? "密码文件已存在，拒绝覆盖"
            : "操作失败，请检查数据库、迁移状态及私密文件权限；不会输出连接信息";
    process.stderr.write(`失败：${message}\n`);
    process.exitCode = 1;
  });
}
