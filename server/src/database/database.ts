import { objectIdDatabase } from "./object-id";
import { Injectable, OnModuleInit, OnApplicationShutdown } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import type { Connection } from "mongoose";
import { MongoClient, type Db, type ClientSession } from "mongodb";
import { assertSchema } from "../migrations/schema";
import { acquireWriter, assertOperationalAccess, type WriterRegistration } from "../operations/control";
import { loadConfig } from "../config";
import { assertTopology, clearTopologyCache, probeTopology } from "./topology";
import { runInTxn } from "./txn";
@Injectable()
export class Database implements OnModuleInit, OnApplicationShutdown {
  readonly db: Db;
  readonly client: MongoClient;
  private checkedAt = 0;
  private writerClient?: MongoClient;
  private writer?: WriterRegistration;
  constructor(@InjectConnection() connection: Connection) {
    this.db = objectIdDatabase(connection.db as unknown as Db);
    this.client = connection.getClient() as unknown as MongoClient;
  }
  async onModuleInit() {
    const config = loadConfig();
    const topology = await assertTopology(this.db, config);
    console.info(
      JSON.stringify({
        event: "mongo.topology",
        mode: topology.mode,
        standalone_txn_shim:
          topology.mode === "standalone" && config.mongoAllowStandalone,
      }),
    );
    await assertSchema(this.db);
    // Keep registration alive until Nest has closed HTTP and its business connection.
    this.writerClient = new MongoClient(loadConfig().mongoUri);
    try {
      await this.writerClient.connect();
      this.writer = await acquireWriter(objectIdDatabase(this.writerClient.db()), "api");
    } catch (error) {
      await this.writerClient.close();
      throw error;
    }
    this.checkedAt = Date.now();
  }
  async onApplicationShutdown() {
    try { await this.writer?.release(); }
    finally { await this.writerClient?.close(); }
  }
  async writerStopRequested(): Promise<boolean> {
    return this.writer ? this.writer.stopRequested() : false;
  }
  async ready() {
    await assertOperationalAccess(this.db);
    clearTopologyCache();
    const topology = await probeTopology(this.db);
    if (!topology.writable) throw new Error("数据库未就绪");
    const config = loadConfig();
    if (
      (config.production || !config.mongoAllowStandalone) &&
      topology.mode !== "replicaSet"
    ) {
      throw new Error("数据库未就绪");
    }
    if (Date.now() - this.checkedAt > 10000) {
      await assertSchema(this.db);
      this.checkedAt = Date.now();
    }
  }
  async transaction<T>(
    work: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    await assertOperationalAccess(this.db);
    return runInTxn(this.client, async (session) => {
      await assertOperationalAccess(this.db);
      return work(session);
    });
  }
}
