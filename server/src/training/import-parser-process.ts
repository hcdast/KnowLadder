import { fork } from "node:child_process";
import {
  extractDocument,
  validateDocx,
  importFailure,
  IMPORT_LIMITS,
  type ImportPreview,
} from "./import-document";

/** A parser subprocess receives only document bytes; never inherits API secrets. */
export function extractInProcess(
  bytes: Buffer,
  mime: string,
  validationOnly = false,
): Promise<ImportPreview> {
  if (!bytes.length || bytes.length > IMPORT_LIMITS.bytes)
    importFailure("IMPORT_INPUT_LIMIT");
  return new Promise((resolve, reject) => {
    const child = fork(__filename, ["--parse"], {
      execPath: process.execPath,
      execArgv: ["--max-old-space-size=256"],
      serialization: "advanced",
      env: {
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        NODE_ENV: "production",
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    let settled = false;
    const finish = (error?: Error, result?: ImportPreview) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(
      () => finish(Error("IMPORT_PARSER_TIMEOUT")),
      30000,
    );
    child.on("error", () => finish(Error("IMPORT_PARSER_FAILED")));
    child.on("exit", () => finish(Error("IMPORT_PARSER_INTERRUPTED")));
    child.on("message", (message: any) => {
      if (message?.error)
        return finish(
          Error(
            /^IMPORT_[A-Z_]+$/.test(message.error)
              ? message.error
              : "IMPORT_PARSER_FAILED",
          ),
        );
      if (validationOnly && message?.validated === true)
        return finish(undefined, {
          format: "docx",
          segments: [],
          warnings: [],
        });
      const result = message?.result;
      if (
        !result ||
        !["pdf", "docx"].includes(result.format) ||
        !Array.isArray(result.segments) ||
        !result.segments.length ||
        result.segments.length > IMPORT_LIMITS.segments ||
        !Array.isArray(result.warnings)
      )
        return finish(Error("IMPORT_PARSER_FAILED"));
      let characters = 0;
      for (const [ordinal, segment] of result.segments.entries()) {
        if (
          typeof segment.text !== "string" ||
          segment.ordinal !== ordinal ||
          !(
            segment.page === null ||
            (Number.isInteger(segment.page) &&
              segment.page >= 1 &&
              segment.page <= IMPORT_LIMITS.pages)
          )
        )
          return finish(Error("IMPORT_PARSER_FAILED"));
        characters += [...segment.text].length;
      }
      if (
        characters > IMPORT_LIMITS.characters ||
        result.warnings.some(
          (code: unknown) =>
            typeof code !== "string" || !/^[A-Z_]+$/.test(code),
        )
      )
        return finish(Error("IMPORT_PARSER_FAILED"));
      finish(undefined, result);
    });
    child.send({ bytes, mime, validationOnly }, (error) => {
      if (error) finish(Error("IMPORT_PARSER_FAILED"));
    });
  });
}

if (require.main === module && process.argv[2] === "--parse") {
  process.once("message", async (message: any) => {
    try {
      if (!Buffer.isBuffer(message?.bytes) || typeof message.mime !== "string")
        importFailure("IMPORT_PARSER_FAILED");
      if (message.validationOnly) {
        await validateDocx(message.bytes);
        process.send?.({ validated: true }, () => process.disconnect());
        return;
      }
      const result = await extractDocument(message.bytes, message.mime);
      process.send?.({ result }, () => process.disconnect());
    } catch (error) {
      const code =
        error instanceof Error && /^IMPORT_[A-Z_]+$/.test(error.message)
          ? error.message
          : "IMPORT_PARSER_FAILED";
      process.send?.({ error: code }, () => process.disconnect());
    }
  });
}
