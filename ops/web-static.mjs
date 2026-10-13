import http from 'node:http';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

const types = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.avif', 'image/avif'], ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
]);
const textTypes = new Set(['.html', '.js', '.css', '.svg']);

// Vite's default eight-character content-hash suffix, only inside the build's assets directory.
export function staticCacheControl(filename, assets = false) {
  if (filename === 'index.html') return 'no-cache';
  return assets && /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(filename)
    ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
}

function encoding(header, compressible) {
  if (!header) return 'identity';
  const qualities = new Map();
  for (const item of header.split(',')) {
    const [name, ...parameters] = item.trim().toLowerCase().split(';');
    const quality = parameters.find(parameter => parameter.trim().startsWith('q='));
    const value = quality ? quality.trim().slice(2) : '1';
    qualities.set(name, /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : 0);
  }
  const identity = qualities.get('identity') ?? (qualities.get('*') === 0 ? 0 : 1);
  const gzip = compressible ? (qualities.get('gzip') ?? qualities.get('*') ?? 0) : 0;
  return gzip > 0 && gzip >= identity ? 'gzip' : identity > 0 ? 'identity' : null;
}

function empty(res, status) {
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(status);
  res.end();
}

// Caller supplies an approved root and a relative public filename, never a request URL.
export async function serveStaticFile(req, res, root, relative, cacheControl) {
  const parts = relative.split('/');
  const extension = path.extname(relative);
  if (!types.has(extension) || (extension === '.html' && relative !== 'index.html')
      || parts.some(part => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part))) {
    empty(res, 404);
    return;
  }
  let file;
  try {
    let candidate = root;
    const target = path.join(root, ...parts);
    for (const part of parts) {
      candidate = path.join(candidate, part);
      const entry = await lstat(candidate);
      if (entry.isSymbolicLink() || (candidate === target && !entry.isFile())) { empty(res, 404); return; }
    }
    const resolved = await realpath(candidate);
    if (!resolved.startsWith(root + path.sep)) { empty(res, 404); return; }
    file = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = await file.stat();
    if (!metadata.isFile()) { empty(res, 404); return; }
    const compressible = textTypes.has(extension);
    res.setHeader('Vary', 'Accept-Encoding');
    const selected = encoding(req.headers['accept-encoding'], compressible);
    if (!selected) { empty(res, 406); return; }
    // A weak validator covers both gzip and identity representations of the same file.
    const etag = `W/"${metadata.size.toString(16)}-${metadata.mtimeMs.toString(16)}"`;
    const modified = metadata.mtime.toUTCString();
    res.setHeader('Content-Type', types.get(extension));
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', modified);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (selected === 'gzip') res.setHeader('Content-Encoding', 'gzip');
    const matches = req.headers['if-none-match'];
    const fresh = matches !== undefined
      ? matches.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag.slice(2))
      : req.headers['if-modified-since'] && Math.floor(metadata.mtimeMs / 1000) * 1000 <= Date.parse(req.headers['if-modified-since']);
    if (fresh) { res.writeHead(304); res.end(); return; }
    if (selected === 'identity') res.setHeader('Content-Length', metadata.size);
    if (req.method === 'HEAD') { res.end(); return; }
    const source = file.createReadStream({ autoClose: false });
    if (selected === 'gzip') await pipeline(source, createGzip(), res);
    else await pipeline(source, res);
  } catch (error) {
    if (res.headersSent) res.destroy(error);
    else if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) empty(res, 404);
    else empty(res, 503);
  } finally {
    if (file) await file.close();
  }
}

// Local protocol/browser proof of an explicit web build, not a production SSR/API server.
export async function createWebStaticServer({ root }) {
  if (typeof root !== 'string' || !root) throw Error('WEB_BUILD_ROOT_REQUIRED');
  const requested = path.resolve(root);
  const approved = await realpath(requested);
  if (approved !== requested || path.basename(approved) !== 'dist' || path.basename(path.dirname(approved)) !== 'web'
      || !(await lstat(path.join(approved, 'index.html'))).isFile()
      || !(await lstat(path.join(approved, 'assets'))).isDirectory()) throw Error('WEB_BUILD_ROOT_INVALID');
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD'); empty(res, 405); return;
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); }
    catch { empty(res, 400); return; }
    if (pathname === '/api' || pathname.startsWith('/api/')) { empty(res, 404); return; }
    const asset = pathname.startsWith('/assets/');
    const visual = pathname.startsWith('/visuals/');
    if (asset || visual) {
      const relative = pathname.slice(1);
      await serveStaticFile(req, res, approved, relative, staticCacheControl(path.basename(relative), asset));
      return;
    }
    // Dotted/private paths never fall back to HTML. Only extensionless SPA routes do.
    if (pathname !== '/index.html' && pathname.split('/').some(part => part.includes('.') || (part && !/^[A-Za-z0-9_-]+$/.test(part)))) {
      empty(res, 404); return;
    }
    await serveStaticFile(req, res, approved, 'index.html', 'no-cache');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.KL_WEB_STATIC_PORT || 5176);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('WEB_STATIC_PORT_INVALID');
  const server = await createWebStaticServer({ root: process.argv[2] });
  server.listen(port, '127.0.0.1', () => console.log(`Web build protocol server: http://127.0.0.1:${port}`));
  process.once('SIGTERM', () => server.close());
  process.once('SIGINT', () => server.close());
}
