"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, rm, utimes } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { assertScanner, scanWithHealth } = require("../dist/files/scanner");

// These are real-engine tests, intentionally not mocked or silently skipped.
// Requires CLAMSCAN_PATH, CLAMAV_DATABASE and an operator-selected freshness policy.
test("真实ClamAV加载、新鲜度、clean与EICAR及伪造库拒绝", { concurrency: false, timeout: 300000 }, async (t) => {
  assert.ok(process.env.CLAMSCAN_PATH, "必须提供真实CLAMSCAN_PATH");
  assert.ok(process.env.CLAMAV_DATABASE, "必须提供官方CLAMAV_DATABASE");
  assert.ok(process.env.SCAN_DATABASE_MAX_AGE_HOURS, "必须明确测试的签名库新鲜度门槛");
  const before = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]; Object.assign(process.env, before); });
  const root = await mkdtemp(join(process.env.TEST_FILE_STORAGE_PARENT || tmpdir(), "kl-scanner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  process.env.FILE_STORAGE_ROOT = root;
  const clean = join(root, "clean.txt");
  await writeFile(clean, "原创扫描验收文本\n");

  await t.test("真实健康与clean包含可核验引擎和库版本", async () => {
    const health = await assertScanner();
    assert.match(health.engine_version, /^\d+\.\d+/);
    assert.match(health.database_version, /^\d+$/);
    assert.ok(health.database_updated_at instanceof Date);
    assert.ok(Date.now() - health.database_updated_at.getTime() <= Number(process.env.SCAN_DATABASE_MAX_AGE_HOURS) * 3600000);
    const result = await scanWithHealth(clean);
    assert.equal(result.result, "clean");
    assert.deepEqual(result.health, health);
  });
  await t.test("真实落盘EICAR必须由ClamAV报告infected", async () => {
    const health = await assertScanner();
    const infected = join(root, "eicar.txt");
    await writeFile(infected, 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
    const result = await scanWithHealth(infected);
    assert.equal(result.result, "infected");
    assert.deepEqual(result.health, health);
  });
  await t.test("缺失文件失败关闭", async () => {
    assert.deepEqual(await scanWithHealth(join(root, "missing")), { result: "failed" });
  });
  await t.test("不存在的绝对扫描器路径失败关闭", async (t) => {
    const scanner = process.env.CLAMSCAN_PATH;
    t.after(() => { process.env.CLAMSCAN_PATH = scanner; });
    process.env.CLAMSCAN_PATH = join(root, "missing-clamscan.exe");
    await assert.rejects(assertScanner(), /引擎或病毒库未就绪/);
    assert.deepEqual(await scanWithHealth(clean), { result: "failed" });
  });
  await t.test("过期病毒库失败关闭", async (t) => {
    const policy = process.env.SCAN_DATABASE_MAX_AGE_HOURS;
    t.after(() => { process.env.SCAN_DATABASE_MAX_AGE_HOURS = policy; });
    process.env.SCAN_DATABASE_MAX_AGE_HOURS = "0.000000001";
    await assert.rejects(assertScanner(), /过期|更新时间/);
    assert.deepEqual(await scanWithHealth(clean), { result: "failed" });
  });
  await t.test("缺少新鲜度配置失败关闭", async (t) => {
    const policy = process.env.SCAN_DATABASE_MAX_AGE_HOURS;
    t.after(() => { process.env.SCAN_DATABASE_MAX_AGE_HOURS = policy; });
    delete process.env.SCAN_DATABASE_MAX_AGE_HOURS;
    await assert.rejects(assertScanner(), /SCAN_DATABASE_MAX_AGE_HOURS/);
    assert.deepEqual(await scanWithHealth(clean), { result: "failed" });
  });
  await t.test("伪造库头及新mtime不能替代真实签名库", async (t) => {
    const database = process.env.CLAMAV_DATABASE;
    t.after(() => { process.env.CLAMAV_DATABASE = database; });
    const fakeDatabase = await mkdtemp(join(root, "fake-db-"));
    const seconds = Math.floor(Date.now() / 1000);
    const header = `ClamAV-VDB:${new Date().toUTCString()}:999999:1:90:00000000000000000000000000000000:fake:builder:${seconds}`;
    for (const name of ["main", "daily"]) {
      const filename = join(fakeDatabase, `${name}.cvd`);
      await writeFile(filename, header.padEnd(512, " ") + "not a valid signed compressed database");
      await utimes(filename, new Date(), new Date());
    }
    process.env.CLAMAV_DATABASE = fakeDatabase;
    await assert.rejects(assertScanner());
    assert.deepEqual(await scanWithHealth(clean), { result: "failed" });
  });
});
