import { createHash } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { createWriteStream, constants } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TextDecoder } from 'node:util';
import type { Readable } from 'node:stream';
import { storagePath, storageRoot, MAX_FILE_SIZE, DOCX_FILE_MIME, importDocumentsEnabled } from './config';
import { extractInProcess } from '../training/import-parser-process';
import { fail } from '../errors';
export async function receive(source: Readable, expected: {declared_size:number;declared_mime:string;declared_checksum:string}, key: string) {
  const root = await storageRoot();
  const temporary = await storagePath('tmp', key, root);
  const handle = await open(temporary, 'wx', 0o600);
  // A numeric fd avoids FileHandle streams retaining a reference that blocks close().
  const destination = createWriteStream(temporary, {fd:handle.fd,autoClose:false});
  const hash = createHash('sha256'); const decoder = new TextDecoder('utf-8', {fatal:true});
  let size = 0; let prefix = Buffer.alloc(0); let suffix = Buffer.alloc(0); let textValid = true;
  const checkText = (value: string) => { if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) textValid = false; };
  const inspect = new Transform({transform(chunk: Buffer, _encoding, done) {
    try {
      size += chunk.length;
      if (size > MAX_FILE_SIZE || size > expected.declared_size) fail(413,'FILE_TOO_LARGE','文件超过登记大小');
      hash.update(chunk);
      if (prefix.length < 32) prefix = Buffer.concat([prefix, chunk.subarray(0,32-prefix.length)]);
      suffix = Buffer.concat([suffix, chunk.subarray(Math.max(0,chunk.length-2048))]).subarray(-2048);
      if (expected.declared_mime === 'text/plain' && textValid) { try { checkText(decoder.decode(chunk,{stream:true})); } catch { textValid = false; } }
      done(null,chunk);
    } catch(error) { done(error as Error); }
  }});
  try {
    await pipeline(source, inspect, destination);
    await handle.sync();
    await handle.close();
    if (expected.declared_mime === 'text/plain' && textValid) { try { checkText(decoder.decode()); } catch { textValid = false; } }
    const checksum = hash.digest('hex');
    if (size !== expected.declared_size || checksum !== expected.declared_checksum) fail(422,'FILE_INTEGRITY_MISMATCH','文件大小或SHA256与登记不符');
    const mime = expected.declared_mime;
    const pdf = prefix.subarray(0,5).toString('ascii') === '%PDF-' && /%%EOF\s*$/.test(suffix.toString('latin1'));
    const png = prefix.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && suffix.subarray(-12).equals(Buffer.from('0000000049454e44ae426082','hex'));
    const jpeg = prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255 && suffix.subarray(-2).equals(Buffer.from([255,217]));
    const mp4 = process.env.KL_TRAINING_ENABLED === 'true' && prefix.length >= 24 && prefix.subarray(4,8).toString('ascii') === 'ftyp' && prefix.readUInt32BE(0) >= 16 && prefix.readUInt32BE(0) <= size && ['isom','iso2','mp41','mp42','avc1','M4V '].includes(prefix.subarray(8,12).toString('ascii'));
    const mp3 = process.env.KL_TRAINING_ENABLED === 'true' && size > 32 && ((prefix.subarray(0,3).toString('ascii') === 'ID3' && [3,4].includes(prefix[3]!) && prefix.subarray(6,10).every(byte => byte < 128)) || (prefix[0] === 255 && (prefix[1]! & 224) === 224 && (prefix[1]! & 6) !== 0 && (prefix[2]! & 240) !== 240 && (prefix[2]! & 240) !== 0 && (prefix[2]! & 12) !== 12));
    let docx = false;
    if (mime === DOCX_FILE_MIME && importDocumentsEnabled() && prefix.subarray(0,4).equals(Buffer.from([80,75,3,4]))) {
      try {
        const check = await open(temporary, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const info = await check.stat();
          if (!info.isFile() || info.nlink !== 1 || info.size !== size) throw Error('DOCX_INTEGRITY');
          const bytes = await check.readFile();
          if (createHash('sha256').update(bytes).digest('hex') !== checksum) throw Error('DOCX_INTEGRITY');
          await extractInProcess(bytes,mime,true); docx = true;
        } finally { await check.close(); }
      }
      catch { fail(422,'FILE_TYPE_MISMATCH','DOCX容器结构无效或超过安全限制'); }
    }
    const valid = mime === DOCX_FILE_MIME ? docx : mime === 'video/mp4' ? mp4 : mime === 'audio/mpeg' ? mp3 : mime === 'application/pdf' ? pdf : mime === 'image/png' ? png : mime === 'image/jpeg' ? jpeg : mime === 'text/plain' && textValid && !pdf && !png && !jpeg;
    if (!valid) fail(422,'FILE_TYPE_MISMATCH','文件正文类型与登记不符');
    await rename(temporary, await storagePath('quarantine',key,root));
    return {size,mime,checksum};
  } finally {
    destination.destroy();
    await handle.close().catch(()=>undefined);
    await unlink(temporary).catch(()=>undefined);
  }
}
