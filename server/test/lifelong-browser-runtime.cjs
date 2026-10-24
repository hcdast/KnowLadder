// Disposable full-App browser trial. No .env, external provider or existing service.
// Real replicaSet, migrations, identities, original records and authorization APIs.
"use strict";
const { MongoMemoryReplSet } = require("mongodb-memory-server-core");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { setup } = require("./lifelong-fixture.cjs");
const root = path.resolve(__dirname,"../..");
const artifactPrefix = process.env.KL_TRIAL_ARTIFACT_PREFIX || "lifelong-trial";
if (!/^[a-z0-9-]{1,60}$/.test(artifactPrefix)) throw Error("INVALID_TRIAL_ARTIFACT_PREFIX");
const controlFile = path.join(root,"ops/artifacts",`${artifactPrefix}-control.json`);
const resultFile = path.join(root,"ops/artifacts",`${artifactPrefix}-results.json`);
const origin = "http://localhost:5189";
(async()=>{
  let rs,f,vite,actor="learner"; const cleanups=[],calls=[];
  try {
    fs.mkdirSync(path.dirname(controlFile),{recursive:true}); fs.writeFileSync(controlFile,"{}");
    rs=await MongoMemoryReplSet.create({binary:{version:"8.0.17"},replSet:{count:1,storageEngine:"wiredTiger"},instanceOpts:[{args:["--wiredTigerCacheSizeGB","0.25"]}]});
    process.env.TEST_MONGODB_URI=rs.getUri("kl_test_lifelong_browser");
    f=await setup({after:cb=>cleanups.push(cb)});
    const people={ learner:await f.person(), child:await f.person(false), supporter:await f.person(), proposer:await f.person(), reviewer:await f.person() };
    const org=(await f.ops.createOrganization(f.context,{name:"原创全龄隔离试点",kind:"school"})).organization_id;
    for(const [name,roles] of [["child",["student"]],["supporter",["student"]],["proposer",["org_admin"]],["reviewer",["org_admin"]]])
      await f.ops.setMembership(f.context,{user_id:people[name].id,org_id:org,roles});
    for(const [name,display] of Object.entries({learner:"自主学习者",child:"模拟学校学习者",supporter:"家庭学习支持者",proposer:"关系核验发起人",reviewer:"独立复核人员"}))
      await f.db.collection("users").updateOne({_id:people[name].id},{$set:{display_name:display}});
    const cap=await f.good(people.learner,"/capabilities");
    for(const template of cap.templates){
      const goal=await f.good(people.learner,"/goals",{...f.goal(template.title),stage:template.stage,field:template.field,outcome:template.outcome,template_id:template.id});
      await f.good(people.learner,"/activities",{...f.activity(goal.resource_id),kind:template.activity,title:template.title+" · 第一次实践",note:"已阅读原创活动提示，完成第一步观察并记下自己的发现。",reflection:template.reflection});
    }
    const childGoal=await f.good(people.child,"/goals",{...f.goal("一周用水观察"),stage:"school"});
    await f.good(people.child,"/activities",{...f.activity(childGoal.resource_id),title:"记录一次安全的生活观察"});
    const future=new Date(Date.now()+30*86400000).toISOString();
    await f.good(people.proposer,"/assurances",{org_id:org,user_id:people.child.id,guardian_user_id:people.supporter.id,evidence_reference:"isolated-simulated-proof-001",policy_version:"isolated-trial-v1-not-real-identity-proof",transition_at:future,expires_at:future});
    const {createServer}=await import(pathToFileURL(path.join(root,"web/node_modules/vite/dist/node/index.js")));
    const vue=(await import(pathToFileURL(path.join(root,"web/node_modules/@vitejs/plugin-vue/dist/index.mjs")))).default;
    let lostReplyUsed=false;
    vite=await createServer({configFile:false,root:path.join(root,"web"),plugins:[vue(),{name:"isolated-lifelong-trial",configureServer(server){server.middlewares.use((req,res,next)=>{
      const url=new URL(req.url,origin), route=url.pathname;
      if(route==="/trial"){
        res.setHeader("Content-Type","text/html;charset=utf-8");res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>隔离全龄试点</title><h1>隔离全龄试点身份</h1><p>仅操作一次性测试账号和原创合成记录；无真实用户或监护证明。</p>${Object.keys(people).map(name=>`<form action="/__trial/actor" method="post"><button name="actor" value="${name}">${name}</button></form>`).join("")}`);return;
      }
      if(route==="/__trial/actor" && req.method==="POST"){
        if(req.headers.origin!==origin){res.writeHead(403).end();return;}
        let body="";req.on("data",chunk=>body+=chunk);req.on("end",()=>{const name=new URLSearchParams(body).get("actor");if(!Object.hasOwn(people,name)){res.writeHead(400).end();return;}actor=name;res.writeHead(303,{Location:"/personal"}).end();});return;
      }
      if(!route.startsWith("/api/"))return next();
      if(req.headers.origin && req.headers.origin!==origin){res.writeHead(403).end();return;}
      let control={};try{control=JSON.parse(fs.readFileSync(controlFile,"utf8"));}catch{}
      const who=people[actor], headers={...req.headers,host:new URL(f.browser.base).host,origin:"http://127.0.0.1:5174",cookie:[...who.browser.cookies].map(([k,v])=>`${k}=${v}`).join("; ")};
      const outgoing=http.request(new URL(req.url,f.browser.base),{method:req.method,headers},upstream=>{
        const entry={actor,method:req.method,path:route,status:upstream.statusCode};calls.push(entry);
        fs.writeFileSync(resultFile,JSON.stringify({fixture:"isolated-real-http-and-mongo",original_scenarios:6,actors:5,calls},null,2));
        if(!lostReplyUsed && req.method==="POST" && upstream.statusCode===200 &&
          ((control.loseNextGoalReply && route==="/api/v1/personal/goals") ||
           (control.loseNextUnitReply && /^\/api\/v1\/personal\/courses\/[^/]+\/units\/[^/]+\/complete$/.test(route)))){
          lostReplyUsed=true;upstream.resume();res.writeHead(503,{"Content-Type":"application/json"});res.end(JSON.stringify({error:{code:"ISOLATED_REPLY_LOST",message:"隔离试点：保存回包丢失"}}));return;}
        const responseHeaders={...upstream.headers};delete responseHeaders["set-cookie"];res.writeHead(upstream.statusCode,responseHeaders);upstream.pipe(res);
      });outgoing.on("error",()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(outgoing);
    });}}],server:{host:"localhost",port:5189,strictPort:true},clearScreen:false});
    await vite.listen();console.log("LIFELONG_TRIAL_READY http://localhost:5189/personal");
    await new Promise(resolve=>{const timer=setInterval(()=>{try{if(JSON.parse(fs.readFileSync(controlFile,"utf8")).stop){clearInterval(timer);resolve();}}catch{}},250);});
  } finally {await vite?.close();for(const cb of cleanups.reverse())await cb();await rs?.stop();fs.rmSync(controlFile,{force:true});}
})().catch(error=>{console.error("LIFELONG_TRIAL_FAILED",error.code||error.name);process.exitCode=1;});
