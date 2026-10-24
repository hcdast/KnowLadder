'use strict';
// Read-only local verification; never submits a model task or updates receipts.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { parseCatalog } = require('./generate.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'web/public/website');
const cache = path.join(__dirname, '.cache');
const ffmpeg = process.env.FFMPEG_BIN || path.join(root, 'ops/artifacts/site-media-tools/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe');
const catalog = parseCatalog(fs.readFileSync(path.join(root, 'docs/UIUX设计方案.md'), 'utf8'));
const rows = catalog.filter(row => /^(?:R\d|V\d)/.test(row.id));
// A01 in V02 is a linked reference image, not another missing R/V delivery.
const expected = new Set(rows.flatMap(row => row.files.map(file => file.name).filter(name => /^[rv]\d/.test(name))));
const delivered = JSON.parse(fs.readFileSync(path.join(cache, 'capture-287/delivery.json'), 'utf8'));
const capture = JSON.parse(fs.readFileSync(path.join(cache, 'capture-287/frames.json'), 'utf8'));
assert.equal(new Set(capture.frames.map(frame => frame.file)).size, capture.frames.length, 'capture sources must be unique');
for (const frame of capture.frames) {
  assert.equal(path.basename(frame.file), frame.file);
  assert.ok(fs.statSync(path.join(cache, 'capture-287', frame.file)).isFile());
}
const records = [...delivered.newFiles, ...(delivered.updatedFiles || [])];
for (const id of ['V01-A', 'V01-B', 'V01-C', 'V02']) {
  const candidates = fs.readdirSync(cache).filter(name => name.startsWith(id + '-') && name.endsWith('.json'));
  assert.equal(candidates.length, 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(cache, candidates[0]), 'utf8'));
  assert.equal(receipt.state, 'downloaded');
  records.push(...receipt.files);
}
const hashes = new Map();
for (const record of records) {
  if (hashes.has(record.name)) assert.deepEqual(hashes.get(record.name), record);
  hashes.set(record.name, record);
}
assert.equal(rows.length, 18);
assert.equal(expected.size, 34);
assert.deepEqual(new Set(hashes.keys()), expected);
const results = [];
for (const name of expected) {
  const file = path.join(output, name);
  const bytes = fs.readFileSync(file);
  const record = hashes.get(name);
  assert.equal(bytes.length, record.bytes, name);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256, name);
  if (/\.(?:mp4|png|webp)$/.test(name)) {
    const decoded = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    assert.equal(decoded.status, 0, `${name}: ${decoded.stderr}`);
    const size = name.startsWith('r0') ? (name.endsWith('.png') ? '2400x1500' : '1600x1000') : '1920x1080';
    assert.ok(decoded.stderr.includes(size), name + ' dimensions');
    if (name.endsWith('.mp4')) {
      const seconds = name.startsWith('v03') ? 30 : name.startsWith('v01-brand') ? 15 : 5;
      const fps = name.startsWith('v03') ? 30 : 24;
      assert.match(decoded.stderr, /Video: h264/);
      assert.match(decoded.stderr, /yuv420p/);
      assert.ok(decoded.stderr.includes(`Duration: 00:00:${String(seconds).padStart(2, '0')}.00`), name + ' duration');
      assert.ok(decoded.stderr.includes(`${fps} fps`), name + ' fps');
      assert.match(decoded.stderr, new RegExp(`frame=\\s*${seconds * fps}\\s`));
      assert.doesNotMatch(decoded.stderr, /Stream #\d+:\d+.*Audio:/);
    }
  } else {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n');
    assert.ok(text.trim() && !text.includes('\ufffd'));
    if (name.endsWith('.vtt')) {
      assert.ok(text.startsWith('WEBVTT\n\n'));
      const cues = [...text.matchAll(/(\d\d):(\d\d):(\d\d)\.(\d{3}) --> (\d\d):(\d\d):(\d\d)\.(\d{3})\n([^\n]+)/g)];
      assert.equal(cues.length, name.startsWith('v03') ? 6 : 3);
      let end = 0;
      for (const cue of cues) {
        const seconds = offset => Number(cue[offset]) * 3600 + Number(cue[offset + 1]) * 60 + Number(cue[offset + 2]) + Number(cue[offset + 3]) / 1000;
        const start = seconds(1), next = seconds(5);
        assert.equal(start, end); assert.ok(next > start); end = next;
      }
      assert.equal(end, name.startsWith('v03') ? 30 : 15);
    }
  }
  results.push({ name, bytes: bytes.length, verified: true });
}
console.log(JSON.stringify({ rows: rows.length, uniqueFiles: results.length, fullyDecoded: results.filter(file => /\.(?:mp4|png|webp)$/.test(file.name)).length,
  totalBytes: results.reduce((sum, file) => sum + file.bytes, 0), utf8VttAndTranscripts: 5, results }, null, 2));
