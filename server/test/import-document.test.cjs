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
const types =
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const relationships =
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
async function docx(body = "原创培训：先复述，再确认。", extras = {}) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", types);
  zip.file("_rels/.rels", relationships);
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${body}</w:t></w:r></w:p></w:body></w:document>`,
  );
  for (const [name, value] of Object.entries(extras)) zip.file(name, value);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
function pdf(text = "Original training: confirm the goal.", pages = 1) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let i = 0; i < pages; i++) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    const chinese = /[^\x00-\x7f]/.test(text);
    const encoded = [...text]
      .map((_, i) => (i + 65).toString(16).padStart(2, "0"))
      .join("");
    const stream = text
      ? `BT /F1 12 Tf 72 720 Td ${chinese ? "<" + encoded + ">" : "(" + text + ")"} Tj ET`
      : "";
    objects.push(
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  if (/[^\x00-\x7f]/.test(text)) {
    const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapType 2 def 1 begincodespacerange <00> <ff> endcodespacerange ${[...text].length} beginbfchar \n${[...text].map((c, i) => "<" + (i + 65).toString(16).padStart(2, "0") + "> <" + c.charCodeAt(0).toString(16).padStart(4, "0") + ">").join("\n")}\nendbfchar endcmap end end`;
    objects[2] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode ${objects.length + 1} 0 R >>`;
    objects.push(
      `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`,
    );
  }
  let result = "%PDF-1.4\n",
    offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    result += `${String(offset).padStart(10, "0")} 00000 n \n`;
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}
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
