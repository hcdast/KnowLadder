"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const filename = path.resolve(__dirname, "../../web/src/administration/peopleSelection.ts");
const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exportsObject = {};
new Function("exports", source)(exportsObject);
test("管理用户定位接受当前ObjectId，拒绝旧UUID和不规范目标", () => {
  assert.equal(exportsObject.isUserId("6ac3ac95a54f1e4f081c8b12"), true);
  for (const invalid of ["6AC3AC95A54F1E4F081C8B12", "6ac3ac95a54f1e4f081c8b1", "6ac3ac95a54f1e4f081c8b120", "6ac3ac95-a54f-4e4f-881c-8b1212345678", "../users", " 6ac3ac95a54f1e4f081c8b12", ""]) assert.equal(exportsObject.isUserId(invalid), false, invalid);
});
