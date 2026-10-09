'use strict';
if(process.argv.length!==3||process.argv[2]!=='--ignore-billing-authorized'){process.stderr.write('EXPLICIT_REAL_PROVIDER_AUTHORIZATION_REQUIRED\n');process.exit(1);}
const path=require('node:path'),fs=require('node:fs');try{process.loadEnvFile(path.resolve(__dirname,'../.env'));const c=require('../../ops/ai-evaluation/check.cjs').preflight(process.env);if(!c.model_matches||!c.endpoint_matches||!c.key_configured)throw Error('invalid');}catch{process.stderr.write('REAL_PROVIDER_CONFIG_INVALID\n');process.exit(1);}
if(fs.existsSync(path.resolve(__dirname,'../../ops/artifacts/training-validation/revision101-series-completion.json'))){process.stderr.write('REAL_PROVIDER_EVIDENCE_ALREADY_EXISTS\n');process.exit(1);}
process.env.KL_REAL_AI_SERIES_AUTHORIZED='true';process.argv=[process.execPath,__filename,'test/ai-series-completion.integration.test.cjs'];require('./training-supplement-runner.cjs');
