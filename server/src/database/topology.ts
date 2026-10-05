import type { Db } from "mongodb";
import type { AppConfig } from "../config";

export type MongoTopologyMode = "replicaSet" | "standalone";

export type TopologyProbe = {
  mode: MongoTopologyMode;
  setName?: string;
  writable: boolean;
};

let cached: TopologyProbe | undefined;

export function clearTopologyCache(): void {
  cached = undefined;
}

export async function probeTopology(db: Db): Promise<TopologyProbe> {
  if (cached) return cached;
  const hello = await db.admin().command(
    { hello: 1 },
    { readPreference: "primary" },
  );
  const writable = !!(
    hello.isWritablePrimary ??
    hello.ismaster ??
    hello.isMaster
  );
  const setName =
    typeof hello.setName === "string" && hello.setName
      ? hello.setName
      : undefined;
  const mode: MongoTopologyMode = setName ? "replicaSet" : "standalone";
  cached = { mode, setName, writable };
  return cached;
}

export async function assertTopology(
  db: Db,
  config: AppConfig,
): Promise<TopologyProbe> {
  clearTopologyCache();
  const probe = await probeTopology(db);
  if (!probe.writable) {
    throw new Error("MongoDB primary is not writable");
  }

  if (config.production || !config.mongoAllowStandalone) {
    if (probe.mode !== "replicaSet") {
      throw new Error(
        config.production
          ? "MongoDB writable replica set is required in production"
          : "MongoDB writable replica set is required (set KL_MONGO_ALLOW_STANDALONE=true for local/dev standalone shim)",
      );
    }
    if (config.mongoTopology === "standalone") {
      throw new Error(
        "KL_MONGO_TOPOLOGY=standalone requires KL_MONGO_ALLOW_STANDALONE=true outside production",
      );
    }
    return probe;
  }

  if (config.mongoTopology === "replicaSet" && probe.mode !== "replicaSet") {
    throw new Error("MongoDB writable replica set is required");
  }
  if (config.mongoTopology === "standalone" && probe.mode !== "standalone") {
    throw new Error("KL_MONGO_TOPOLOGY=standalone but server reports a replica set");
  }
  return probe;
}

export async function resolvedTxnMode(
  db: Db,
  config: AppConfig,
): Promise<MongoTopologyMode> {
  const probe = await probeTopology(db);
  if (config.production || !config.mongoAllowStandalone) return "replicaSet";
  if (config.mongoTopology === "replicaSet") return "replicaSet";
  if (config.mongoTopology === "standalone") return "standalone";
  return probe.mode;
}
