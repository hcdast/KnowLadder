"use strict";
const JSZip = require("jszip");
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

module.exports = { docx, pdf };
