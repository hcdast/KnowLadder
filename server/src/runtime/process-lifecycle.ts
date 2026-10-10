import { activeWriterTokens } from "./writer-identity";
import { resolveFeatureFlags } from "./feature-flags";
let runtimeReady = false;
const transientMongoNames = new Set([
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoServerSelectionError",
  "MongoPoolClearedError",
  "MongoWaitQueueTimeoutError",
]);
export function runtimeFailureExitCode(error?: unknown) {
  if (process.env.KL_PM2_PROTOCOL !== "2") return 1;
  // Retry only known transient connection failures after readiness and after
  // all owned registrations were released. Startup/safety failures stay fatal.
  const e = error as { name?: string } | undefined;
  if (
    runtimeReady &&
    activeWriterTokens().length === 0 &&
    transientMongoNames.has(e?.name ?? "")
  )
    return 1;
  return 78;
}
/** A rejected startup can leave driver sockets alive before Nest returns an app.
 * Ordinary finally blocks have already run; bound the failed process lifetime.
 * Stop verification still rejects any unreleased registration.
 */
export function finishRuntimeFailure(component: string, error: unknown) {
  reportFailure(component, error);
  const code = runtimeFailureExitCode(error);
  process.exitCode = code;
  if (process.connected) process.disconnect();
  const deadline = setTimeout(() => process.exit(code), 5000);
  deadline.unref();
}
/** PM2 IPC on Windows; signals remain supported for ordinary CLI/Unix launches. */
export function installShutdown(stop: () => void | Promise<void>) {
  let requested = false;
  const request = () => {
    if (requested) return;
    requested = true;
    void Promise.resolve()
      .then(stop)
      .catch((error) => {
        finishRuntimeFailure("shutdown", error);
      });
  };
  const message = (value: unknown) => {
    if (value === "shutdown") request();
  };
  process.on("SIGINT", request);
  process.on("SIGTERM", request);
  process.on("message", message);
  return () => {
    process.off("SIGINT", request);
    process.off("SIGTERM", request);
    process.off("message", message);
    if (requested && process.connected) process.disconnect();
  };
}
export function notifyReady() {
  runtimeReady = true;
  if (
    ["1", "2"].includes(process.env.KL_PM2_PROTOCOL ?? "") &&
    process.send &&
    process.connected
  ) {
    process.send({
      type: "process:msg",
      data: {
        event: "kl-ready",
        pid: process.pid,
        token: process.env.KL_WRITER_LAUNCH_TOKEN,
        writerTokens: activeWriterTokens(),
      },
    });
    process.send("ready");
  }
}
export function validateRuntimeFlags() {
  resolveFeatureFlags();
}
const nodeCodes = new Set([
  "EADDRINUSE",
  "EACCES",
  "ENOENT",
  "ECONNREFUSED",
  "ETIMEDOUT",
]);
export function safeErrorCode(error: unknown): string {
  const e = error as { code?: unknown; message?: unknown; name?: unknown };
  if (e?.code === 11000) return "MONGO_DUPLICATE_KEY";
  if (e?.code === 8000) return "MONGO_COMMAND_RESTRICTED";
  if (e?.code === 13) return "MONGO_NOT_AUTHORIZED";
  if (e?.code === 121) return "MONGO_DOCUMENT_VALIDATION_FAILED";
  if (
    [
      "RUNTIME_CHECK_FAILED",
      "MONGO_UNREACHABLE",
      "MONGO_CONNECTION_INTERRUPTED",
      "MONGO_DUPLICATE_KEY",
      "MONGO_COMMAND_RESTRICTED",
      "MONGO_NOT_AUTHORIZED",
      "MONGO_DOCUMENT_VALIDATION_FAILED",
      "NODE_VERSION_REQUIRED",
      "LOCAL_PM2_NONPRODUCTION_REQUIRED",
      "FEATURE_RESOLUTION_FAILED",
      "WORKER_REGISTRATION_REQUIRED",
    ].includes(String(e?.message))
  )
    return String(e.message);
  if (typeof e?.message === "string") {
    if (e.message.startsWith("ObjectId validator mismatch:"))
      return "SCHEMA_VALIDATOR_MISMATCH";
    if (e.message.startsWith("ObjectId index mismatch:"))
      return "SCHEMA_INDEX_MISMATCH";
    if (e.message === "ObjectId collection registry mismatch")
      return "SCHEMA_COLLECTION_REGISTRY_MISMATCH";
    if (/resolve dependencies/.test(e.message) && e.message.startsWith("Nest"))
      return "NEST_DEPENDENCY_RESOLUTION_FAILED";
    if (e.message === "UNKNOWN_COLLECTION") return "SCHEMA_UNKNOWN_COLLECTION";
    const schema = e.message.match(
      /\bv(1[0-9]|20|21)\b.*(?:migration|required|incomplete)/i,
    );
    if (schema) return "SCHEMA_V" + schema[1] + "_REQUIRED";
    const field = e.message.match(
      /\b(MONGODB_URI|APP_ORIGIN|AUTH_RATE_LIMIT_KEY|PORT|KL_MONGO_TOPOLOGY|SESSION_[A-Z_]+|SCAN_[A-Z_]+|FILE_STORAGE_ROOT|CLAMSCAN_PATH|CLAMAV_DATABASE)\b/,
    );
    if (field) return "INVALID_CONFIG_" + field[1];
  }
  if (typeof e?.code === "string" && nodeCodes.has(e.code)) return e.code;
  if (typeof e?.message === "string" && nodeCodes.has(e.message))
    return e.message;
  if (
    typeof e?.message === "string" &&
    /^(?:INVALID_FLAG_|INVALID_CONFIG_|SCHEMA_|FEATURE_|MANAGED_|RECOVERY_|STANDALONE_|OPERATIONS_|S3_|STORAGE_)[A-Z0-9_]{1,90}$/.test(
      e.message,
    )
  )
    return e.message;
  if (typeof e?.name === "string" && transientMongoNames.has(e.name))
    return e.name === "MongoServerSelectionError"
      ? "MONGO_UNREACHABLE"
      : "MONGO_CONNECTION_INTERRUPTED";
  return "RUNTIME_CHECK_FAILED";
}
export function reportFailure(component: string, error: unknown) {
  console.error(
    JSON.stringify({
      event: "runtime.failed",
      component,
      code: safeErrorCode(error),
    }),
  );
}
