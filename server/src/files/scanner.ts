/// <reference lib="es2024.promise" />
import { checkStep, type CheckContext } from "../runtime/check-context";
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { assertFileScanEnabled, fileConfig, MAX_FILE_SIZE } from './config';
import type { FileConfig } from './config';

export type ScanResult = 'clean' | 'infected' | 'failed';
export interface ScannerHealth {
  engine_version: string;
  database_version: string;
  database_updated_at: Date;
}
function execute(config: FileConfig, args: string[], input?: string, signal?: AbortSignal): Promise<{code: number | null; output: string; failed: boolean}> {
  signal?.throwIfAborted();
  const { promise, resolve } = Promise.withResolvers<{code: number | null; output: string; failed: boolean}>();
  const child = spawn(config.scanner, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let bytes = 0; let failed = false;
  const cancel = () => { failed = true; child.kill('SIGKILL'); };
  signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)cancel();
  const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, config.timeout);
  const collect = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 65536) { failed = true; child.kill('SIGKILL'); }
    else output += chunk.toString('utf8');
  };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  child.stdin.on('error', () => { failed = true; });
  child.on('error', () => { failed = true; });
  child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort',cancel); resolve({ code, output, failed }); });
  child.stdin.end(input);
  return promise.then(result=>{signal?.throwIfAborted();return result;});
}
const limits = ['--stdout', '--no-summary', '--infected', '--alert-exceeds-max=yes',
  '--max-filesize=10M', '--max-scansize=50M', '--max-recursion=16', '--max-files=1000'];
function metadata(output: string, maxAgeHours: number): ScannerHealth {
  const match = /^ClamAV ([^/\r\n]+)\/(\d+)\/([^\r\n]+)$/m.exec(output.trim());
  if (!match) throw new Error('ClamAV未返回可核验的引擎及签名库版本');
  const updated = new Date(match[3]);
  const age = Date.now() - updated.getTime();
  if (!Number.isFinite(age) || age < -300000 || age > maxAgeHours * 3600000) throw new Error('ClamAV签名库更新时间无效或已过期');
  return { engine_version: match[1], database_version: match[2], database_updated_at: updated };
}
async function verifyScanner(config: FileConfig, context: CheckContext = {}, load = true): Promise<ScannerHealth> {
  context.signal?.throwIfAborted();
  // Only official containers are accepted. Their existence is not proof of validity:
  // clamscan must actually load and verify them below, not merely print a header.
  for (const name of ['main', 'daily']) {
    let count = 0;
    for (const suffix of ['cvd', 'cld']) {
      try {
        const info = await lstat(path.join(config.database, `${name}.${suffix}`));
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('病毒库必须为常规文件');
        count++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (count !== 1) throw new Error('必须安装唯一的官方main和daily病毒库容器');
  }
  const db = [`--database=${config.database}`, '--official-db-only=yes'];
  const version = await checkStep(context,'scanner.version',()=>execute(config,['--version',...db],undefined,context.signal));
  if (version.failed || version.code !== 0) throw new Error('ClamAV引擎或病毒库未就绪');
  const health = metadata(version.output, config.databaseMaxAgeHours);
  if (load) {
  const clean = await checkStep(context,'scanner.load',()=>execute(config,[...limits,...db,'-'],'KnowLadder scanner readiness probe\n',context.signal));
  if (clean.failed || clean.code !== 0) throw new Error('ClamAV无法真实加载签名库');
  }
  const after = await checkStep(context,'scanner.recheck',()=>execute(config,['--version',...db],undefined,context.signal));
  if (after.failed || after.code !== 0 || after.output !== version.output) throw new Error('验证期间签名库发生变化，请重试');
  metadata(after.output, config.databaseMaxAgeHours);
  return health;
}
export async function assertScanner(context: CheckContext = {}): Promise<ScannerHealth> {
  assertFileScanEnabled();
  return verifyScanner(fileConfig(),context);
}
/** Development preflight only; actual worker readiness still loads the full official database. */
export async function assertScannerMetadata(context: CheckContext = {}): Promise<ScannerHealth> {
  assertFileScanEnabled();
  return verifyScanner(fileConfig(), context, false);
}
export async function scanWithHealth(filename: string): Promise<{ result: ScanResult; health?: ScannerHealth }> {
  assertFileScanEnabled();
  let stage = 'file';
  const failed = (code: number | null = null) => {
    console.warn(JSON.stringify({ event: 'file.scanner.failed', stage, exit_code: code }));
    return { result: 'failed' as const };
  };
  try {
    const config = fileConfig();
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_FILE_SIZE) return failed();
    stage = 'health';
    const health = await verifyScanner(config, {}, process.env.NODE_ENV === "production");
    stage = 'scan';
    const result = await execute(config, [...limits, `--database=${config.database}`, '--official-db-only=yes', '--', filename]);
    if (result.failed || (result.code !== 0 && result.code !== 1)) return failed(result.code);
    stage = 'database-stability';
    const version = await execute(config, ['--version', `--database=${config.database}`]);
    if (version.failed || version.code !== 0) return failed(version.code);
    const after = metadata(version.output, config.databaseMaxAgeHours);
    if (after.engine_version !== health.engine_version || after.database_version !== health.database_version || after.database_updated_at.getTime() !== health.database_updated_at.getTime()) return failed();
    return { result: result.code === 0 ? 'clean' : 'infected', health: after };
  } catch {
    return failed();
  }
}
