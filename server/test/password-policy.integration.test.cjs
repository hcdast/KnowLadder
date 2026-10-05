'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {randomInt}=require('node:crypto');const {promisify}=require('node:util');const {execFile}=require('node:child_process');const path=require('node:path');const {fixture,status,PASSWORD}=require('./helpers.cjs');
for(const topology of ['replicaSet','standalone'])test('Password minimum 6: '+topology,async t=>{
 const f=await fixture(t,{topology});const user=await f.user();const browser=f.browser;
 await browser.prepare();status(await browser.login(user.login_name,user.secret),200);await browser.prepare();const oldSession=browser.clone();
 const short=String(randomInt(100000,1000000));
 for(const invalid of [short.slice(0,5),'😀'.repeat(5),'a'.repeat(129)])status(await browser.request('/auth/change-password',{method:'POST',body:{current_password:user.secret,new_password:invalid}}),422);
 status(await browser.request('/auth/change-password',{method:'POST',body:{current_password:user.secret,new_password:short}}),204);status(await oldSession.request('/me'),401);
 await browser.prepare();status(await browser.login(user.login_name,short.slice(0,5)),422);const result=await browser.login(user.login_name,short);status(result,200);assert.equal(result.data.data.must_change_password,false);await browser.prepare();status(await browser.request('/me'),200);
 const sixSession=browser.clone();status(await browser.request('/auth/change-password',{method:'POST',body:{current_password:short.slice(0,5),new_password:PASSWORD}}),422);
 status(await browser.request('/auth/change-password',{method:'POST',body:{current_password:short,new_password:PASSWORD}}),204);status(await sixSession.request('/me'),401);
 await browser.prepare();status(await browser.login(user.login_name,short),401);status(await browser.login(user.login_name,PASSWORD),200);await browser.prepare();status(await browser.request('/auth/logout',{method:'POST',body:{}}),204);
 const spec=await (await fetch(browser.base+'/api/openapi.json')).json();for(const [name,fields]of [['LoginDto',['password']],['ChangePasswordDto',['current_password','new_password']]])for(const field of fields){assert.equal(spec.components.schemas[name].properties[field].minLength,6);assert.equal(spec.components.schemas[name].properties[field].maxLength,128);}
 if(process.env.KL_GENERATE_API==='true'&&topology==='replicaSet'){await promisify(execFile)(process.execPath,['scripts/generate-api.mjs'],{cwd:path.resolve(__dirname,'../../web'),env:{...process.env,OPENAPI_URL:browser.base+'/api/openapi.json'},windowsHide:true});console.log('OpenAPI types regenerated from isolated application');}
});
