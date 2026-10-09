const {test}=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');const path=require('node:path');const {pathToFileURL}=require('node:url');
test('SSR安全：不转发会话、限制响应、依赖故障关闭、配置拒绝',async t=>{
 const {createPublicSiteServer}=await import(pathToFileURL(path.resolve(__dirname,'../../ops/site-server.mjs')));
 let mode='ok';let seen;const api=http.createServer((req,res)=>{seen=req.headers;res.setHeader('Content-Type','application/json');if(mode==='large')return res.end('x'.repeat(100001));if(mode==='fail'){res.writeHead(503);return res.end();}res.end(JSON.stringify({data:{page:{title:'原创',body:'正文'}}}));});await new Promise(r=>api.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>api.close(r)));
 const apiOrigin='http://127.0.0.1:'+api.address().port;await assert.rejects(()=>createPublicSiteServer({apiOrigin:'https://remote.test',siteOrigin:'https://example.test'}));
 const server=await createPublicSiteServer({apiOrigin,siteOrigin:'https://example.test'});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 assert.equal((await fetch(base+'/',{headers:{Cookie:'secret',Authorization:'secret'}})).status,200);assert.equal(seen.cookie,undefined);assert.equal(seen.authorization,undefined);
 mode='large';assert.equal((await fetch(base+'/')).status,503);mode='fail';assert.equal((await fetch(base+'/sitemap.xml')).status,503);assert.equal((await fetch(base+'/assets/missing.js')).status,404);
});
