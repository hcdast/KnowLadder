'use strict';
if(process.argv.length!==3||process.argv[2]!=='--verify-saved-original-artifacts'){process.stderr.write('EXPLICIT_ARTIFACT_VERIFICATION_REQUIRED\n');process.exit(1);}
process.env.KL_REAL_CHOICE_ARTIFACTS_VERIFY='true';process.env.KL_REAL_NUMERIC_ADOPTION_VERIFY='true';process.argv=[process.execPath,__filename,'test/ai-choice-adoption.integration.test.cjs','test/ai-numeric-adoption.integration.test.cjs'];require('./training-supplement-runner.cjs');
