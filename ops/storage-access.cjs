"use strict";
// Explicit source identity keeps offline local restores independent of the live driver.
const {
  fs,
  path,
  ensure,
  privateDirectory,
  openFile,
} = require("./system-backup-archive.cjs");
const storage = require("../server/dist/files/storage");
const areas = ["tmp", "quarantine", "ready"];
const remote = (root) => typeof root === "string" && root.startsWith("s3:");
async function sourceRoot(root) {
  if (storage.storageDriver() === "s3") {
    await storage.assertStorageBackendReady();
    return storage.storageIdentity();
  }
  root = await privateDirectory(root);
  ensure(
    (await fs.readdir(root)).every((x) => areas.includes(x)),
    "UNKNOWN_STORAGE_ENTRY",
  );
  for (const area of areas) await privateDirectory(path.join(root, area), root);
  return root;
}
function validate(root) {
  ensure(root === storage.storageIdentity(), "STORAGE_SOURCE_CHANGED");
}
async function entries(root, area) {
  if (remote(root)) {
    validate(root);
    return (await storage.listStorage(area)).map((x) => x.key);
  }
  return (await fs.readdir(path.join(root, area))).sort();
}
async function openSource(root, area, key) {
  if (!remote(root)) return openFile(path.join(root, area, key), root);
  validate(root);
  const f = await storage.materializeStorage(area, key);
  const close = f.handle.close.bind(f.handle);
  let closed = false;
  // dispose captures the handle method dynamically; restore it before releasing.
  f.handle.close = async () => {
    if (closed) return;
    closed = true;
    f.handle.close = close;
    await f.dispose();
  };
  return f.handle;
}
module.exports = { sourceRoot, entries, openSource, remote };
