"use strict";
// Keep a compact public-contract fingerprint; never use this summary to generate API types.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const methods = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
]);
function summarize(bytes, source) {
  const document = JSON.parse(bytes.toString("utf8"));
  if (
    typeof document.openapi !== "string" ||
    !/^3\./.test(document.openapi) ||
    !document.paths ||
    typeof document.paths !== "object" ||
    Array.isArray(document.paths) ||
    Object.entries(document.paths).some(
      ([route, operations]) =>
        !route.startsWith("/") ||
        !operations ||
        typeof operations !== "object" ||
        Array.isArray(operations),
    )
  )
    throw Error("OPENAPI_DOCUMENT_REQUIRED");
  const routes = Object.entries(document.paths)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([route, operations]) => ({
      path: route,
      methods: Object.keys(operations)
        .filter((method) => methods.has(method))
        .sort(),
    }));
  return {
    format: "knowladder-openapi-evidence-summary-1",
    source,
    source_sha256: createHash("sha256").update(bytes).digest("hex"),
    source_bytes: bytes.length,
    openapi_version: document.openapi,
    api_version:
      typeof document.info?.version === "string" ? document.info.version : null,
    path_count: routes.length,
    operation_count: routes.reduce(
      (sum, route) => sum + route.methods.length,
      0,
    ),
    component_schema_count: Object.keys(document.components?.schemas || {})
      .length,
    purpose:
      "Historical validation fingerprint and route inventory; use the application's full OpenAPI for type generation.",
    routes,
  };
}
function main() {
  const [input, output, ref] = process.argv.slice(2);
  if (
    !input ||
    !output ||
    process.argv.length > 5 ||
    (ref && !/^[A-Za-z0-9_./-]+$/.test(ref))
  )
    throw Error("OPENAPI_SUMMARY_ARGUMENTS_REQUIRED");
  const root = path.resolve(__dirname, "..");
  const absolute = path.resolve(input);
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (ref && (relative.startsWith("../") || path.isAbsolute(relative)))
    throw Error("OPENAPI_GIT_SOURCE_REQUIRED");
  const revision = ref
    ? execFileSync("git", ["rev-parse", "--verify", ref + "^{commit}"], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      }).trim()
    : null;
  const bytes = ref
    ? execFileSync("git", ["show", revision + ":" + relative], {
        cwd: root,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      })
    : fs.readFileSync(absolute);
  if (bytes.length > 64 * 1024 * 1024)
    throw Error("OPENAPI_SUMMARY_SIZE_LIMIT");
  const result = summarize(bytes, {
    artifact: path.basename(input),
    kind: ref ? "git-committed-snapshot" : "local-generated-artifact",
    revision,
  });
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      ok: true,
      paths: result.path_count,
      operations: result.operation_count,
      source_bytes: bytes.length,
    }),
  );
}
module.exports = { summarize };
if (require.main === module) {
  try {
    main();
  } catch {
    console.error("OPENAPI_SUMMARY_FAILED");
    process.exitCode = 1;
  }
}
