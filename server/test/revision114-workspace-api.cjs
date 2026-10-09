"use strict";
const { MongoMemoryReplSet } = require("mongodb-memory-server-core");
const { assessmentFixture, createQuestion, practice, good } = require("./assessment-helpers.cjs");
const { administrativeGrant } = require("./administration-helpers.cjs");
const { Browser, PASSWORD } = require("./helpers.cjs");
(async () => {
  const cleanup = [];
  let rs;
  try {
    rs = await MongoMemoryReplSet.create({ binary: { version: "8.0.17" }, replSet: { count: 1, storageEngine: "wiredTiger" }, instanceOpts: [{ args: ["--wiredTigerCacheSizeGB", "0.25"] }] });
    process.env.TEST_MONGODB_URI = rs.getUri("kl_test_workspace_114");
    const origin = "http://127.0.0.1:5204";
    const original = Browser.prototype.request;
    Browser.prototype.request = function (path, options = {}) { return original.call(this, path, { ...options, origin }); };
    const f = await assessmentFixture({ after: cb => cleanup.push(cb) }, { env: { APP_ORIGIN: origin, FILE_SCAN_ENABLED: "false" } });
    for (let i = 0; i < 2; i++) f.questions.push(await createQuestion(f, { title: `原创证据补充题${i + 1}` }));
    const session = await practice(f, { count: 5 });
    await good(f.student, `/sessions/${session.id}/submissions`, { method: "POST", body: { expected_revision: session.revision, answers: [] } }, 202);
    for (let i = 0; i < 30; i++) if (!await require("../dist/assessment/worker").processOne(f.db)) break;
    for (let i = 0; i < 40; i++) if (!await require("../dist/learning/worker").processOne(f.db)) { await require("../dist/learning/worker").processDue(f.db); break; }
    const evidence = await good(f.student, `/me/mastery?subject_id=${f.subject}`);
    if (evidence.items[0]?.independent_question_count !== 5) throw Error("LEARNING_EVIDENCE_NOT_READY");
    const { randomUUID } = require('node:crypto');
    const longBody = Array.from({length:400},(_,i)=>'原创段落'+i+'：逐段阅读，核对知识与实践。').join('\n');
    await f.db.collection('chapters').updateOne({_id:f.chapterId},{$set:{body:longBody}});
    const event = (revision, offset) => ({event_type:'reading_progress_set',event_id:randomUUID(),textbook_edition_id:f.book.id,chapter_id:f.chapterId,edition_revision:f.book.revision,expected_revision:revision,position:{kind:'text_offset',offset_utf16:offset},completed:false});
    await good(f.student,'/behavior-events',{method:'POST',body:event(0,1500)});
    process.on('message',async m=>{if(m.command==='remote'){try {const head=(await good(f.student,'/me/reading-progress?textbook_edition_id='+f.book.id)).items[0];const value=await good(f.student,'/behavior-events',{method:'POST',body:event(head.progress_revision,3000)});process.send?.({request_id:m.request_id,result:value});}catch(e){process.send?.({request_id:m.request_id,error:e.code||e.name});}}});
    const admin = await f.actor(["org_admin"]);
    await administrativeGrant(f, admin, "account:manage");
    const actors = Object.fromEntries(Object.entries({ editor: f.editor, student: f.student, admin }).map(([role, actor]) => [role, { login: actor.user.login_name, password: PASSWORD }]));
    process.send?.({ ready: true, base: f.browser.base, actors });
    await new Promise(resolve => {
      process.on("message", message => { if (message.stop) resolve(); });
      process.once("disconnect", resolve);
      process.once("SIGTERM", resolve);
    });
  } catch (error) { console.error(error.code || error.name, error.message?.slice(0, 100)); process.exitCode = 1; }
  finally {
    for (const cb of cleanup.reverse()) await cb();
    await rs?.stop();
    if (process.connected) process.disconnect();
  }
})();
