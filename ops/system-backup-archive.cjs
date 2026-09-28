"use strict";
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertWindowsPrivateDirectory } = require('../server/dist/security/private-directory.js');
const MAGIC = Buffer.from('KLSYSTEMBACKUP01');
const MAX_FRAME = 4 * 1024 * 1024;
const CHUNK = 1024 * 1024;
function ensure(ok, code = 'BACKUP_INTEGRITY_FAILED') { if (!ok) { const e = new Error(code); e.safe = true; throw e; } }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
async function privateDirectory(input, storageRoot) {
  ensure(typeof input === 'string' && path.isAbsolute(input), 'PRIVATE_DIRECTORY_REQUIRED');
  const root = path.resolve(input);
  for (const base of [path.resolve(__dirname, '..'), process.cwd()]) {
    const relative = path.relative(base, root);
    ensure(relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative), 'PRIVATE_DIRECTORY_REQUIRED');
  }
  let cursor = root;
  for (;;) {
    const stat = await fs.lstat(cursor);
    ensure(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_DIRECTORY');
    if (process.platform !== 'win32') ensure((stat.uid === process.getuid() || stat.uid === 0) && (stat.mode & 0o022) === 0, 'UNSAFE_DIRECTORY');
    if (path.dirname(cursor) === cursor) break;
    cursor = path.dirname(cursor);
  }
  ensure(path.resolve(await fs.realpath(root)).toLowerCase() === root.toLowerCase(), 'UNSAFE_DIRECTORY');
  if (process.platform === 'win32') {
    if (storageRoot === undefined) await assertWindowsPrivateDirectory(root);
    else {
      ensure(path.isAbsolute(storageRoot) && path.dirname(root) === path.resolve(storageRoot) && ['tmp', 'quarantine', 'ready'].includes(path.basename(root)), 'UNSAFE_DIRECTORY');
      await assertWindowsPrivateDirectory(path.resolve(storageRoot), [path.basename(root)]);
    }
  }
  else ensure(((await fs.stat(root)).mode & 0o077) === 0, 'PRIVATE_DIRECTORY_REQUIRED');
  return root;
}
async function openFile(filename, storageRoot) {
  await privateDirectory(path.dirname(filename), storageRoot);
  const before = await fs.lstat(filename);
  ensure(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, 'UNSAFE_FILE');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  const stat = await handle.stat();
  if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== before.ino || stat.dev !== before.dev) { await handle.close(); ensure(false, 'UNSAFE_FILE'); }
  return handle;
}
async function writeAll(handle, bytes) { let offset = 0; while (offset < bytes.length) { const r = await handle.write(bytes, offset, bytes.length - offset); ensure(r.bytesWritten > 0); offset += r.bytesWritten; } }
async function readExact(handle, length, position) {
  const out = Buffer.allocUnsafe(length); let offset = 0;
  while (offset < length) { const r = await handle.read(out, offset, length - offset, position + offset); ensure(r.bytesRead > 0); offset += r.bytesRead; }
  return out;
}
async function createArchive(filename, key, checkpoint = () => {}) {
  await privateDirectory(path.dirname(filename));
  checkpoint();
  try { await fs.lstat(filename); ensure(false, 'BACKUP_ALREADY_EXISTS'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const temporary = path.join(path.dirname(filename), '.' + crypto.randomUUID() + '.ciphertext');
  const handle = await fs.open(temporary, 'wx', 0o600);
  const id = crypto.randomBytes(16); const header = Buffer.concat([MAGIC, id]);
  await writeAll(handle, header);
  let count = 0; const digest = crypto.createHash('sha256'); let closed = false;
  async function frame(value, terminal = false) {
    checkpoint();
    const bytes = Buffer.from(JSON.stringify(value)); ensure(bytes.length <= MAX_FRAME, 'BACKUP_LIMIT_EXCEEDED');
    const meta = Buffer.alloc(9); meta.writeUInt32BE(bytes.length); meta.writeUInt32BE(count, 4); meta[8] = terminal ? 1 : 0;
    const nonce = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.concat([header, meta]));
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const packet = Buffer.concat([meta, nonce, encrypted, cipher.getAuthTag()]);
    await writeAll(handle, packet);
    checkpoint();
    if (!terminal) digest.update(packet);
    count++;
  }
  return {
    frame,
    async publish(manifest) {
      await frame({ kind: 'terminal', count, digest: digest.digest('hex'), manifest }, true);
      await handle.sync(); await handle.close(); closed = true;
      checkpoint();
      // link is atomic and never overwrites an existing published name.
      await fs.link(temporary, filename); await fs.unlink(temporary);
      if (process.platform !== 'win32') { const dir = await fs.open(path.dirname(filename), 'r'); try { await dir.sync(); } finally { await dir.close(); } }
    },
    async abort() { if (!closed) await handle.close(); await fs.unlink(temporary).catch(() => {}); },
  };
}
async function readArchive(handle, key, consume = async () => {}, checkpoint = () => {}) {
  const stat = await handle.stat(); ensure(stat.nlink === 1 && stat.size <= 2 * 1024 ** 3, 'BACKUP_LIMIT_EXCEEDED');
  const header = await readExact(handle, MAGIC.length + 16, 0); ensure(header.subarray(0, MAGIC.length).equals(MAGIC));
  let position = header.length; let count = 0; const digest = crypto.createHash('sha256');
  while (position < stat.size) {
    checkpoint();
    const meta = await readExact(handle, 9, position); const length = meta.readUInt32BE(0);
    ensure(length > 0 && length <= MAX_FRAME && meta.readUInt32BE(4) === count && meta[8] <= 1);
    const rest = await readExact(handle, 12 + length + 16, position + 9);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, rest.subarray(0, 12));
    decipher.setAAD(Buffer.concat([header, meta])); decipher.setAuthTag(rest.subarray(12 + length));
    let value;
    try { value = JSON.parse(Buffer.concat([decipher.update(rest.subarray(12, 12 + length)), decipher.final()]).toString('utf8')); } catch { ensure(false); }
    position += 9 + rest.length;
    checkpoint();
    if (meta[8]) {
      ensure(value.kind === 'terminal' && value.count === count && value.digest === digest.digest('hex') && position === stat.size);
      const after = await handle.stat(); ensure(after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.nlink === 1);
      return { manifest: value.manifest, manifestHash: hash(JSON.stringify(value.manifest)) };
    }
    digest.update(meta); digest.update(rest); await consume(value); count++;
  }
  ensure(false);
}
module.exports = { fs, path, crypto, ensure, hash, privateDirectory, openFile, writeAll, readExact, createArchive, readArchive, CHUNK };
