import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { TextDecoder } from "node:util";
import { extractRawText } from "mammoth";

export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const IMPORT_LIMITS = Object.freeze({
  bytes: 10 * 1024 * 1024,
  pages: 100,
  entries: 1000,
  expanded: 32 * 1024 * 1024,
  entryBytes: 8 * 1024 * 1024,
  characters: 80000,
  segments: 100,
});
export interface ImportPreview {
  format: "pdf" | "docx";
  segments: { ordinal: number; page: number | null; text: string }[];
  warnings: string[];
}
export function importFailure(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function inputLimit(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > IMPORT_LIMITS.bytes)
    importFailure("IMPORT_INPUT_LIMIT");
}

/** Inspect every expanded ZIP byte before passing it to a document parser. */
export async function validateDocx(bytes: Buffer): Promise<void> {
  inputLimit(bytes);
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true },
      (error, result) =>
        error || !result
          ? reject(Error("IMPORT_DOCX_INVALID"))
          : resolve(result),
    ),
  );
  await new Promise<void>((resolve, reject) => {
    let count = 0,
      total = 0,
      settled = false;
    const names = new Set<string>();
    const fail = (code: string) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(Error(code));
    };
    zip.on("error", () => fail("IMPORT_DOCX_INVALID"));
    zip.on("end", () => {
      if (settled) return;
      if (
        !["[Content_Types].xml", "_rels/.rels", "word/document.xml"].every(
          (name) => names.has(name),
        )
      )
        return fail("IMPORT_DOCX_INVALID");
      settled = true;
      resolve();
    });
    zip.on("entry", (entry: Entry) => {
      const name = entry.fileName;
      if (
        ++count > IMPORT_LIMITS.entries ||
        entry.uncompressedSize > IMPORT_LIMITS.entryBytes ||
        total + entry.uncompressedSize > IMPORT_LIMITS.expanded
      )
        return fail("IMPORT_ZIP_LIMIT");
      if (
        entry.generalPurposeBitFlag & 1 ||
        ![0, 8].includes(entry.compressionMethod) ||
        names.has(name) ||
        /(^\/|\\|(^|\/)\.\.?($|\/)|:|\x00)/.test(name)
      )
        return fail("IMPORT_DOCX_INVALID");
      if (/vbaProject|\.bin$|^word\/(embeddings|activeX)\//i.test(name))
        return fail("IMPORT_DOCX_ACTIVE_CONTENT");
      names.add(name);
      total += entry.uncompressedSize;
      if (name.endsWith("/")) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) return fail("IMPORT_DOCX_INVALID");
        let actual = 0;
        const parts: Buffer[] = [];
        const xml = /\.(xml|rels)$/i.test(name);
        stream.on("error", () => fail("IMPORT_DOCX_INVALID"));
        stream.on("data", (part: Buffer) => {
          actual += part.length;
          if (
            actual > entry.uncompressedSize ||
            actual > IMPORT_LIMITS.entryBytes
          ) {
            stream.destroy();
            fail("IMPORT_ZIP_LIMIT");
            return;
          }
          if (xml) parts.push(part);
        });
        stream.on("end", () => {
          if (settled) return;
          if (actual !== entry.uncompressedSize)
            return fail("IMPORT_DOCX_INVALID");
          if (xml) {
            let text: string;
            try {
              text = new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.concat(parts),
              );
            } catch {
              return fail("IMPORT_DOCX_INVALID");
            }
            const inspected = text
              .replace(
                /&#(?:x([0-9a-f]+)|(\d+));/gi,
                (_match, hex, decimal) => {
                  const value = parseInt(hex ?? decimal, hex ? 16 : 10);
                  return value <= 0x10ffff
                    ? String.fromCodePoint(value)
                    : "\uFFFD";
                },
              )
              .replace(/&quot;/g, '"')
              .replace(/&apos;/g, "'");
            if (
              /<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']\s*External|macroEnabled|altChunk/i.test(
                inspected,
              )
            )
              return fail("IMPORT_DOCX_ACTIVE_CONTENT");
            if (
              name === "[Content_Types].xml" &&
              !text.includes(
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
              )
            )
              return fail("IMPORT_DOCX_INVALID");
          }
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
}

function add(preview: ImportPreview, text: string, page: number | null) {
  const normalized = text.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  if (!normalized) return;
  if (
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      normalized,
    )
  )
    importFailure("IMPORT_TEXT_INVALID");
  if (
    preview.segments.length >= IMPORT_LIMITS.segments ||
    preview.segments.reduce((n, s) => n + [...s.text].length, 0) +
      [...normalized].length >
      IMPORT_LIMITS.characters
  )
    importFailure("IMPORT_TEXT_LIMIT");
  preview.segments.push({
    ordinal: preview.segments.length,
    page,
    text: normalized,
  });
}

/** Pure bounded extraction. A caller must verify ready/clean and current owner access. */
export async function extractDocument(
  bytes: Buffer,
  mime: string,
): Promise<ImportPreview> {
  inputLimit(bytes);
  if (mime === DOCX_MIME) {
    await validateDocx(bytes);
    const result = await extractRawText({ buffer: bytes });
    const preview: ImportPreview = {
      format: "docx",
      segments: [],
      warnings: ["CHECK_TABLES_AND_FORMULAS"],
    };
    for (const paragraph of result.value.split(/\n\s*\n/))
      add(preview, paragraph, null);
    if (!preview.segments.length) importFailure("IMPORT_NO_TEXT");
    return preview;
  }
  if (mime !== "application/pdf") importFailure("IMPORT_FORMAT_UNSUPPORTED");
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-")
    importFailure("IMPORT_PDF_INVALID");
  const load = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<any>;
  const pdf = await load("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdf.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
  });
  task.onPassword = () => {
    void task.destroy();
  };
  let document: any;
  try {
    document = await task.promise;
    if (document.numPages > IMPORT_LIMITS.pages)
      importFailure("IMPORT_PAGE_LIMIT");
    const preview: ImportPreview = {
      format: "pdf",
      segments: [],
      warnings: ["CHECK_READING_ORDER_TABLES_AND_FORMULAS"],
    };
    let empty = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .filter((item: any) => typeof item.str === "string")
        .map((item: any) => item.str + (item.hasEOL ? "\n" : " "))
        .join("");
      if (!text.trim()) empty++;
      add(preview, text, pageNumber);
      page.cleanup();
    }
    if (!preview.segments.length) importFailure("IMPORT_OCR_REQUIRED");
    if (empty) preview.warnings.push("SOME_PAGES_HAVE_NO_TEXT");
    return preview;
  } catch (error) {
    if (error instanceof Error && /^IMPORT_[A-Z_]+$/.test(error.message))
      throw error;
    importFailure("IMPORT_PDF_INVALID_OR_ENCRYPTED");
  } finally {
    await task.destroy();
  }
}
