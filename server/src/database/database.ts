import { Injectable, OnModuleInit, OnApplicationShutdown } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import type { Connection } from "mongoose";
import { MongoClient, type Db, type ClientSession } from "mongodb";
import { assertSchema } from "../migrations/schema";
import { acquireWriter, assertOperationalAccess, type WriterRegistration } from "../operations/control";
import { loadConfig } from "../config";
@Injectable()
export class Database implements OnModuleInit, OnApplicationShutdown {
  readonly db: Db;
  readonly client: MongoClient;
  private checkedAt = 0;
  private writerClient?: MongoClient;
  private writer?: WriterRegistration;
  constructor(@InjectConnection() connection: Connection) {
    this.db = connection.db as unknown as Db;
    this.client = connection.getClient() as unknown as MongoClient;
  }
  async onModuleInit() {
    await assertSchema(this.db);
    // Keep registration alive until Nest has closed HTTP and its business connection.
    this.writerClient = new MongoClient(loadConfig().mongoUri);
    try {
      await this.writerClient.connect();
      this.writer = await acquireWriter(this.writerClient.db(), "api");
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
    const hello = await this.db
      .admin()
      .command({ hello: 1 }, { readPreference: "primary" });
    if (!hello.setName || !hello.isWritablePrimary)
      throw new Error("数据库未就绪");
    if (Date.now() - this.checkedAt > 10000) {
      await assertSchema(this.db);
      this.checkedAt = Date.now();
    }
  }
  async transaction<T>(
    work: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    await assertOperationalAccess(this.db);
    const session = this.client.startSession();
    try {
      return await session.withTransaction(async () => {
        await assertOperationalAccess(this.db);
        return work(session);
      }, {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
        maxCommitTimeMS: 5000,
      });
    } finally {
      await session.endSession();
    }
  }
}
