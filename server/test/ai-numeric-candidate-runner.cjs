'use strict';
// Reads saved original artifacts only; no provider configuration or paid invocation.
if(process.argv.length!==3||process.argv[2]!=='--verify-saved-original-artifacts'){process.stderr.write('EXPLICIT_ARTIFACT_VERIFICATION_REQUIRED\n');process.exit(1);}
process.env.KL_REAL_NUMERIC_ARTIFACTS_VERIFY='true';
process.argv=[process.execPath,__filename,'test/ai-numeric-candidate.integration.test.cjs'];
require('./training-supplement-runner.cjs');
