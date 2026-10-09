const fs = require("node:fs"),
  path = require("node:path");
if (
  process.argv.length !== 3 ||
  process.argv[2] !== "--original-synthetic-authorized"
) {
  process.stderr.write("EXPLICIT_REAL_PROVIDER_AUTHORIZATION_REQUIRED\n");
  process.exit(1);
}
try {
  process.loadEnvFile(path.resolve(__dirname, "../.env"));
  const check = require("../../ops/ai-evaluation/check.cjs").preflight(
    process.env,
  );
  if (!check.model_matches || !check.endpoint_matches || !check.key_configured)
    throw Error("invalid");
} catch {
  process.stderr.write("REAL_PROVIDER_CONFIG_INVALID\n");
  process.exit(1);
}
if (
  fs.existsSync(
    path.resolve(
      __dirname,
      "../../ops/artifacts/training-validation/revision137-knowledge-real.json",
    ),
  )
) {
  process.stderr.write("REAL_PROVIDER_EVIDENCE_ALREADY_EXISTS\n");
  process.exit(1);
}
process.env.KL_REAL_KNOWLEDGE_AUTHORIZED = "true";
process.argv = [
  process.execPath,
  __filename,
  "test/knowledge-real-provider.integration.test.cjs",
];
require("./training-supplement-runner.cjs");
