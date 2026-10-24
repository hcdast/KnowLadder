// Real disposable learner/catalogue trial. No .env, existing database or service.
"use strict";
const { MongoMemoryReplSet } = require('mongodb-memory-server-core');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { pathFixture } = require('./path-discovery-fixture.cjs');
const root=path.resolve(__dirname,'../..'), origin='http://localhost:5192';
const controlFile=path.join(root,'ops/artifacts/path-269-control.json');
const resultFile=path.join(root,'ops/artifacts/path-269-http.json');
(async()=>{
  let rs,f,vite;const cleanups=[],calls=[],courses=[];
  try{
    fs.mkdirSync(path.dirname(controlFile),{recursive:true});fs.writeFileSync(controlFile,'{}');
    rs=await MongoMemoryReplSet.create({binary:{version:'8.0.17'},replSet:{count:1,storageEngine:'wiredTiger'},instanceOpts:[{args:['--wiredTigerCacheSizeGB','0.25']}]});
    process.env.TEST_MONGODB_URI=rs.getUri('kl_test_path_browser');
    f=await pathFixture({after:cb=>cleanups.push(cb)});
    await f.db.collection('users').updateOne({_id:f.student.user.user_id},{$set:{display_name:'路径体验学员'}});
    for(let i=1;i<=22;i++)await f.publishPath('观察到表达 · 路径'+String(i).padStart(2,'0'));
    const {createServer}=await import(pathToFileURL(path.join(root,'web/node_modules/vite/dist/node/index.js')));
    const vue=(await import(pathToFileURL(path.join(root,'web/node_modules/@vitejs/plugin-vue/dist/index.mjs')))).default;
    vite=await createServer({configFile:false,root:path.join(root,'web'),plugins:[vue(),{name:'isolated-discovery',configureServer(server){server.middlewares.use((req,res,next)=>{
      const url=new URL(req.url,origin);if(!url.pathname.startsWith('/api/'))return next();
      if(req.headers.origin&&req.headers.origin!==origin){res.writeHead(403).end();return;}
      const headers={...req.headers,host:new URL(f.browser.base).host,origin:'http://127.0.0.1:5174',cookie:[...f.student.browser.cookies].map(([k,v])=>`${k}=${v}`).join('; ')};
      const outgoing=http.request(new URL(req.url,f.browser.base),{method:req.method,headers},upstream=>{
        calls.push({method:req.method,path:url.pathname,status:upstream.statusCode});fs.writeFileSync(resultFile,JSON.stringify({fixture:'isolated-real-http-and-mongo',paths:23,calls},null,2));
        const responseHeaders={...upstream.headers};delete responseHeaders['set-cookie'];res.writeHead(upstream.statusCode,responseHeaders);upstream.pipe(res);
      });outgoing.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(outgoing);
    });}}],server:{host:'localhost',port:5192,strictPort:true},clearScreen:false});
    await vite.listen();console.log('PATH_TRIAL_READY http://localhost:5192/training?tab=discover');
    let retired=false,working=false;
    await new Promise(resolve=>{const timer=setInterval(async()=>{
      if(working)return;working=true;
      try{const control=JSON.parse(fs.readFileSync(controlFile,'utf8'));
        if(control.retirePath&&!retired){const p=await f.db.collection('training_paths').findOne({_id:f.path.path._id});await f.good(f.author,`/phase2/paths/${p._id}/actions`,{action:'retire',expected_revision:p.revision,note:'隔离路径撤回'});retired=true;console.log('PATH_TRIAL_RETIRED');}
        if(control.stop){clearInterval(timer);resolve();}
      }catch(error){console.error('PATH_TRIAL_CONTROL',error.code||error.name);}finally{working=false;}
    },250);});
  }finally{await vite?.close();for(const cb of cleanups.reverse())await cb();await rs?.stop();fs.rmSync(controlFile,{force:true});}
})().catch(error=>{console.error('PATH_TRIAL_FAILED',error.code||error.name);process.exitCode=1;});
