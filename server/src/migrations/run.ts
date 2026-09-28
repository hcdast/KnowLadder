import { inspectMigration, migrate } from "./schema";

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri?.trim()) {
    process.stderr.write("Migration failed: MONGODB_URI is required.\n");
    process.exitCode = 1;
    return;
  }
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--inspect") {
      process.stdout.write(JSON.stringify(await inspectMigration(uri)) + "\n");
      return;
    }
    if (args.length) throw new Error("Only --inspect is supported");
    await migrate(uri);
    process.stdout.write("MongoDB schema migration completed.\n");
  } catch {
    // Driver messages can contain hosts, credentials or document contents.
    process.stderr.write(
      "Migration failed. Check replica-set availability, migration lease/checksum, database privileges and schema compatibility. No credentials are logged.\n",
    );
    process.exitCode = 1;
  }
}

void main();
