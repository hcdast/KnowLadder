"use strict";
// Synthetic HTTPS S3 protocol fixture, not a provider compatibility certificate.
const https = require("node:https"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const access = "synthetic-test-access",
  secret = "synthetic-test-secret";
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
const hmac = (key, x) => crypto.createHmac("sha256", key).update(x).digest();
const enc = (x) =>
  encodeURIComponent(x).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
const xml = (x) =>
  String(x).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
function validSignature(req, body) {
  const auth = req.headers.authorization || "";
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(
      auth,
    );
  if (!match || match[1] !== access) return false;
  const [date, region, service, last] = match[2].split("/");
  if (region !== "us-east-1" || service !== "s3" || last !== "aws4_request")
    return false;
  const url = new URL(req.url, "https://localhost");
  const query = [...url.searchParams]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) =>
      a[0] < b[0]
        ? -1
        : a[0] > b[0]
          ? 1
          : a[1] < b[1]
            ? -1
            : a[1] > b[1]
              ? 1
              : 0,
    )
    .map(([k, v]) => k + "=" + v)
    .join("&");
  const headers =
    match[3]
      .split(";")
      .map(
        (k) =>
          k +
          ":" +
          String(req.headers[k] ?? "")
            .trim()
            .replace(/\s+/g, " "),
      )
      .join("\n") + "\n";
  const payload = req.headers["x-amz-content-sha256"] ?? sha(body);
  if (/^[a-f0-9]{64}$/.test(payload) && payload !== sha(body)) return false;
  const canonical = [
    req.method,
    url.pathname,
    query,
    headers,
    match[3],
    payload,
  ].join("\n");
  const toSign = [
    "AWS4-HMAC-SHA256",
    req.headers["x-amz-date"],
    match[2],
    sha(canonical),
  ].join("\n");
  const key = hmac(
    hmac(hmac(hmac("AWS4" + secret, date), region), "s3"),
    "aws4_request",
  );
  return crypto.timingSafeEqual(
    Buffer.from(match[4], "hex"),
    hmac(key, toSign),
  );
}
async function createS3Fixture() {
  const objects = new Map(),
    requests = [];
  const modes = {
    versioned: false,
    locked: false,
    deny: false,
    unauthorized: false,
    brokenPage: false,
    corrupt: false,
    versionOnDelete: false,
    stallGet: false,
    stallHead: false,
  };
  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(__dirname, "s3/tls-key.pem")),
      cert: fs.readFileSync(path.join(__dirname, "s3/tls-cert.pem")),
    },
    async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks),
        url = new URL(req.url, "https://localhost");
      requests.push({
        remotePort: req.socket.remotePort,
        method: req.method,
        path: url.pathname,
        query: url.search,
      });
      const error = (code, status) => {
        res.writeHead(status, { "Content-Type": "application/xml" });
        res.end(
          `<Error><Code>${code}</Code><Message>synthetic failure</Message></Error>`,
        );
      };
      if (!validSignature(req, body))
        return error("SignatureDoesNotMatch", 403);
      if (modes.unauthorized) return error("Unauthorized", 401);
      if (modes.deny) return error("AccessDenied", 403);
      const segments = url.pathname.split("/").filter(Boolean),
        bucket = segments.shift();
      if (bucket !== "test-bucket") return error("NoSuchBucket", 404);
      const key = decodeURIComponent(segments.join("/"));
      if (!key) {
        if (url.searchParams.has("versioning")) {
          res.setHeader("Content-Type", "application/xml");
          return res.end(
            `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${modes.versioned ? "<Status>Enabled</Status>" : ""}</VersioningConfiguration>`,
          );
        }
        if (url.searchParams.has("object-lock")) {
          if (!modes.locked)
            return error("ObjectLockConfigurationNotFoundError", 404);
          res.setHeader("Content-Type", "application/xml");
          return res.end(
            "<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>",
          );
        }
        if (req.method === "HEAD") { if(modes.stallHead)return; return res.end(); }
        if (url.searchParams.get("list-type") === "2") {
          const prefix = url.searchParams.get("prefix") ?? "",
            page = Number(url.searchParams.get("continuation-token") || 0);
          const all = [...objects.keys()]
              .filter((k) => k.startsWith(prefix))
              .sort(),
            keys = all.slice(page, page + 2),
            more = all.length > page + 2;
          res.setHeader("Content-Type", "application/xml");
          return res.end(
            `<ListBucketResult><Name>${bucket}</Name><Prefix>${xml(prefix)}</Prefix><IsTruncated>${more || modes.brokenPage}</IsTruncated>${more && !modes.brokenPage ? `<NextContinuationToken>${page + 2}</NextContinuationToken>` : ""}${keys.map((k) => `<Contents><Key>${xml(k)}</Key><LastModified>${objects.get(k).modified.toISOString()}</LastModified><ETag>"${sha(objects.get(k).bytes)}"</ETag><Size>${objects.get(k).bytes.length}</Size></Contents>`).join("")}</ListBucketResult>`,
          );
        }
        return error("NotImplemented", 501);
      }
      if (req.method === "PUT") {
        if (req.headers["if-none-match"] === "*" && objects.has(key))
          return error("PreconditionFailed", 412);
        objects.set(key, { bytes: body, modified: new Date() });
        res.setHeader("ETag", '"' + sha(body) + '"');
        return res.end();
      }
      if (req.method === "DELETE") {
        if (modes.versionOnDelete) modes.versioned = true;
        objects.delete(key);
        res.writeHead(204);
        return res.end();
      }
      const object = objects.get(key);
      if (!object) return error("NoSuchKey", 404);
      if (req.method === "GET" || req.method === "HEAD") {
        const bytes = modes.corrupt
          ? Buffer.alloc(object.bytes.length, 88)
          : object.bytes;
        res.setHeader("Content-Length", bytes.length);
        res.setHeader("Last-Modified", object.modified.toUTCString());
        res.setHeader("ETag", '"' + sha(bytes) + '"');
        if (modes.stallGet && req.method === "GET") {
          res.flushHeaders();
          return;
        }
        return res.end(req.method === "HEAD" ? undefined : bytes);
      }
      error("NotImplemented", 501);
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `https://127.0.0.1:${server.address().port}`,
    objects,
    modes,
    requests,
    access,
    secret,
    ca: path.join(__dirname, "s3/tls-cert.pem"),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
module.exports = { createS3Fixture };
