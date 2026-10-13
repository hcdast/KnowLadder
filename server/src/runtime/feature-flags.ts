export const FEATURE_FLAGS = [
  "KL_AUTH_EMAIL_ENABLED",
  "KL_PUBLIC_REGISTRATION_ENABLED",
  "FILE_SCAN_ENABLED",
  "KL_TRAINING_ENABLED",
  "KL_COURSEWORK_FILES_ENABLED",
  "KL_AI_POLICY_ENABLED",
  "KL_TRAINING_REPORTS_ENABLED",
  "KL_TRAINING_PHASE2_ENABLED",
  "KL_AI_LEARNING_REPORTS_ENABLED",
  "KL_KNOWLEDGE_ENABLED",
  "KL_KNOWLEDGE_IMPORT_ENABLED",
  "KL_TRAINING_SURVEYS_ENABLED",
  "KL_STANDALONE_RECOVERY_ENABLED",
  "KL_STANDALONE_MANAGED_API_ENABLED",
  "KL_MONGO_ALLOW_STANDALONE",
  "KL_MONGO_ALLOW_COLLECTION_REBUILD",
  "ALLOW_INSECURE_HTTP",
] as const;
export function resolveFeatureFlags(env: NodeJS.ProcessEnv = process.env) {
  const flags: Record<string, string> = {};
  for (const key of FEATURE_FLAGS) {
    const value = env[key];
    if (value !== undefined && value !== "true" && value !== "false")
      throw Error("INVALID_FLAG_" + key);
    flags[key] = value ?? (key === "FILE_SCAN_ENABLED" ? "true" : "false");
  }
  const on = (key: string) => flags[key] === "true";
  if (
    !on("KL_TRAINING_ENABLED") &&
    FEATURE_FLAGS.some(
      (key) =>
        ![
          "KL_TRAINING_ENABLED",
          "FILE_SCAN_ENABLED",
          "KL_STANDALONE_RECOVERY_ENABLED",
          "KL_STANDALONE_MANAGED_API_ENABLED",
          "KL_MONGO_ALLOW_STANDALONE",
          "KL_MONGO_ALLOW_COLLECTION_REBUILD",
          "ALLOW_INSECURE_HTTP",
          "KL_AUTH_EMAIL_ENABLED",
          "KL_PUBLIC_REGISTRATION_ENABLED",
        ].includes(key) && on(key),
    )
  )
    throw Error("FEATURE_TRAINING_REQUIRED");
  if (
    on("KL_KNOWLEDGE_IMPORT_ENABLED") &&
    (!on("FILE_SCAN_ENABLED") || !on("KL_KNOWLEDGE_ENABLED"))
  )
    throw Error("FEATURE_IMPORT_DEPENDENCIES_REQUIRED");
  if (on("KL_TRAINING_SURVEYS_ENABLED") && !on("KL_KNOWLEDGE_IMPORT_ENABLED"))
    throw Error("FEATURE_SURVEY_IMPORT_REQUIRED");
  if (
    on("KL_AI_LEARNING_REPORTS_ENABLED") &&
    (!on("KL_TRAINING_REPORTS_ENABLED") || !on("KL_AI_POLICY_ENABLED"))
  )
    throw Error("FEATURE_AI_REPORT_POLICY_REQUIRED");
  if (
    on("KL_STANDALONE_MANAGED_API_ENABLED") &&
    !on("KL_STANDALONE_RECOVERY_ENABLED")
  )
    throw Error("FEATURE_RECOVERY_REQUIRED");
  if (on("KL_PUBLIC_REGISTRATION_ENABLED") && !on("KL_AUTH_EMAIL_ENABLED"))
    throw Error("FEATURE_AUTH_EMAIL_REQUIRED");
  return flags;
}
