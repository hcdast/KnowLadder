process.env.KL_TEST_KNOWLEDGE_PRIVACY="true";
process.env.KL_TEST_IMPORT_PRIVACY="true";
require("./training-phase2-privacy.integration.test.cjs");
