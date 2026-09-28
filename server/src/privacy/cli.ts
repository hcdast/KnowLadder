import { MongoClient } from 'mongodb';
import { assertLocalEnvironment, requireUuid } from '../operations/contracts';
import { acquireWriter, type WriterRegistration } from '../operations/control';
import { assertSchema } from '../migrations/schema';
import { approvePrivacyRequest, executePrivacyRequest, inspectPrivacyRequest, rejectPrivacyRequest } from './execution';

export function parsePrivacyArguments(argv:string[]) {
  const [command,...args]=argv;
  const commands:Record<string,string[]>={inspect:['request-id'],approve:['request-id','expected-revision','plan-hash','actor','reason','retention-basis'],reject:['request-id','expected-revision','actor','reason'],execute:['request-id','actor','reason']};
  if(!command || !commands[command]) throw new Error('PRIVACY_USAGE');
  const values:Record<string,string>={};
  for(let i=0;i<args.length;i+=2) {
    const name=args[i].startsWith('--')?args[i].slice(2):'';
    if(!commands[command].includes(name)||values[name]!==undefined||!args[i+1]||args[i+1].startsWith('--')) throw new Error('PRIVACY_USAGE');
    values[name]=args[i+1];
  }
  for(const key of commands[command]) if(!values[key]) throw new Error('PRIVACY_USAGE');
  requireUuid(values['request-id']);
  if(values['expected-revision']!==undefined&&!/^(0|[1-9][0-9]*)$/.test(values['expected-revision'])) throw new Error('PRIVACY_USAGE');
  if(values['expected-revision']!==undefined&&!Number.isSafeInteger(Number(values['expected-revision']))) throw new Error('PRIVACY_USAGE');
  if(values['plan-hash']!==undefined&&!/^[0-9a-f]{64}$/.test(values['plan-hash'])) throw new Error('PRIVACY_USAGE');
  return {command,values};
}
export async function runPrivacyCli(argv:string[]) {
  const {command,values}=parsePrivacyArguments(argv);
  const uri=process.env.MONGODB_URI;
  if(!uri) throw new Error('PRIVACY_LOCAL_ENVIRONMENT_REQUIRED');
  const client=new MongoClient(uri,{serverSelectionTimeoutMS:5000});
  let writer:WriterRegistration|undefined;
  try {
    await client.connect(); const db=client.db(); assertLocalEnvironment(db,process.env.KL_ENVIRONMENT_ID);
    await assertSchema(db);
    if(command==='approve'||command==='reject') writer=await acquireWriter(db,'privacy');
    const input={requestId:values['request-id'],actor:values.actor,reason:values.reason,expectedRevision:Number(values['expected-revision']),planHash:values['plan-hash'],retentionBasis:values['retention-basis']};
    const result=command==='inspect'?await inspectPrivacyRequest(db,input.requestId):command==='approve'?await approvePrivacyRequest(client,db,input):command==='reject'?await rejectPrivacyRequest(client,db,input):await executePrivacyRequest(client,db,input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await writer?.release(); await client.close(); }
}
if(require.main===module) {
  runPrivacyCli(process.argv.slice(2)).catch(error=> {
    // Do not print driver errors: they can contain a URI, raw documents or secrets.
    const code=error instanceof Error&&/^(PRIVACY|OPERATIONS|LEDGER)_[A-Z_]+$/.test(error.message)?error.message:'PRIVACY_OPERATION_FAILED';
    process.stderr.write(`${code}\n`); process.exitCode=1;
  });
}
