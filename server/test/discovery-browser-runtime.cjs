// Real disposable learner/catalogue trial. No .env, existing database or service.
"use strict";
const { MongoMemoryReplSet } = require('mongodb-memory-server-core');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { setup } = require('./training-isolated-helpers.cjs');
const root=path.resolve(__dirname,'../..'), origin='http://localhost:5191';
const controlFile=path.join(root,'ops/artifacts/discovery-268-control.json');
const resultFile=path.join(root,'ops/artifacts/discovery-268-http.json');
(async()=>{
  let rs,f,vite;const cleanups=[],calls=[],courses=[];
  try{
    fs.mkdirSync(path.dirname(controlFile),{recursive:true});fs.writeFileSync(controlFile,'{}');
    rs=await MongoMemoryReplSet.create({binary:{version:'8.0.17'},replSet:{count:1,storageEngine:'wiredTiger'},instanceOpts:[{args:['--wiredTigerCacheSizeGB','0.25']}]});
    process.env.TEST_MONGODB_URI=rs.getUri('kl_test_discovery_browser');
    f=await setup({after:cb=>cleanups.push(cb)});
    await f.db.collection('users').updateOne({_id:f.student.user.user_id},{$set:{display_name:'目录体验学员'}});
    const titles=['观察与事实表达','故事阅读与复述','比较公开证据','整理交接清单','创作三格故事','数字生活求助'];
    for(let i=0;i<24;i++){
      let c=await f.good(f.author,'/courses',{code:'original-discovery-'+i,title:titles[i%6]+' · '+String(i+1).padStart(2,'0'),subject_id:f.subject,version_no:1,
        lessons:[{key:'observe',title:'先记录事实，再说明解释',kind:'text',required:true,body:'选择一件日常小事，记录你直接观察到的事实。再写一句自己的解释，并检查二者是否被混在一起。',file_id:null,owner_version_id:null},
          {key:'reflect',title:'把观察用于一次表达',kind:'text',required:false,body:'用三句话描述事情的先后顺序，给出一条观察依据，并写下仍然不确定的地方。',file_id:null,owner_version_id:null}]});
      c=await f.good(f.author,`/courses/${c._id}/actions`,{action:'request-review',expected_revision:c.revision});
      c=await f.good(f.reviewer,`/courses/${c._id}/actions`,{action:'publish',expected_revision:c.revision,note:'隔离原创课程目录验收'});
      await f.good(f.author,`/courses/${c._id}/assign`,{class_id:f.classId});courses.push(c._id);
    }
    const {createServer}=await import(pathToFileURL(path.join(root,'web/node_modules/vite/dist/node/index.js')));
    const vue=(await import(pathToFileURL(path.join(root,'web/node_modules/@vitejs/plugin-vue/dist/index.mjs')))).default;
    vite=await createServer({configFile:false,root:path.join(root,'web'),plugins:[vue(),{name:'isolated-discovery',configureServer(server){server.middlewares.use((req,res,next)=>{
      const url=new URL(req.url,origin);if(!url.pathname.startsWith('/api/'))return next();
      if(req.headers.origin&&req.headers.origin!==origin){res.writeHead(403).end();return;}
      const headers={...req.headers,host:new URL(f.browser.base).host,origin:'http://127.0.0.1:5174',cookie:[...f.student.browser.cookies].map(([k,v])=>`${k}=${v}`).join('; ')};
      const outgoing=http.request(new URL(req.url,f.browser.base),{method:req.method,headers},upstream=>{
        calls.push({method:req.method,path:url.pathname,status:upstream.statusCode});fs.writeFileSync(resultFile,JSON.stringify({fixture:'isolated-real-http-and-mongo',courses:24,calls},null,2));
        const responseHeaders={...upstream.headers};delete responseHeaders['set-cookie'];res.writeHead(upstream.statusCode,responseHeaders);upstream.pipe(res);
      });outgoing.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(outgoing);
    });}}],server:{host:'localhost',port:5191,strictPort:true},clearScreen:false});
    await vite.listen();console.log('DISCOVERY_TRIAL_READY http://localhost:5191/training?tab=discover');
    let retired=false,working=false;
    await new Promise(resolve=>{const timer=setInterval(async()=>{
      if(working)return;working=true;
      try{const control=JSON.parse(fs.readFileSync(controlFile,'utf8'));
        if(control.retireNewest&&!retired){const c=await f.db.collection('courses').findOne({_id:courses.at(-1)});await f.good(f.reviewer,`/courses/${c._id}/actions`,{action:'retire',expected_revision:c.revision,note:'隔离目录撤回验收'});retired=true;console.log('DISCOVERY_TRIAL_NEWEST_RETIRED');}
        if(control.stop){clearInterval(timer);resolve();}
      }catch(error){console.error('DISCOVERY_TRIAL_CONTROL',error.code||error.name);}finally{working=false;}
    },250);});
  }finally{await vite?.close();for(const cb of cleanups.reverse())await cb();await rs?.stop();fs.rmSync(controlFile,{force:true});}
})().catch(error=>{console.error('DISCOVERY_TRIAL_FAILED',error.code||error.name);process.exitCode=1;});
