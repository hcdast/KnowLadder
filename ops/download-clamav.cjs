"use strict";
// Download the official portable runtime only; debug symbols/SDKs are unnecessary.
const fs = require("node:fs"),
  path = require("node:path"),
  { spawn } = require("node:child_process"),
  zlib = require("node:zlib");
const root = path.resolve(process.argv[2] || ""),
  dest = path.join(root, "clamav"),
  cache = path.join(root, "clamav-parts");
const official =
  "https://www.clamav.net/downloads/production/clamav-1.4.6.win.x64.zip";
async function curl(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      "curl.exe",
      [
        "--fail",
        "--location",
        "--connect-timeout",
        "8",
        "--max-time",
        "40",
        "--retry",
        "2",
        "--silent",
        "--show-error",
        ...args,
      ],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let error = "";
    p.stderr.on("data", (b) => {
      if (error.length < 1000) error += b;
    });
    p.on("error", () => reject(Error("CLAMAV_DOWNLOAD_LAUNCH_FAILED")));
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(Error("CLAMAV_DOWNLOAD_FAILED")),
    );
  });
}
async function main() {
  if (!process.argv[2] || root === path.parse(root).root)
    throw Error("RUNTIME_ROOT_REQUIRED");
  for (const p of [root, dest, cache]) {
    fs.mkdirSync(p, { recursive: true });
    if (fs.lstatSync(p).isSymbolicLink()) throw Error("RUNTIME_LINK_REJECTED");
  }
  const headers = path.join(cache, "headers.tmp"),
    tail = path.join(cache, "tail.bin");
  await curl([
    "--range",
    "-65536",
    "--dump-header",
    headers,
    official,
    "--output",
    tail,
  ]);
  const redirects = [
    ...fs.readFileSync(headers, "utf8").matchAll(/^location: (.+)$/gim),
  ].map((m) => m[1].trim());
  const url = redirects.at(-1);
  if (!url || new URL(url).hostname !== "clamav-site.s3.amazonaws.com")
    throw Error("OFFICIAL_DOWNLOAD_REDIRECT_REQUIRED");
  fs.unlinkSync(headers); // Do not retain temporary signed URLs or HTTP cookies.
  const b = fs.readFileSync(tail);
  let end = -1;
  for (let i = b.length - 22; i >= 0; i--)
    if (b.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0 || b.readUInt32LE(end + 12) > end)
    throw Error("ZIP_CENTRAL_DIRECTORY_INVALID");
  const entries = [];
  let cursor = end - b.readUInt32LE(end + 12);
  while (cursor < end) {
    if (b.readUInt32LE(cursor) !== 0x02014b50)
      throw Error("ZIP_DIRECTORY_INVALID");
    const nameSize = b.readUInt16LE(cursor + 28),
      name = b.subarray(cursor + 46, cursor + 46 + nameSize).toString();
    if (
      !/^clamav-1[.]4[.]6[.]win[.]x64\//.test(name) ||
      name.split("/").includes("..")
    )
      throw Error("ZIP_PATH_REJECTED");
    if (
      /\.dll$/i.test(name) ||
      /\/(clamscan|freshclam)[.]exe$/i.test(name) ||
      /\/(COPYING[^/]*|LICENSE[^/]*|README[^/]*)$/i.test(name) ||
      /\/licenses\//i.test(name)
    )
      entries.push({
        name,
        compressed: b.readUInt32LE(cursor + 20),
        size: b.readUInt32LE(cursor + 24),
        method: b.readUInt16LE(cursor + 10),
        crc: b.readUInt32LE(cursor + 16),
        offset: b.readUInt32LE(cursor + 42),
      });
    cursor +=
      46 + nameSize + b.readUInt16LE(cursor + 30) + b.readUInt16LE(cursor + 32);
  }
  const queue = [];
  let next = 0;
  async function workers(tasks, fn, concurrency = 12) {
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(tasks.length, concurrency) }, async () => {
        while (index < tasks.length) {
          const task = tasks[index++];
          await fn(task);
        }
      }),
    );
  }
  await workers(entries, async (e) => {
    const file = path.join(cache, "header-" + e.offset);
    await curl([
      "--range",
      e.offset + "-" + (e.offset + 29),
      url,
      "--output",
      file,
    ]);
    const header = fs.readFileSync(file);
    if (header.length !== 30 || header.readUInt32LE(0) !== 0x04034b50)
      throw Error("ZIP_LOCAL_HEADER_INVALID");
    e.start = e.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    e.parts = [];
    for (let pos = 0; pos < e.compressed; pos += 65536) {
      const length = Math.min(65536, e.compressed - pos),
        part = path.join(cache, "data-" + (e.start + pos));
      e.parts.push(part);
      queue.push({ start: e.start + pos, length, part });
    }
  });
  await workers(queue, async (task) => {
    if (fs.existsSync(task.part) && fs.statSync(task.part).size === task.length)
      return;
    await curl([
      "--range",
      task.start + "-" + (task.start + task.length - 1),
      url,
      "--output",
      task.part,
    ]);
    if (fs.statSync(task.part).size !== task.length)
      throw Error("ZIP_RANGE_SIZE_MISMATCH");
    if (++next % 30 === 0)
      console.log("CLAMAV_RUNTIME_CHUNKS=" + next + "/" + queue.length);
  });
  for (const e of entries) {
    const compressed = Buffer.concat(e.parts.map((p) => fs.readFileSync(p)));
    const contents =
      e.method === 8
        ? zlib.inflateRawSync(compressed)
        : e.method === 0
          ? compressed
          : null;
    if (
      !contents ||
      contents.length !== e.size ||
      zlib.crc32(contents) !== e.crc
    )
      throw Error("ZIP_CRC_MISMATCH");
    const filename = path.resolve(dest, e.name);
    if (!filename.startsWith(dest + path.sep)) throw Error("ZIP_PATH_REJECTED");
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  }
  console.log("OFFICIAL_CLAMAV_RUNTIME_INSTALLED");
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
