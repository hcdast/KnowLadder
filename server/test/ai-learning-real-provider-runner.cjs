'use strict';
// Opt-in, isolated HTTP probe. Never invoked by the ordinary offline test suite.
if (process.argv.length !== 3 || process.argv[2] !== '--ignore-billing-authorized') {
  process.stderr.write('EXPLICIT_REAL_PROVIDER_AUTHORIZATION_REQUIRED\n'); process.exit(1);
}
try {
  process.loadEnvFile(require('node:path').resolve(__dirname,'../.env'));
  const config=require('../../ops/ai-evaluation/check.cjs').preflight(process.env);
  if (!config.model_matches || !config.endpoint_matches || !config.key_configured) throw Error('invalid');
} catch { process.stderr.write('REAL_PROVIDER_CONFIG_INVALID\n'); process.exit(1); }
process.env.KL_REAL_AI_VERIFY_AUTHORIZED='true';
if(require('node:fs').existsSync(require('node:path').resolve(__dirname,'../../ops/artifacts/training-validation/revision97-real-system-http.json'))) {
  process.stderr.write('REAL_PROVIDER_EVIDENCE_ALREADY_EXISTS\n'); process.exit(1);
}
process.argv=[process.execPath,__filename,'test/ai-learning-real-provider.integration.test.cjs'];
require('./training-supplement-runner.cjs');
