'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {preflight}=require('./check.cjs');const {probe}=require('./live-smoke.cjs');const {pack,requestCase,validate}=require('./numeric-validation.cjs');
async function main(){
  if(process.argv.length!==4||process.argv[2]!=='--ignore-billing-authorized')throw Error('AUTHORIZATION_REQUIRED');
  process.loadEnvFile(path.resolve(__dirname,'../../server/.env'));const cfg=preflight(process.env);if(!cfg.endpoint_matches||!cfg.model_matches||!cfg.key_configured)throw Error('CONFIG_INVALID');
  const file=fs.openSync(process.argv[3],'wx');
  const report={version:1,model:'gpt-5.5',transport:'real-gateway-numeric-supplement',corpus_sha256:crypto.createHash('sha256').update(JSON.stringify(pack)).digest('hex'),billing_policy:'ignored_by_explicit_user_authorization',cost_usd:null,request_attempts:0,records:[],human_quality:'not_reviewed'};
  const persist=()=>{fs.ftruncateSync(file,0);fs.writeSync(file,JSON.stringify(report,null,2)+'\n',0,'utf8');fs.fsyncSync(file);};
  try{persist();for(const c of pack.cases){report.request_attempts++;report.in_flight_case=c.id;persist();const r=await probe(requestCase(c),process.env);if(r.status==='succeeded')r.numeric_validation=validate(c,JSON.parse(r.response_json).text);report.records.push(r);delete report.in_flight_case;persist();console.log(JSON.stringify({case_id:c.id,status:r.status,numeric_validation:r.numeric_validation?.status||null,usage:r.usage}));if(r.status!=='succeeded'||r.numeric_validation.status!=='pass')break;}report.finished_at=new Date().toISOString();persist();}finally{fs.closeSync(file);}
}
if(require.main===module)main().catch(()=>{process.stderr.write('NUMERIC_EVALUATION_STOPPED\n');process.exitCode=1;});
