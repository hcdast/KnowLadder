'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { parseEnv } = require('node:util');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

const ROOT = path.resolve(__dirname, '..');
const DOC = path.join(ROOT, 'docs/UIUX设计方案.md');
const OUTPUT = path.join(ROOT, 'web/public/website');
const CACHE = path.join(__dirname, '.cache');
const BASE = 'https://maas-fat.akool.io';
const LOCAL_FFMPEG = path.join(ROOT, 'ops/artifacts/site-media-tools/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe');
const MODELS = { image: 'google/nano-banana-2.1/text-to-image', video: 'kwaivgi/kling-v4.0/text-to-video' };
const NAME = /^[a-z0-9][a-z0-9.-]*\.(?:png|webp|mp4|vtt|txt)$/;
function check(value, code) { if (!value) throw new Error(code); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }

// Ignore escaped pipes and pipes inside inline code when splitting Markdown cells.
function cells(line) {
  const cuts = []; let ticks = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '`') {
      let width = 1;
      while (line[i + width] === '`') width++;
      if (!ticks) ticks = width; else if (ticks === width) ticks = 0;
      i += width - 1;
    } else if (line[i] === '|' && !ticks) cuts.push(i);
  }
  check(cuts.length >= 2 && !line.slice(0, cuts[0]).trim() && !line.slice(cuts.at(-1) + 1).trim(), 'CATALOG_ROW_INVALID');
  return cuts.slice(0, -1).map((cut, i) => line.slice(cut + 1, cuts[i + 1]).trim());
}

function parseCatalog(markdown) {
  const section = markdown.match(/^### 34\.7\b[^\n]*\n([\s\S]*?)(?=^#{1,3} |$(?![\s\S]))/m)?.[1];
  check(section, 'CATALOG_SECTION_MISSING');
  const lines = section.split(/\r?\n/);
  const header = lines.findIndex(line => /^\| 编号／素材 \| 文件名 \|/.test(line));
  check(header >= 0 && cells(lines[header]).length === 6 && cells(lines[header])[5] === 'S3资源链接', 'CATALOG_HEADER_INVALID');
  const rows = []; const ids = new Set();
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    const row = cells(line); check(row.length === 6, 'CATALOG_COLUMNS_INVALID');
    const id = row[0].replace(/\*/g, '').match(/^([A-Z]\d{2}(?:-[A-Z])?)(?:\s|$)/)?.[1];
    check(id && !ids.has(id), 'CATALOG_ID_INVALID'); ids.add(id);
    const files = []; let previous = 0;
    for (const match of row[1].matchAll(/`([^`]+)`/g)) {
      const role = row[1].slice(previous, match.index).split(/[；;]/).at(-1);
      previous = match.index + match[0].length;
      check(NAME.test(match[1]), 'CATALOG_FILENAME_INVALID');
      files.push({ name: match[1], role: /首帧复用/.test(role) ? 'reference' : /原稿|母版/.test(role) ? 'master' : /网站|剪辑镜头/.test(role) ? 'web' : 'support' });
    }
    check(files.length, 'CATALOG_FILES_MISSING');
    const linked = /\]\(https?:\/\/[^\s)]+\)/.test(row[5]);
    let kind;
    if (/类型／优先级：AI视频镜头/.test(row[2])) kind = 'video';
    else if (/类型／优先级：图片/.test(row[2])) kind = 'image';
    else if (/真实截图/.test(row[2]) || /真实录屏/.test(row[2])) kind = 'capture';
    else if (files.every(file => /\.(vtt|txt)$/.test(file.name))) kind = 'text';
    else kind = 'postprocess';
    rows.push({ id, label: row[0].replace(/\*/g, ''), files, specification: row[2], description: row[3], constraints: row[4], linked, kind });
  }
  check(rows.length, 'CATALOG_EMPTY'); return rows;
}

function requestFor(item) {
  check(['image', 'video'].includes(item.kind), 'NOT_GENERATIVE');
  const aspect = item.specification.match(/\b(\d{1,2}:\d{1,2})\b/)?.[1];
  const prompt = `${item.description}\n\n画面约束与后期要求：${item.constraints}`;
  check(prompt.length <= 5000, 'PROMPT_TOO_LONG');
  if (item.kind === 'video') {
    check(['16:9', '9:16', '1:1', '21:9'].includes(aspect), 'VIDEO_ASPECT_UNSUPPORTED');
    const duration = item.specification.match(/(?:，|；|\s)(\d+)秒/)?.[1];
    check(duration && +duration >= 3 && +duration <= 30, 'VIDEO_DURATION_INVALID');
    return { model: MODELS.video, input: { prompt, resolution: '1080p', duration, aspect_ratio: aspect } };
  }
  check(['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '21:9'].includes(aspect), 'IMAGE_ASPECT_UNSUPPORTED');
  return { model: MODELS.image, input: { prompt, aspect_ratio: aspect, resolution: '2k', thinking_level: 'high', enable_web_search: false, enable_image_search: false } };
}

function buildPlan(items, only = []) {
  check(only.every(id => items.some(item => item.id === id)), 'UNKNOWN_MATERIAL_ID');
  return items.filter(item => !only.length || only.includes(item.id)).map(item => {
    let reason;
    if (item.linked) reason = '资源列已有链接，跳过整行';
    else if (item.kind === 'capture') reason = '需要真实界面截图或录屏，不用AI生成';
    else if (item.kind === 'text') reason = '字幕/文字稿须与最终成片对照制作';
    else if (item.kind === 'postprocess') reason = '需要已选成片拼接或提帧，不重复调用模型';
    const plan = { ...item, action: reason ? 'skip' : 'generate', reason };
    if (!reason) plan.request = requestFor(item);
    return plan;
  });
}

async function regularPath(filename, allowMissing = false) {
  const absolute = path.resolve(filename); const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(error => { if (allowMissing && error.code === 'ENOENT') return null; throw error; });
    if (!stat) break;
    check(!stat.isSymbolicLink() && (stat.isDirectory() || (current === absolute && stat.isFile() && stat.nlink === 1)), 'UNSAFE_LOCAL_PATH');
  }
}
async function readJson(filename) {
  await regularPath(filename, true);
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function saveJson(filename, value) {
  await regularPath(filename, true);
  const tmp = `${filename}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { flag: 'wx' });
  await fs.rename(tmp, filename);
}
function safeCode(error) {
  return /^[A-Z][A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'MEDIA_OPERATION_FAILED';
}

async function apiJson(apiPath, { apiKey, input, fetcher = fetch }) {
  let response;
  try {
    response = await fetcher(`${BASE}${apiPath}`, { method: input ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${apiKey}`, ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify({ input }) } : {}) });
  } catch { throw new Error('MAAS_NETWORK_ERROR'); }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`MAAS_HTTP_${response.status}`); }
  const length = Number(response.headers.get('content-length'));
  check(!length || length <= 1024 * 1024, 'MAAS_RESPONSE_TOO_LARGE');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; check(size <= 1024 * 1024, 'MAAS_RESPONSE_TOO_LARGE'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('MAAS_RESPONSE_INVALID'); }
}

async function pollTask(uuid, options) {
  const { timeoutMs = 30 * 60 * 1000, intervalMs = 5000, query = id => apiJson(`/api/v1/run/tasks/${encodeURIComponent(id)}`, options), pause = sleep, now = Date.now } = options;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    let task;
    try { task = await query(uuid); } catch (error) {
      if (!/^MAAS_(?:NETWORK_ERROR|HTTP_(?:429|5\d\d))$/.test(error.message)) throw error;
      await pause(intervalMs); continue;
    }
    check(task.task_uuid === uuid, 'TASK_UUID_MISMATCH');
    if (task.status === 'completed') return task;
    if (['failed', 'cancelled'].includes(task.status)) throw new Error(`TASK_${task.status.toUpperCase()}`);
    check(['pending', 'processing'].includes(task.status), 'TASK_STATUS_UNKNOWN');
    await pause(intervalMs);
  }
  throw new Error('TASK_POLL_TIMEOUT');
}

function resultUrl(output, kind) {
  const list = kind === 'video' ? output?.videos : output?.images;
  const value = Array.isArray(list) && list.length ? (typeof list[0] === 'string' ? list[0] : list[0]?.url) : output?.[`${kind}_url`];
  check(typeof value === 'string', 'TASK_OUTPUT_MISSING');
  let url; try { url = new URL(value); } catch { throw new Error('TASK_OUTPUT_URL_INVALID'); }
  check(url.protocol === 'https:' && !url.username && !url.password, 'TASK_OUTPUT_URL_INVALID');
  return url.href;
}

function validateMagic(bytes, kind) {
  const text = bytes.toString('ascii');
  if (kind === 'video') check(bytes.length >= 16 && text.slice(4, 8) === 'ftyp', 'DOWNLOAD_FORMAT_INVALID');
  else check(bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) || (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP'), 'DOWNLOAD_FORMAT_INVALID');
}
async function download(url, destination, kind, { fetcher = fetch, maxBytes = 512 * 1024 * 1024 } = {}) {
  // Intentionally no Authorization header on media/CDN requests, including redirects.
  const response = await fetcher(url, { signal: AbortSignal.timeout(5 * 60 * 1000) });
  check(response.ok, 'DOWNLOAD_HTTP_ERROR');
  check(!+response.headers.get('content-length') || +response.headers.get('content-length') <= maxBytes, 'DOWNLOAD_TOO_LARGE');
  const handle = await fs.open(destination, 'wx'); let size = 0; let prefix = Buffer.alloc(0);
  try {
    for await (const chunk of response.body) {
      size += chunk.length; check(size <= maxBytes, 'DOWNLOAD_TOO_LARGE');
      if (prefix.length < 64) prefix = Buffer.concat([prefix, chunk]).subarray(0, 64);
      await handle.writeFile(chunk);
    }
    check(size > 0, 'DOWNLOAD_EMPTY'); validateMagic(prefix, kind);
  } catch (error) { await handle.close(); await fs.rm(destination, { force: true }); throw error; }
  await handle.close();
}

async function command(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', () => reject(new Error('FFMPEG_UNAVAILABLE')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('FFMPEG_FAILED')));
  });
}
async function fileProof(filename) {
  await regularPath(filename);
  const hash = createHash('sha256'); let bytes = 0;
  const handle = await fs.open(filename, 'r');
  try { for await (const chunk of handle.createReadStream()) { hash.update(chunk); bytes += chunk.length; } } finally { await handle.close(); }
  return { bytes, sha256: hash.digest('hex') };
}

async function deliver(item, source, ffmpeg, outputDir = OUTPUT, workDir = CACHE) {
  const files = item.files.filter(file => file.role !== 'reference');
  const dimensions = item.specification.match(/(\d{3,4})[×x](\d{3,4})/);
  check(dimensions, 'MATERIAL_DIMENSIONS_MISSING');
  const [width, height] = dimensions.slice(1).map(Number);
  const scale = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const proofs = [];
  for (const file of files) {
    check(NAME.test(file.name), 'CATALOG_FILENAME_INVALID');
    const destination = path.join(outputDir, file.name);
    await regularPath(destination, true);
    const temporary = path.join(workDir, `${randomUUID()}-${file.name}`);
    try {
      const args = ['-hide_banner', '-loglevel', 'error', '-n', '-i', source];
      if (file.name.endsWith('.mp4')) args.push('-map', '0:v:0', '-an', '-vf', `${scale},fps=24`, '-t', item.request.input.duration, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', file.role === 'master' ? '16' : '23', '-movflags', '+faststart');
      else args.push('-frames:v', '1', '-vf', scale, ...(file.name.endsWith('.webp') ? ['-c:v', 'libwebp', '-quality', '85'] : ['-c:v', 'png']));
      await command(ffmpeg, [...args, temporary]);
      await fs.copyFile(temporary, destination, require('node:fs').constants.COPYFILE_EXCL);
      proofs.push({ name: file.name, ...await fileProof(destination) });
    } finally { await fs.rm(temporary, { force: true }); }
  }
  return proofs;
}

async function runItem(item, options) {
  const { apiKey, ffmpeg, receiptDir = CACHE, outputDir = OUTPUT, submit = request => apiJson(`/api/v1/run/${encodeURIComponent(request.model)}`, { apiKey, input: request.input }), poll = uuid => pollTask(uuid, { apiKey }), transfer = download, convert = deliver, log = console.log } = options;
  const fingerprint = digest(JSON.stringify({ id: item.id, request: item.request, files: item.files }));
  const receiptFile = path.join(receiptDir, `${item.id}-${fingerprint.slice(0, 16)}.json`);
  const source = path.join(receiptDir, `${item.id}-${fingerprint.slice(0, 16)}.source`);
  let receipt = await readJson(receiptFile);
  if (receipt) check(receipt.fingerprint === fingerprint && receipt.model === item.request.model, 'RECEIPT_SCOPE_MISMATCH');
  if (receipt?.state === 'downloaded') {
    check(Array.isArray(receipt.files) && receipt.files.length === item.files.filter(file => file.role !== 'reference').length, 'RECEIPT_FILES_INVALID');
    check(new Set(receipt.files.map(file => file.name)).size === receipt.files.length, 'RECEIPT_FILES_INVALID');
    for (const file of receipt.files) {
      check(item.files.some(expected => expected.name === file.name && expected.role !== 'reference'), 'RECEIPT_FILES_INVALID');
      check(digest(JSON.stringify(await fileProof(path.join(outputDir, file.name)))) === digest(JSON.stringify({ bytes: file.bytes, sha256: file.sha256 })), 'LOCAL_FILE_CHANGED');
    }
    log(`${item.id}: downloaded（本地hash已核对）`); return receipt;
  }
  check(!receipt || !['failed', 'cancelled', 'submitting'].includes(receipt.state), 'TASK_REQUIRES_RECONCILIATION');
  if (receipt) check(['submitted', 'generated'].includes(receipt.state) && /^[a-zA-Z0-9_-]{1,128}$/.test(receipt.task_uuid || ''), 'RECEIPT_TASK_INVALID');
  // Refuse existing files instead of overwriting an interrupted/previous manual delivery.
  for (const file of item.files.filter(file => file.role !== 'reference')) {
    await regularPath(path.join(outputDir, file.name), true);
    const exists = await fs.lstat(path.join(outputDir, file.name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    check(!exists, 'OUTPUT_EXISTS_REQUIRES_RECONCILIATION');
  }
  if (!receipt) {
    receipt = { version: 1, id: item.id, model: item.request.model, fingerprint, state: 'submitting', createdAt: new Date().toISOString() };
    await saveJson(receiptFile, receipt); // An ambiguous POST must never be retried automatically.
    const task = await submit(item.request);
    check(typeof task.task_uuid === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(task.task_uuid), 'SUBMIT_TASK_INVALID');
    receipt.task_uuid = task.task_uuid; receipt.state = 'submitted';
    await saveJson(receiptFile, receipt);
  }
  if (receipt.state === 'generated') {
    check(JSON.stringify(await fileProof(source)) === JSON.stringify(receipt.source), 'LOCAL_SOURCE_CHANGED');
  } else {
    log(`${item.id}: ${receipt.state}，查询任务状态`);
    let task;
    try { task = await poll(receipt.task_uuid); } catch (error) {
      if (['TASK_FAILED', 'TASK_CANCELLED'].includes(error.message)) { receipt.state = error.message === 'TASK_FAILED' ? 'failed' : 'cancelled'; await saveJson(receiptFile, receipt); }
      throw error;
    }
    check(task.model_id === item.request.model, 'TASK_MODEL_MISMATCH');
    await regularPath(source, true);
    await fs.rm(source, { force: true });
    await transfer(resultUrl(task.output, item.kind), source, item.kind);
    receipt.state = 'generated'; receipt.source = await fileProof(source);
    await saveJson(receiptFile, receipt);
  }
  receipt.files = await convert(item, source, ffmpeg, outputDir, receiptDir);
  receipt.state = 'downloaded'; receipt.completedAt = new Date().toISOString();
  await saveJson(receiptFile, receipt);
  log(`${item.id}: downloaded，${receipt.files.map(file => file.name).join(', ')}`);
  return receipt;
}

async function main(args = process.argv.slice(2)) {
  let run = false, envFile = path.join(__dirname, '.env'), only = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--run') run = true;
    else if (args[index] === '--env') { check(args[index + 1], 'CLI_VALUE_MISSING'); envFile = path.resolve(args[++index]); }
    else if (args[index] === '--only') { check(args[index + 1], 'CLI_VALUE_MISSING'); only = args[++index].split(','); }
    else throw new Error('CLI_ARGUMENT_INVALID');
  }
  const plan = buildPlan(parseCatalog(await fs.readFile(DOC, 'utf8')), only);
  if (!run) {
    console.log(JSON.stringify({ output: OUTPUT, total: plan.length, generate: plan.filter(item => item.action === 'generate').length, rows: plan.map(({ id, kind, linked, action, reason, files, request }) => ({ id, kind, linked, action, reason, files, model: request?.model })) }, null, 2));
    return;
  }
  const pending = plan.filter(item => item.action === 'generate');
  if (!pending.length) { console.log('没有可调用模型的缺链接素材。'); return; }
  await regularPath(envFile, true);
  const env = { ...parseEnv(await fs.readFile(envFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })), ...process.env };
  check(env.MAAS_API_KEY?.trim(), 'MAAS_API_KEY_MISSING');
  const ffmpeg = env.FFMPEG_BIN || (await fs.stat(LOCAL_FFMPEG).catch(() => null) ? LOCAL_FFMPEG : 'ffmpeg');
  await command(ffmpeg, ['-version']); // Fail before a potentially billable submission.
  await regularPath(CACHE, true); await fs.mkdir(CACHE, { recursive: true });
  await regularPath(OUTPUT, true); await fs.mkdir(OUTPUT, { recursive: true });
  const lockFile = path.join(CACHE, 'generation.lock');
  const lock = await fs.open(lockFile, 'wx').catch(error => { if (error.code === 'EEXIST') throw new Error('GENERATION_ALREADY_LOCKED'); throw error; });
  let failures = 0;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    for (const item of pending) {
      try { await runItem(item, { apiKey: env.MAAS_API_KEY.trim(), ffmpeg }); }
      catch (error) { failures++; console.error(`${item.id}: ${safeCode(error)}`); }
    }
  } finally { await lock.close(); await fs.rm(lockFile, { force: true }); }
  check(!failures, 'GENERATION_INCOMPLETE');
}

module.exports = { cells, parseCatalog, requestFor, buildPlan, apiJson, pollTask, resultUrl, validateMagic, download, runItem, main };
if (require.main === module) main().catch(error => { console.error(safeCode(error)); process.exitCode = 1; });
