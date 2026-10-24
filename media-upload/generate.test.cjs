'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const generator = require('./generate.cjs');
const ROOT = path.resolve(__dirname, '..');
const FFMPEG = process.env.TEST_FFMPEG_BIN || path.join(ROOT, 'ops/artifacts/site-media-tools/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe');
const load = async () => generator.parseCatalog(await fs.readFile(path.join(ROOT, 'docs/UIUX设计方案.md'), 'utf8'));
const silent = () => {};
async function temp(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kl-media-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
function mp4() { return Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom00000000isom')]); }
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('actual table: 36 linked rows skip generation after CDN delivery', async () => {
  const items = await load(); const plan = generator.buildPlan(items);
  assert.equal(items.length, 36); assert.equal(items.filter(item => item.linked).length, 36);
  assert.ok(plan.every(item => item.action === 'skip' && !item.request));
});
test('unlinked video fixture: only 4 independent AI calls, capture and postprocessing remain separate', async () => {
  const items = (await load()).map(item => ({ ...item, linked: item.kind === 'image' }));
  const plan = generator.buildPlan(items);
  assert.deepEqual(plan.filter(item => item.action === 'generate').map(item => item.id), ['V01-A', 'V01-B', 'V01-C', 'V02']);
  assert.equal(plan.filter(item => !item.linked && item.kind === 'capture').length, 5);
  assert.equal(plan.filter(item => !item.linked && item.kind === 'postprocess').length, 4);
  assert.equal(plan.filter(item => !item.linked && item.kind === 'text').length, 5);
  const ai = plan.find(item => item.id === 'V02');
  assert.equal(ai.files.at(-1).role, 'reference');
  assert.equal(ai.request.input.duration, '5'); assert.equal(ai.request.input.resolution, '1080p');
  assert.ok(ai.request.input.prompt.includes(ai.constraints));
});
test('unknown material selectors and malformed Markdown fail before requests', async () => {
  assert.throws(() => generator.buildPlan([], ['V99']), /UNKNOWN_MATERIAL_ID/);
  const original = await fs.readFile(path.join(ROOT, 'docs/UIUX设计方案.md'), 'utf8');
  assert.throws(() => generator.parseCatalog(original.replace('`h01-hero-lifelong-desktop-master.png`', '`../escape.png`')), /CATALOG_FILENAME_INVALID/);
  assert.throws(() => generator.parseCatalog(original.replace('**H01-M 手机', '**H01-D 手机')), /CATALOG_ID_INVALID/);
  assert.equal(generator.cells('| a | `b|c` | d\\|e |').length, 3);
});
test('image request is selected when an AI image row has no resource link', async () => {
  const items = await load(); const item = { ...items.find(row => row.id === 'S01'), linked: false };
  const [plan] = generator.buildPlan([item]);
  assert.equal(plan.request.model, 'google/nano-banana-2.1/text-to-image');
  assert.equal(plan.request.input.aspect_ratio, '4:3'); assert.equal(plan.request.input.enable_web_search, false);
  assert.throws(() => generator.requestFor({ ...item, specification: '16:10，2400×1500' }), /IMAGE_ASPECT_UNSUPPORTED/);
});
test('API submits encoded model endpoint with Bearer auth and input envelope', async () => {
  let seen;
  const data = await generator.apiJson('/api/v1/run/google%2Fnano-banana-2.1%2Ftext-to-image', {
    apiKey: 'fixture-only', input: { prompt: 'demo' }, fetcher: async (url, options) => { seen = { url, options }; return response({ task_uuid: 'task1', status: 'pending' }); },
  });
  assert.equal(data.task_uuid, 'task1'); assert.equal(seen.options.headers.Authorization, 'Bearer fixture-only');
  assert.equal(seen.options.method, 'POST'); assert.equal(seen.options.redirect, 'error');
  assert.deepEqual(JSON.parse(seen.options.body), { input: { prompt: 'demo' } });
  assert.ok(seen.url.startsWith('https://maas-fat.akool.io/api/v1/run/'));
});
test('API error bodies and keys are not included in errors', async () => {
  await assert.rejects(generator.apiJson('/api/v1/run/tasks/x', { apiKey: 'fixture-only', fetcher: async () => response({ secret: 'should-not-appear' }, 401) }), /^Error: MAAS_HTTP_401$/);
});
test('poll pending -> processing -> completed; task identity checked', async () => {
  const states = ['pending', 'processing', 'completed']; let count = 0;
  const task = await generator.pollTask('x', { query: async () => ({ task_uuid: 'x', status: states[count++] }), pause: async () => {} });
  assert.equal(count, 3); assert.equal(task.status, 'completed');
  await assert.rejects(generator.pollTask('x', { query: async () => ({ task_uuid: 'y', status: 'completed' }) }), /TASK_UUID_MISMATCH/);
});
for (const state of ['failed', 'cancelled', 'unknown']) test(`poll stops immediately on ${state}`, async () => {
  let count = 0;
  await assert.rejects(generator.pollTask('x', { query: async () => { count++; return { task_uuid: 'x', status: state }; }, pause: async () => assert.fail('must not continue polling') }), state === 'unknown' ? /TASK_STATUS_UNKNOWN/ : new RegExp(`TASK_${state.toUpperCase()}`));
  assert.equal(count, 1);
});
test('transient polling errors retry; deadline retains resumable task', async () => {
  let count = 0;
  await generator.pollTask('x', { query: async () => { if (++count === 1) throw Error('MAAS_HTTP_503'); return { task_uuid: 'x', status: 'completed' }; }, pause: async () => {} });
  assert.equal(count, 2); let time = 0;
  await assert.rejects(generator.pollTask('x', { timeoutMs: 10, now: () => time, query: async () => ({ task_uuid: 'x', status: 'pending' }), pause: async () => { time = 11; } }), /TASK_POLL_TIMEOUT/);
});
test('model output arrays and URL fallback handled without filename guessing', () => {
  assert.equal(generator.resultUrl({ videos: ['https://example.test/v.mp4'] }, 'video'), 'https://example.test/v.mp4');
  assert.equal(generator.resultUrl({ images: [{ url: 'https://example.test/i.png' }] }, 'image'), 'https://example.test/i.png');
  assert.equal(generator.resultUrl({ video_url: 'https://example.test/v.mp4' }, 'video'), 'https://example.test/v.mp4');
  assert.throws(() => generator.resultUrl({ videos: ['http://example.test/v.mp4'] }, 'video'), /URL_INVALID/);
  assert.throws(() => generator.resultUrl({ videos: [] }, 'video'), /OUTPUT_MISSING/);
});
test('streamed downloads use no API credentials; invalid media removed', async t => {
  const dir = await temp(t); const target = path.join(dir, 'video.source'); let opts;
  await generator.download('https://example.test/v.mp4', target, 'video', { fetcher: async (_, options) => { opts = options; return new Response(mp4()); } });
  assert.equal(opts.headers, undefined); assert.deepEqual(await fs.readFile(target), mp4());
  const bad = path.join(dir, 'bad.source');
  await assert.rejects(generator.download('https://example.test/v.mp4', bad, 'video', { fetcher: async () => new Response('<html>login</html>') }), /FORMAT_INVALID/);
  await assert.rejects(fs.stat(bad), { code: 'ENOENT' });
  await assert.rejects(generator.download('https://example.test/v.mp4', bad, 'video', { maxBytes: 2, fetcher: async () => new Response(mp4()) }), /TOO_LARGE/);
});

async function fixture(t) {
  const dir = await temp(t); const outputDir = path.join(dir, 'output'); await fs.mkdir(outputDir);
  const base = (await load()).find(row => row.id === 'V01-A');
  const [item] = generator.buildPlan([{ ...base, linked: false }]);
  let submits = 0, polls = 0;
  const options = {
    receiptDir: dir, outputDir, apiKey: 'fixture-only', log: silent,
    submit: async () => { submits++; return { task_uuid: 'test-task', status: 'pending' }; },
    poll: async () => { polls++; return { task_uuid: 'test-task', model_id: item.request.model, status: 'completed', output: { videos: ['https://example.test/result.mp4'] } }; },
    transfer: async (_, destination) => fs.writeFile(destination, mp4()),
    convert: async () => item.files.filter(file => file.role !== 'reference').map(file => ({ name: file.name, bytes: 1, sha256: 'mock' })),
  };
  return { dir, item, options, counts: () => ({ submits, polls }) };
}
test('interrupted polling resumes UUID without resubmission', async t => {
  const f = await fixture(t);
  await assert.rejects(generator.runItem(f.item, { ...f.options, poll: async () => { throw Error('TASK_POLL_TIMEOUT'); } }), /TIMEOUT/);
  await generator.runItem(f.item, f.options);
  assert.equal(f.counts().submits, 1); assert.equal(f.counts().polls, 1);
});
test('ambiguous submission is persisted and never retried automatically', async t => {
  const f = await fixture(t);
  await assert.rejects(generator.runItem(f.item, { ...f.options, submit: async () => { throw Error('MAAS_NETWORK_ERROR'); } }), /NETWORK_ERROR/);
  await assert.rejects(generator.runItem(f.item, f.options), /RECONCILIATION/);
  assert.equal(f.counts().submits, 0);
});
test('failed provider task is terminal across repeated runs', async t => {
  const f = await fixture(t);
  await assert.rejects(generator.runItem(f.item, { ...f.options, poll: async () => { throw Error('TASK_FAILED'); } }), /TASK_FAILED/);
  await assert.rejects(generator.runItem(f.item, f.options), /RECONCILIATION/);
  assert.equal(f.counts().submits, 1);
});
test('existing local files refuse generation before a billable call', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.options.outputDir, f.item.files[0].name), 'user-owned');
  await assert.rejects(generator.runItem(f.item, f.options), /OUTPUT_EXISTS/);
  assert.equal(f.counts().submits, 0);
});
test('wrong provider model is rejected before downloading', async t => {
  const f = await fixture(t);
  await assert.rejects(generator.runItem(f.item, { ...f.options, poll: async () => ({ model_id: 'unexpected', output: {} }) }), /MODEL_MISMATCH/);
});
test('downloaded source survives conversion failure and resumes without expired remote URL', async t => {
  const f = await fixture(t);
  await assert.rejects(generator.runItem(f.item, { ...f.options, convert: async () => { throw Error('FFMPEG_FAILED'); } }), /FFMPEG_FAILED/);
  await generator.runItem(f.item, { ...f.options, transfer: async () => assert.fail('must reuse verified source') });
  assert.equal(f.counts().submits, 1); assert.equal(f.counts().polls, 1);
});
test('real FFmpeg end-to-end delivery, exact filenames, decode, hash skip and tamper rejection', async t => {
  assert.ok(await fs.stat(FFMPEG), 'Set TEST_FFMPEG_BIN to an installed FFmpeg');
  const f = await fixture(t); const source = path.join(f.dir, 'fixture.mp4');
  // Original synthetic low-resolution footage, never saved in the website directory.
  const made = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=24:d=5', '-an', '-c:v', 'libx264', source], { windowsHide: true });
  assert.equal(made.status, 0, made.stderr?.toString());
  const options = { ...f.options, ffmpeg: FFMPEG, transfer: async (_, destination) => fs.copyFile(source, destination) };
  delete options.convert;
  const result = await generator.runItem(f.item, options);
  assert.equal(result.state, 'downloaded'); assert.equal(result.files.length, 3);
  for (const file of result.files) {
    assert.ok(file.bytes > 0); assert.match(file.sha256, /^[a-f0-9]{64}$/);
    const decoded = spawnSync(FFMPEG, ['-v', 'error', '-i', path.join(options.outputDir, file.name), '-f', 'null', '-'], { windowsHide: true });
    assert.equal(decoded.status, 0, decoded.stderr?.toString());
  }
  await generator.runItem(f.item, options); assert.equal(f.counts().submits, 1); assert.equal(f.counts().polls, 1);
  await fs.appendFile(path.join(options.outputDir, result.files[0].name), 'changed');
  await assert.rejects(generator.runItem(f.item, options), /LOCAL_FILE_CHANGED/);
});
test('real image delivery encodes actual PNG and WebP instead of renaming source bytes', async t => {
  const f = await fixture(t);
  const base = (await load()).find(row => row.id === 'S01');
  const [item] = generator.buildPlan([{ ...base, linked: false }]);
  const source = path.join(f.dir, 'image.jpg');
  const made = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=160x120', '-frames:v', '1', source], { windowsHide: true });
  assert.equal(made.status, 0, made.stderr?.toString());
  const options = { ...f.options, ffmpeg: FFMPEG, poll: async () => ({ model_id: item.request.model, output: { images: ['https://example.test/source.jpg'] } }), transfer: async (_, destination) => fs.copyFile(source, destination) };
  delete options.convert;
  const result = await generator.runItem(item, options);
  assert.equal(result.files.length, 2);
  const png = await fs.readFile(path.join(options.outputDir, result.files[0].name));
  const webp = await fs.readFile(path.join(options.outputDir, result.files[1].name));
  assert.equal(png.readUInt32BE(16), 1600); assert.equal(png.readUInt32BE(20), 1200);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(webp.subarray(0, 4).toString(), 'RIFF'); assert.equal(webp.subarray(8, 12).toString(), 'WEBP');
});
