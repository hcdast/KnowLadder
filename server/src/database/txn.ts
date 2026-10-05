import {
  type ClientSession,
  type Db,
  type MongoClient,
  type TransactionOptions,
} from "mongodb";
import { loadConfig, type AppConfig } from "../config";
import { resolvedTxnMode, type MongoTopologyMode } from "./topology";

const RS_OPTIONS: TransactionOptions = {
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
  readPreference: "primary",
  maxCommitTimeMS: 5000,
};

export type TxnOptions = TransactionOptions & { maxCommitTimeMS?: number };
// A session is not a transaction on standalone. Only a live callback admitted by
// the explicit development topology policy may use the local CAS/fence path.
// This private marker cannot be supplied by an HTTP header or a fabricated ctx.
const standaloneWork = new WeakSet<ClientSession>();
export function isExplicitStandaloneWork(session: ClientSession): boolean {
  return !session.hasEnded && standaloneWork.has(session);
}

export async function runInTxn<T>(
  client: MongoClient,
  work: (session: ClientSession) => Promise<T>,
  options: TxnOptions = RS_OPTIONS,
  config: AppConfig = loadConfig(),
): Promise<T> {
  const mode = await resolvedTxnMode(client.db(), config);
  const session = client.startSession();
  try {
    if (mode === "standalone") {
      standaloneWork.add(session);
      return await work(session);
    }
    return await session.withTransaction(() => work(session), {
      readConcern: options.readConcern ?? RS_OPTIONS.readConcern,
      writeConcern: options.writeConcern ?? RS_OPTIONS.writeConcern,
      readPreference: options.readPreference ?? RS_OPTIONS.readPreference,
      maxCommitTimeMS: options.maxCommitTimeMS ?? RS_OPTIONS.maxCommitTimeMS,
    });
  } finally {
    standaloneWork.delete(session);
    await session.endSession();
  }
}

export async function beginSessionWork(
  session: ClientSession,
  db: Db,
  options: TxnOptions = {
    readConcern: { level: "snapshot" },
    writeConcern: { w: "majority" },
    readPreference: "primary",
    maxCommitTimeMS: 3000,
  },
  config: AppConfig = loadConfig(),
): Promise<MongoTopologyMode> {
  const mode = await resolvedTxnMode(db, config);
  if (mode === "replicaSet") session.startTransaction(options);
  else standaloneWork.add(session);
  return mode;
}

export async function commitSessionWork(
  session: ClientSession,
  mode: MongoTopologyMode,
): Promise<void> {
  if (mode === "replicaSet") await session.commitTransaction();
  standaloneWork.delete(session);
}

export async function abortSessionWork(
  session: ClientSession,
  mode: MongoTopologyMode,
): Promise<void> {
  standaloneWork.delete(session);
  if (mode === "replicaSet") {
    await session.abortTransaction().catch(() => undefined);
  }
}
