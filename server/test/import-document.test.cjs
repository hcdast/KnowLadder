const { test } = require("node:test");
const assert = require("node:assert/strict");
const JSZip = require("jszip");
const {
  extractDocument,
  validateDocx,
  DOCX_MIME,
  IMPORT_LIMITS,
} = require("../dist/training/import-document");
const { extractInProcess } = require("../dist/training/import-parser-process");
const { docx, pdf } = require("./fixtures/import-documents.cjs");
test("原创DOCX：纯文本及受限子进程输出一致，无HTML", async () => {
  const bytes = await docx();
  const a = await extractDocument(bytes, DOCX_MIME),
    b = await extractInProcess(bytes, DOCX_MIME);
  assert.deepEqual(a, b);
  assert.equal(a.segments[0].text, "原创培训：先复述，再确认。");
  assert.equal(a.segments[0].page, null);
  assert.deepEqual(
    (await extractInProcess(bytes, DOCX_MIME, true)).segments,
    [],
  );
});
test("DOCX：坏容器、宏、外部关系、DTD和解压炸弹拒绝", async () => {
  await assert.rejects(validateDocx(Buffer.from("not-a-zip")));
  for (const extras of [
    { "word/vbaProject.bin": "macro" },
    {
      "word/_rels/document.xml.rels":
        '<Relationship TargetMode="External" Target="https://provider.invalid"/>',
    },
    {
      "word/_rels/document.xml.rels":
        '<Relationship TargetMode="E&#x78;ternal" Target="https://provider.invalid"/>',
    },
    {
      "word/styles.xml":
        '<!DOCTYPE test [<!ENTITY e SYSTEM "file:///private">]><test/>',
    },
  ]) {
    await assert.rejects(
      extractInProcess(await docx("原创", extras), DOCX_MIME),
      /IMPORT_DOCX_ACTIVE_CONTENT/,
    );
  }
  await assert.rejects(
    validateDocx(
      await docx("原创", {
        "word/media/huge.dat": Buffer.alloc(IMPORT_LIMITS.entryBytes + 1),
      }),
    ),
    /IMPORT_ZIP_LIMIT/,
  );
});
test("DOCX：80000码点上限不静默截断、空文本和未知格式拒绝", async () => {
  await assert.rejects(
    extractInProcess(await docx("字".repeat(80001)), DOCX_MIME),
    /IMPORT_TEXT_LIMIT/,
  );
  await assert.rejects(
    extractDocument(await docx(""), DOCX_MIME),
    /IMPORT_NO_TEXT/,
  );
  await assert.rejects(
    extractDocument(Buffer.from("test"), "application/msword"),
    /IMPORT_FORMAT_UNSUPPORTED/,
  );
});
test("原创文本PDF：页面定位和子进程提取", async () => {
  const preview = await extractInProcess(pdf(), "application/pdf");
  assert.equal(preview.format, "pdf");
  assert.equal(preview.segments[0].page, 1);
  assert.match(preview.segments[0].text, /confirm the goal/);
  const chinese = await extractInProcess(
    pdf("原创中文沟通培训"),
    "application/pdf",
  );
  assert.equal(chinese.segments[0].text, "原创中文沟通培训");
});
test("PDF：无文本提示OCR、101页和破损文件拒绝", async () => {
  await assert.rejects(
    extractInProcess(pdf(""), "application/pdf"),
    /IMPORT_OCR_REQUIRED/,
  );
  await assert.rejects(
    extractInProcess(pdf("Original", 101), "application/pdf"),
    /IMPORT_PAGE_LIMIT/,
  );
  await assert.rejects(
    extractInProcess(Buffer.from("%PDF-broken"), "application/pdf"),
    /IMPORT_PDF_INVALID_OR_ENCRYPTED/,
  );
});
test("文件格式开关：DOCX需要三开关，默认不改变历史MIME", () => {
  const original = { ...process.env };
  try {
    const { allowedFileMimes } = require("../dist/files/config");
    delete process.env.KL_KNOWLEDGE_IMPORT_ENABLED;
    assert.ok(!allowedFileMimes().includes(DOCX_MIME));
    process.env.KL_KNOWLEDGE_IMPORT_ENABLED = "true";
    process.env.KL_TRAINING_ENABLED = "true";
    process.env.KL_KNOWLEDGE_ENABLED = "true";
    assert.ok(allowedFileMimes().includes(DOCX_MIME));
    process.env.KL_KNOWLEDGE_ENABLED = "false";
    assert.ok(!allowedFileMimes().includes(DOCX_MIME));
  } finally {
    for (const k of Object.keys(process.env))
      if (!(k in original)) delete process.env[k];
    Object.assign(process.env, original);
  }
});
