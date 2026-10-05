import { lstat, mkdir, realpath, open, chmod, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { assertWindowsPrivateDirectory } from '../security/private-directory';
export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const FILE_MIMES = ['application/pdf','image/png','image/jpeg','text/plain'] as const;
export function allowedFileMimes():readonly string[]{return process.env.KL_TRAINING_ENABLED==='true'?[...FILE_MIMES,'video/mp4','audio/mpeg']:FILE_MIMES;}
export function fileScanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.FILE_SCAN_ENABLED;
  if (value === undefined || value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('FILE_SCAN_ENABLED 必须为 true 或 false');
}
export function assertFileScanEnabled(): void {
  if (!fileScanEnabled()) throw new Error('FILE_SCAN_DISABLED');
}
function configuredRoot() {
  const root = process.env.FILE_STORAGE_ROOT;
  if (!root || !path.isAbsolute(root)) throw new Error('必须配置绝对路径 FILE_STORAGE_ROOT');
  return path.resolve(root);
}
export interface FileConfig {
  root: string;
  scanner: string;
  database: string;
  timeout: number;
  databaseMaxAgeHours: number;
}
export function fileConfig(): FileConfig {
  assertFileScanEnabled();
  const root = configuredRoot();
  const scanner = process.env.CLAMSCAN_PATH;
  const database = process.env.CLAMAV_DATABASE;
  if (!scanner || !path.isAbsolute(scanner) || !database || !path.isAbsolute(database)) throw new Error('必须配置绝对路径 CLAMSCAN_PATH 和 CLAMAV_DATABASE');
  const timeout = Number(process.env.SCAN_TIMEOUT_MS ?? 60000);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 300000) throw new Error('SCAN_TIMEOUT_MS 必须在1000至300000之间');
  const databaseMaxAgeHours = Number(process.env.SCAN_DATABASE_MAX_AGE_HOURS);
  if (!Number.isFinite(databaseMaxAgeHours) || databaseMaxAgeHours <= 0 || databaseMaxAgeHours > 8760) throw new Error('必须配置 SCAN_DATABASE_MAX_AGE_HOURS（大于0且不超过8760小时）');
  return { root, scanner: path.normalize(scanner), database: path.normalize(database), timeout, databaseMaxAgeHours };
}
async function noLinks(target: string) {
  let cursor = path.resolve(target);
  for (;;) {
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error('文件存储禁止符号链接或junction');
    if (process.platform !== 'win32' && info.isDirectory()) {
      if ((info.uid !== process.getuid!() && info.uid !== 0) || (info.mode & 0o022) !== 0) throw new Error('私有存储目录及祖先必须由可信用户持有且禁止组或其他用户写入');
    }
    if (path.dirname(cursor) === cursor) break;
    cursor = path.dirname(cursor);
  }
  const actual = path.resolve(await realpath(target));
  const expected = path.resolve(target);
  if ((process.platform === 'win32' ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected)) throw new Error('文件存储真实路径不匹配');
}
export async function storageRoot() {
  const config = { root: configuredRoot() };
  // Compiled and source locations both resolve to the repository root.
  const repository = path.resolve(__dirname, '../../..');
  for (const base of [repository, process.cwd()]) {
    const relative = path.relative(base, config.root);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('私有存储必须位于仓库和工作目录之外');
  }
  await mkdir(config.root, { recursive: true, mode: 0o700 });
  await noLinks(config.root);
  if (process.platform === 'win32') await assertWindowsPrivateDirectory(config.root);
  if (process.platform !== 'win32') await chmod(config.root, 0o700);
  for (const directory of ['tmp','quarantine','ready']) {
    const child = path.join(config.root, directory);
    await mkdir(child, { recursive: true, mode: 0o700 });
    await noLinks(child);
    const info = await lstat(child);
    if (!info.isDirectory()) throw new Error('存储目录无效');
    if (process.platform !== 'win32') await chmod(child, 0o700);
  }
  if (process.platform === 'win32') await assertWindowsPrivateDirectory(config.root, ['tmp', 'quarantine', 'ready']);
  return config.root;
}
async function checkedRoot(root?: string) {
  if (root === undefined) return storageRoot();
  if (root !== configuredRoot()) throw new Error('存储安全上下文不匹配');
  await noLinks(root);
  if (process.platform === 'win32') await assertWindowsPrivateDirectory(root, ['tmp', 'quarantine', 'ready']);
  return root;
}
export async function storagePath(area: 'tmp'|'quarantine'|'ready', key: string, root?: string) {
  if (!['tmp', 'quarantine', 'ready'].includes(area)) throw new Error('无效存储区域');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key)) throw new Error('无效存储标识');
  const directory = path.join(await checkedRoot(root), area);
  await noLinks(directory);
  if (!(await lstat(directory)).isDirectory()) throw new Error('存储目录无效');
  return path.join(directory, key);
}
export async function assertUploadCapacity(bytes: number, root?: string): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_FILE_SIZE) throw new Error('无效上传大小');
  const minimum = Number(process.env.FILE_MIN_FREE_BYTES ?? 100 * 1024 * 1024);
  if (!Number.isSafeInteger(minimum) || minimum < 0) throw new Error('FILE_MIN_FREE_BYTES 必须为非负安全整数');
  const info = await statfs(await checkedRoot(root), { bigint: true });
  if (info.bavail < 0n || info.bsize <= 0n || info.bavail * info.bsize < BigInt(bytes) + BigInt(minimum)) throw new Error('文件存储可用空间不足，暂停新上传');
}
export async function openPrivate(area: 'quarantine'|'ready', key: string, root?: string) {
  const filename = await storagePath(area, key, root);
  await noLinks(filename);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const info = await handle.stat();
  if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE_SIZE) { await handle.close(); throw new Error('私有文件无效'); }
  return handle;
}
