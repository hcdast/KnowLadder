const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setup}=require('./training-isolated-helpers.cjs');
const {status}=require('./helpers.cjs');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const {newId}=require('../dist/database/object-id');
test('公开SSR：真实草稿/独立发布、转义、站点地图、组织禁用与私有路由拒绝',async t=>{
 const f=await setup(t);process.env.KL_SITE_ORG_ID=f.org;
 const editor=await f.actor(['teacher'],['site:edit']);const reviewer=await f.actor(['teacher'],['site:review']);
 const request=(a,p,b)=>a.browser.request('/site'+p,{method:'POST',body:b,headers:{'X-Org-Id':f.org,'Idempotency-Key':require('node:crypto').randomUUID()}});
 const draft=await request(editor,'/drafts',{page_key:'home',title:'原创 <script>alert(1)</script>',body:'培训内容 <img src=x onerror=alert(1)> & 安全'});status(draft,200);
 const {createPublicSiteServer}=await import(pathToFileURL(path.resolve(__dirname,'../../ops/site-server.mjs')));
 const apiOrigin=new URL(f.browser.base).origin;
 const server=await createPublicSiteServer({apiOrigin,siteOrigin:'https://example.test'});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 assert.equal((await fetch(base+'/')).status,404);
 const pub=await request(reviewer,'/drafts/'+draft.data.data._id+'/publish',{expected_revision:draft.data.data.revision});status(pub,200);
 const response=await fetch(base+'/',{headers:{Host:'evil.test',Cookie:'private=secret',Authorization:'Bearer secret'}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const html=await response.text();assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('https://example.test/'));assert.ok(!html.includes('evil.test'));assert.ok(html.includes('跳至正文'));assert.ok(html.includes('aria-current="page"'));
 const sitemap=await(await fetch(base+'/sitemap.xml')).text();assert.ok(sitemap.includes('<loc>https://example.test/</loc>'));assert.ok(!sitemap.includes('/features'));assert.ok(!sitemap.includes('/training'));
 assert.equal((await fetch(base+'/training')).status,404);assert.equal((await fetch(base+'/',{method:'POST'})).status,405);assert.equal(await(await fetch(base+'/',{method:'HEAD'})).text(),'');
 await f.db.collection('organizations').updateOne({_id:f.org},{$set:{status:'disabled'}});assert.equal((await fetch(base+'/')).status,404);assert.ok(!(await(await fetch(base+'/sitemap.xml')).text()).includes('<url>'));
});

test('站点配置边界与咨询授权：公开关闭、非法配置、撤权和运维隔离', {timeout:180000}, async t=>{
 const f=await setup(t,{
  KL_SITE_ORG_ID:'',
  KL_SITE_HANDLER_MEMBER_ID:'',
  KL_SITE_LEAD_RETENTION_DAYS:'7',
  KL_ENVIRONMENT_ID:'',
 });
 const {Browser}=require('./helpers.cjs');
 const {randomUUID,randomBytes,createHash}=require('node:crypto');
 const browser=new Browser(f.browser.base);
 const page=()=>browser.request('/site/pages/home');
 const consultation=body=>browser.request('/site/consultations',{method:'POST',body});
 const closed={page:null,consultation_enabled:false,retention_days:null};
 for(const value of [undefined,'',' \t\n']){
  if(value===undefined)delete process.env.KL_SITE_ORG_ID;else process.env.KL_SITE_ORG_ID=value;
  const response=await page();status(response,200);assert.deepEqual(response.data.data,closed);
  const blocked=await consultation({});status(blocked,503);assert.equal(blocked.data.error.code,'SITE_LEADS_DISABLED');
 }
 for(const value of ['invalid','0123456789ABCDEF01234567',' 0123456789abcdef01234567']){
  process.env.KL_SITE_ORG_ID=value;
  for(const response of [await page(),await consultation({})]){
   status(response,503);assert.equal(response.data.error.code,'SITE_CONFIGURATION_INVALID');
  }
 }
 process.env.KL_SITE_ORG_ID=f.org;
 const editor=await f.actor(['teacher'],['site:edit']);
 const reviewer=await f.actor(['teacher'],['site:review','site:lead-read']);
 process.env.KL_SITE_HANDLER_MEMBER_ID=reviewer.member;
 const write=(a,path,body)=>a.browser.request('/site'+path,{method:'POST',body,headers:{'X-Org-Id':f.org,'Idempotency-Key':randomUUID()}});
 const draft=await write(editor,'/drafts',{page_key:'home',title:'真实授权公开页',body:'咨询保留政策'});status(draft,200);
 status(await write(reviewer,'/drafts/'+draft.data.data._id+'/publish',{expected_revision:draft.data.data.revision}),200);
 let response=await page();status(response,200);
 assert.deepEqual(response.data.data,{page:{title:'真实授权公开页',body:'咨询保留政策'},consultation_enabled:true,retention_days:7});
 const body={receipt:randomBytes(32).toString('hex'),contact:'isolated@example.invalid',name:'隔离咨询',kind:'enterprise',consent:true};
 status(await consultation(body),200);
 const lead=await f.db.collection('site_leads').findOne({receipt_hash:createHash('sha256').update(body.receipt).digest('hex')});
 assert.equal(lead.org_id,f.org);assert.equal(lead.expires_at.getTime()-lead.consent_at.getTime(),7*86400000);
 const grants=f.db.collection('member_capability_grants');
 const filter={org_id:f.org,member_id:reviewer.member,capability:'site:lead-read'};
 await grants.updateOne(filter,{$set:{status:'revoked'}});
 response=await page();status(response,200);
 assert.deepEqual(response.data.data,{page:{title:'真实授权公开页',body:'咨询保留政策'},consultation_enabled:false,retention_days:null});
 response=await consultation({...body,receipt:randomBytes(32).toString('hex')});status(response,503);assert.equal(response.data.error.code,'SITE_LEADS_DISABLED');
 assert.equal(await f.db.collection('site_leads').countDocuments(),1);
 await grants.updateOne(filter,{$set:{status:'active'}});
 const states=f.db.collection('operational_state');
 const original=await states.findOne({_id:'environment'});
 process.env.KL_ENVIRONMENT_ID=randomUUID();
 try{
  for(const mode of ['maintenance','restore_quarantined']){
   await states.updateOne({_id:'environment'},{$set:{
    mode,environment_id:process.env.KL_ENVIRONMENT_ID,
    maintenance_token:mode==='maintenance'?randomUUID():null,
    restore_id:mode==='restore_quarantined'?newId():null,
   }});
   for(const blocked of [await page(),await consultation({...body,receipt:randomBytes(32).toString('hex')})]){
    status(blocked,503);assert.equal(blocked.data.error.code,'DEPENDENCY_UNAVAILABLE');
   }
  }
 }finally{
  const {_id,...state}=original;await states.updateOne({_id},{$set:state});
 }
 response=await page();status(response,200);assert.equal(response.data.data.consultation_enabled,true);assert.equal(response.data.data.retention_days,7);
 await f.db.collection('organizations').updateOne({_id:f.org},{$set:{status:'disabled'}});
 response=await page();status(response,200);assert.deepEqual(response.data.data,closed);
 response=await consultation({...body,receipt:randomBytes(32).toString('hex')});status(response,503);assert.equal(response.data.error.code,'SITE_LEADS_DISABLED');
});
