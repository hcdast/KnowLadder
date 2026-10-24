const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { gunzipSync } = require('node:zlib');

function request(server, pathname, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: pathname, headers, method }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

async function fixture(t) {
  // Windows TEMP can use an 8.3 alias; use its canonical path without relaxing root checks.
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kl-static-')));
  const root = path.join(directory, 'web', 'dist');
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await fs.mkdir(path.join(root, 'visuals', 'icons'), { recursive: true });
  const files = {
    'index.html': '<!doctype html><html><body>知阶公开入口</body></html>',
    'assets/index-aB12_C34.js': 'export const course = "原创静态协议材料";\n'.repeat(80),
    'assets/index-dE56_F78.css': 'body { color: #17364b; }\n'.repeat(80),
    'assets/plain.js': 'export const version = "mutable";',
    'visuals/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><text>知阶</text></svg>',
    'visuals/icons/book.svg': '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h20v20z"/></svg>',
    'assets/plain-unversioned.js': 'export const version = "unversioned";',
    'visuals/image.webp': Buffer.from('RIFF\x14\x00\x00\x00WEBPVP8 fictional protocol bytes', 'binary'),
    'assets/font-zA12_B34.woff2': Buffer.from('wOF2 protocol bytes'),
    'visuals/product-tour.mp4': await fs.readFile(path.resolve(__dirname, '../../web/public/visuals/product-tour.mp4')),
    'visuals/product-tour.zh.vtt': 'WEBVTT\n\n00:00:00.000 --> 00:00:04.000\n原创界面导览\n',
    'assets/secret.key': 'must never be served',
    '.env': 'must never be served',
  };
  for (const [relative, content] of Object.entries(files)) await fs.writeFile(path.join(root, relative), content);
  const { createWebStaticServer } = await import(pathToFileURL(path.resolve(__dirname, '../../ops/web-static.mjs')));
  const server = await createWebStaticServer({ root });
  await listen(server);
  t.after(async () => { await close(server); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, root, server, files, createWebStaticServer };
}

test('static HTTP: decoded gzip matches identity for HTML/JS/CSS/SVG, negotiation and HEAD', async t => {
  const { server, files } = await fixture(t);
  for (const relative of ['index.html', 'assets/index-aB12_C34.js', 'assets/index-dE56_F78.css', 'visuals/logo.svg']) {
    const identity = await request(server, '/' + relative, { 'Accept-Encoding': 'identity' });
    const gzip = await request(server, '/' + relative, { 'Accept-Encoding': 'gzip, identity;q=0' });
    assert.equal(identity.status, 200);
    assert.equal(gzip.status, 200);
    assert.equal(identity.headers['content-encoding'], undefined);
    assert.equal(gzip.headers['content-encoding'], 'gzip');
    assert.match(gzip.headers.vary, /Accept-Encoding/i);
    assert.deepEqual(identity.body, Buffer.from(files[relative]));
    assert.deepEqual(gunzipSync(gzip.body), identity.body);
    const head = await request(server, '/' + relative, { 'Accept-Encoding': 'gzip' }, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body.byteLength, 0);
    assert.equal(head.headers.etag, gzip.headers.etag);
    assert.equal(head.headers['content-encoding'], 'gzip');
  }
  const pathname = '/assets/index-aB12_C34.js';
  const noGzip = await request(server, pathname, { 'Accept-Encoding': '*;q=1, gzip;q=0' });
  assert.equal(noGzip.headers['content-encoding'], undefined);
  assert.deepEqual(noGzip.body, Buffer.from(files[pathname.slice(1)]));
  assert.equal((await request(server, pathname, { 'Accept-Encoding': 'br, gzip;q=0, identity;q=0' })).status, 406);
  for (const relative of ['visuals/image.webp', 'assets/font-zA12_B34.woff2']) {
    const response = await request(server, '/' + relative, { 'Accept-Encoding': 'gzip, br' });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.deepEqual(response.body, files[relative]);
    assert.equal((await request(server, '/' + relative, { 'Accept-Encoding': 'gzip, identity;q=0' })).status, 406);
  }
});

test('static HTTP: public tour has real MP4 bytes, UTF-8 captions, HEAD and missing media 404', async t => {
  const { server, files } = await fixture(t);
  const movie = await request(server, '/visuals/product-tour.mp4', { 'Accept-Encoding': 'gzip' });
  assert.equal(movie.status, 200);
  assert.equal(movie.headers['content-type'], 'video/mp4');
  assert.equal(movie.headers['content-encoding'], undefined);
  assert.equal(movie.headers['x-content-type-options'], 'nosniff');
  assert.match(movie.headers['cache-control'], /max-age=300/);
  assert.deepEqual(movie.body, files['visuals/product-tour.mp4']);
  assert.equal(movie.body.subarray(4, 8).toString(), 'ftyp');
  const head = await request(server, '/visuals/product-tour.mp4', {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers['content-length']), movie.body.length);
  assert.equal(head.body.length, 0);
  const track = await request(server, '/visuals/product-tour.zh.vtt', { 'Accept-Encoding': 'gzip' });
  assert.equal(track.status, 200);
  assert.equal(track.headers['content-type'], 'text/vtt; charset=utf-8');
  assert.equal(gunzipSync(track.body).toString('utf8'), files['visuals/product-tour.zh.vtt']);
  for (const name of ['missing.mp4', 'missing.vtt']) {
    const response = await request(server, '/visuals/' + name);
    assert.equal(response.status, 404);
    assert.equal(response.body.length, 0);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});

test('static HTTP: cache boundaries and conditional requests have correct precedence across routes', async t => {
  const { server, files } = await fixture(t);
  const chunk = await request(server, '/assets/index-aB12_C34.js');
  assert.match(chunk.headers['cache-control'], /max-age=31536000, immutable/);
  const visual = await request(server, '/visuals/logo.svg');
  assert.match(visual.headers['cache-control'], /max-age=300/);
  assert.doesNotMatch(visual.headers['cache-control'], /immutable/);
  assert.doesNotMatch((await request(server, '/assets/plain.js')).headers['cache-control'], /immutable/);
  for (const pathname of ['/', '/index.html', '/home', '/account/email']) {
    const entry = await request(server, pathname, { 'Accept-Encoding': 'identity' });
    assert.equal(entry.headers['cache-control'], 'no-cache');
    assert.deepEqual(entry.body, Buffer.from(files['index.html']));
  }
  const fresh = await request(server, '/assets/index-aB12_C34.js', { 'If-None-Match': chunk.headers.etag, 'Accept-Encoding': 'gzip' });
  assert.equal(fresh.status, 304);
  assert.equal(fresh.body.byteLength, 0);
  assert.match(fresh.headers.vary, /Accept-Encoding/i);
  assert.equal((await request(server, '/visuals/logo.svg', { 'If-Modified-Since': visual.headers['last-modified'] })).status, 304);
  const wrongValidator = await request(server, '/visuals/logo.svg', { 'If-None-Match': chunk.headers.etag, 'If-Modified-Since': visual.headers['last-modified'] });
  assert.doesNotMatch((await request(server, '/assets/plain-unversioned.js')).headers['cache-control'], /immutable/);
  assert.equal(wrongValidator.status, 200);
  assert.deepEqual(wrongValidator.body, Buffer.from(files['visuals/logo.svg']));
  assert.equal((await request(server, '/visuals/logo.svg', { 'If-None-Match': '"unrelated", ' + visual.headers.etag })).status, 304);
});

test('static HTTP: missing/private/traversal/symlink paths never return SPA content; API is isolated', async t => {
  const { directory, root, server, createWebStaticServer } = await fixture(t);
  await assert.rejects(() => createWebStaticServer({ root: directory }));
  await assert.rejects(() => createWebStaticServer({}));
  const outside = path.join(directory, 'private');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.svg'), '<svg>private</svg>');
  await fs.symlink(outside, path.join(root, 'visuals', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const pathname of ['/assets/missing.js', '/visuals/missing.svg', '/assets/secret.key', '/.env', '/api', '/api/v1/auth/me', '/api/v1/site/pages/home', '/api/v1/site/consultations', '/visuals/linked/secret.svg', '/assets/%2e%2e%2f.env', '/visuals/%2e%2e%2findex.html', '/missing.css']) {
    const response = await request(server, pathname);
    assert.equal(response.status, 404, pathname);
    assert.equal(response.headers['cache-control'], 'no-store', pathname);
    assert.equal(response.body.byteLength, 0, pathname);
  }
  assert.equal((await request(server, '/%ZZ')).status, 400);
  assert.equal((await request(server, '/', {}, 'POST')).status, 405);
  const svg = await request(server, '/visuals/icons/book.svg');
  assert.equal(svg.status, 200);
  assert.match(svg.headers['content-type'], /^image\/svg\+xml/);
  assert.equal(svg.headers['x-content-type-options'], 'nosniff');
});

test('SSR HTTP: asset cache changes do not cache rendered pages, sitemap or dependency errors', async t => {
  const { root, files } = await fixture(t);
  const api = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: { page: { title: '原创页面', body: '动态CMS正文' } } }));
  });
  await listen(api);
  const { createPublicSiteServer } = await import(pathToFileURL(path.resolve(__dirname, '../../ops/site-server.mjs')));
  const server = await createPublicSiteServer({ apiOrigin: `http://127.0.0.1:${api.address().port}`, siteOrigin: 'https://example.test', assetsRoot: path.join(root, 'assets') });
  await listen(server);
  t.after(async () => { await close(server); await close(api); });
  const asset = await request(server, '/assets/index-aB12_C34.js', { 'Accept-Encoding': 'gzip' });
  assert.equal(asset.status, 200);
  assert.deepEqual(gunzipSync(asset.body), Buffer.from(files['assets/index-aB12_C34.js']));
  assert.match(asset.headers['cache-control'], /immutable/);
  assert.equal((await request(server, '/assets/index-aB12_C34.js', { 'If-None-Match': asset.headers.etag })).status, 304);
  for (const pathname of ['/', '/sitemap.xml', '/assets/missing.js', '/api/v1/site/consultations']) {
    assert.equal((await request(server, pathname)).headers['cache-control'], 'no-store', pathname);
  }
  await close(api);
  const unavailable = await request(server, '/');
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers['cache-control'], 'no-store');
});
