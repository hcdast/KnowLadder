'use strict';
// Local, disposable actual App + Mongo fixture for website captures. No .env or real accounts.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const serverRequire = createRequire(path.join(root, 'server/package.json'));
const { MongoMemoryReplSet } = serverRequire('mongodb-memory-server-core');
const { studioFixture } = require('../server/test/studio-fixture.cjs');
const { status } = require('../server/test/helpers.cjs');
const work = path.join(__dirname, '.cache/capture-287');
const control = path.join(work, 'control.json');
const evidence = path.join(work, 'http.json');
const origin = 'http://localhost:5197';

(async () => {
  let rs, fixture, vite, actor = 'learner';
  const cleanups = [], calls = [];
  try {
    fs.mkdirSync(work, { recursive: true }); fs.writeFileSync(control, '{}');
    rs = await MongoMemoryReplSet.create({ binary: { version: '8.0.17', systemBinary: path.join(require('node:os').homedir(), '.cache/mongodb-binaries/mongod-x64-win32-8.0.17.exe') }, replSet: { count: 1, storageEngine: 'wiredTiger' }, instanceOpts: [{ args: ['--wiredTigerCacheSizeGB', '0.25'] }] });
    process.env.TEST_MONGODB_URI = rs.getUri('kl_test_media_capture_287');
    console.log('MEDIA_CAPTURE_STEP fixture');
    fixture = await studioFixture({ after: callback => cleanups.push(callback) }, { KL_LIFELONG_ENABLED: 'true' });
    const f = fixture;
    const actors = { learner: f.student, teacher: f.author, reviewer: f.reviewer };
    for (const [name, person] of Object.entries(actors)) await f.db.collection('users').updateOne({ _id: person.user.user_id }, { $set: { display_name: { learner: '示例学习者', teacher: '示例教师', reviewer: '独立审核员' }[name] } });
    await f.db.collection('organizations').updateOne({ _id: f.org }, { $set: { name: '终身学习示例空间' } });
    await f.db.collection('classes').updateOne({ _id: f.classId }, { $set: { name: '观察与表达共学班' } });
    await f.db.collection('subjects').updateOne({ _id: f.subject }, { $set: { name: '观察与表达' } });
    const personal = async (url, body) => {
      const response = await f.student.browser.request(`/personal${url}`, { method: body === undefined ? 'GET' : 'POST', body, headers: { 'Idempotency-Key': randomUUID() } });
      if (response.status !== 200) console.error('MEDIA_CAPTURE_API', url, response.status, response.data?.error?.code);
      status(response, 200); return response.data.data;
    };
    await personal('/courses/work-improvement/enroll', { version: 1 });
    const today = new Date().toISOString().slice(0, 10);
    const note = await personal('/study-items', { title: '把观察写成有依据的记录', note: '先写看到了什么，再区分自己的判断；复盘时补充观察条件。', bookmarked: true, course_id: null, course_version: null, unit_id: null, due_on: today });
    await personal(`/study-items/${note.resource_id}/review`, { revision: 1, answer: null, reviewed_on: today, next_due_on: new Date(Date.now() + 86400000).toISOString().slice(0, 10), note: '回看后补充了时间、地点与证据。' });
    await personal('/agenda', { title: '继续学习：把一次工作交接写清楚', note: '读完第一单元，完成练习与实践回顾。', kind: 'course', scheduled_on: today, planned_minutes: 20, source_kind: 'none', source_id: null, source_version: null, unit_id: null });
    const question = await f.question();
    await f.good(f.author, `/studio/questions/${question._id}/actions`, { action: 'reply', expected_revision: question.revision, body: '先描述颜色、形状、数量，再单独写判断及其依据。' });
    let task = await f.good(f.author, '/tasks', { class_id: f.classId, subject_id: f.subject, title: '制作一张观察记录卡', target_type: 'coursework', target_id: null, due_at: new Date(Date.now() + 86400000).toISOString(), body: '记录三个可核验的事实，并写下一条改进计划。', rubric: [{ key: 'process', title: '观察过程', weight: 40 }, { key: 'outcome', title: '证据表达', weight: 40 }, { key: 'reflection', title: '实践回顾', weight: 20 }] });
    await f.good(f.author, `/tasks/${task._id}/actions`, { action: 'publish', expected_revision: task.revision });
    const submission = await f.good(f.student, `/tasks/${task._id}/coursework`, { action: 'submit', expected_revision: 0, body: '我观察了三片叶子，记录了颜色、形状和数量，下一次补充观察条件。' });
    await f.good(f.author, `/tasks/${task._id}/feedback`, { head_revision: submission.revision, submission_id: submission.current_submission_id, comments: '事实与判断已经分开，建议补充时间及观察条件。', scores: [{ key: 'process', score: 80 }, { key: 'outcome', score: 85 }, { key: 'reflection', score: 80 }], publish: true });
    const { createServer } = await import(pathToFileURL(path.join(root, 'web/node_modules/vite/dist/node/index.js')));
    const vue = (await import(pathToFileURL(path.join(root, 'web/node_modules/@vitejs/plugin-vue/dist/index.mjs')))).default;
    vite = await createServer({ configFile: false, root: path.join(root, 'web'), plugins: [vue(), { name: 'isolated-media-capture', configureServer(server) { server.middlewares.use((req, res, next) => {
      const url = new URL(req.url, origin);
      if (url.pathname === '/capture-control') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(`<!doctype html><meta charset="utf-8"><title>素材采集身份切换</title><h1>隔离示例环境 · 实际界面采集</h1><p>一次性合成账号，非真实用户资料。</p>${Object.keys(actors).map(name => `<form method="post" action="/capture-actor"><button name="actor" value="${name}">${name}</button></form>`).join('')}`); return; }
      if (url.pathname === '/capture-actor' && req.method === 'POST') {
        if (req.headers.origin !== origin) { res.writeHead(403).end(); return; }
        let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => { const selected = new URLSearchParams(body).get('actor'); if (!Object.hasOwn(actors, selected)) { res.writeHead(400).end(); return; } actor = selected; res.writeHead(303, { Location: actor === 'learner' ? '/personal' : '/training?tab=courses' }).end(); }); return;
      }
      if (!url.pathname.startsWith('/api/')) return next();
      if (req.headers.origin && req.headers.origin !== origin) { res.writeHead(403).end(); return; }
      const who = actors[actor];
      const headers = { ...req.headers, host: new URL(f.browser.base).host, origin: 'http://127.0.0.1:5174', cookie: [...who.browser.cookies].map(([key, value]) => `${key}=${value}`).join('; ') };
      const outgoing = http.request(new URL(req.url, f.browser.base), { method: req.method, headers }, upstream => {
        calls.push({ actor, method: req.method, path: url.pathname, status: upstream.statusCode });
        fs.writeFileSync(evidence, JSON.stringify({ fixture: 'real-app-http-mongo-disposable-synthetic', capturedAt: new Date().toISOString(), calls }, null, 2));
        const responseHeaders = { ...upstream.headers }; delete responseHeaders['set-cookie']; res.writeHead(upstream.statusCode, responseHeaders); upstream.pipe(res);
      }); outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(outgoing);
    }); } }], server: { host: 'localhost', port: 5197, strictPort: true }, clearScreen: false });
    await vite.listen(); console.log('MEDIA_CAPTURE_READY http://localhost:5197/personal');
    await new Promise(resolve => { const timer = setInterval(() => { try { if (JSON.parse(fs.readFileSync(control, 'utf8')).stop) { clearInterval(timer); resolve(); } } catch {} }, 250); });
  } finally { await vite?.close(); for (const cleanup of cleanups.reverse()) await cleanup(); await rs?.stop(); }
})().catch(error => { console.error('MEDIA_CAPTURE_FAILED', error.code || error.name, String(error.message).split('\n')[0]); console.error(String(error.stack).split('\n').filter(line => /^\s+at /.test(line)).slice(0, 5).join('\n')); process.exitCode = 1; });
