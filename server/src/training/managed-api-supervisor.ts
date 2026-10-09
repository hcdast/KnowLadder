import { MongoClient } from "mongodb";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config";
import { assertSchema } from "../migrations/schema";
import { launchManagedWriter } from "./managed-writer-process";
import { StandaloneWriterAdmission } from "./standalone-writer-admission";
import {
  assertRecoveryConfiguration,
  assertRecoveryQuiescent,
} from "./standalone-recovery-lifecycle";
import {
  managedApiEnabled,
  managedRouteAllowed,
  type ManagedTicket,
} from "./managed-invocation";
export interface ManagedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}
export interface ManagedResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
}
/** Parent retains exit proof and request material in memory only; credentials are never journaled. */
export class ManagedApiSupervisor {
  private current?: ReturnType<typeof launchManagedWriter>;
  private queue = Promise.resolve();
  private closed = false;
  private port?: number;
  private pending = 0;
  private admission: StandaloneWriterAdmission;
  constructor(
    private readonly client: MongoClient,
    private readonly entry = resolve(__dirname, "managed-api-child.js"),
  ) {
    this.admission = new StandaloneWriterAdmission(client.db());
  }
  get child() {
    return this.current?.child;
  }
  get internalPort() {
    return this.port;
  }
  async initialize() {
    if (
      !managedApiEnabled() ||
      process.env.KL_STANDALONE_RECOVERY_ENABLED !== "true"
    )
      throw Error("MANAGED_CONFIGURATION_REQUIRED");
    assertRecoveryConfiguration();
    if ((await this.client.db().admin().command({ hello: 1 })).setName)
      throw Error("MANAGED_STANDALONE_REQUIRED");
    await assertSchema(this.client.db());
    await assertRecoveryQuiescent(this.client.db());
    if (
      await this.client
        .db()
        .collection("operational_writers")
        .findOne({ state: "running" })
    )
      throw Error("MANAGED_UNKNOWN_WRITER");
    const owner = "managed-" + randomUUID();
    const ticket = await this.admission.reserve(owner);
    if (!ticket) throw Error("STANDALONE_WRITER_BLOCKED");
    await this.admission.begin(ticket);
    try {
      await this.launch(owner);
      await this.admission.complete(ticket);
    } catch (error) {
      if (this.current) {
        const proof = await this.current.stop();
        await this.markStopped(this.current);
        // No HTTP command was accepted during startup. Close proof permits metadata-only cleanup.
        if (
          !(await this.client
            .db()
            .collection("training_standalone_operations")
            .findOne({ state: { $ne: "completed" } }))
        ) {
          const cleanup = await this.admission.recoverAfterExit(ticket, proof);
          await this.admission.begin(cleanup);
          await this.admission.complete(cleanup);
        } else await this.admission.quarantine(ticket).catch(() => {});
      }
      throw error;
    }
  }
  private async launch(owner?: string) {
    const worker = launchManagedWriter(this.entry, owner);
    this.current = worker;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        worker.child.off("message", receive);
        worker.child.off("close", gone);
      };
      const receive = (message: any) => {
        if (message?.kind === "ready") {
          this.port = message.port;
          cleanup();
          resolve();
        } else if (message?.kind === "startup-error") {
          cleanup();
          reject(Error("MANAGED_STARTUP_FAILED"));
        }
      };
      const gone = () => {
        cleanup();
        reject(Error("MANAGED_STARTUP_FAILED"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(Error("MANAGED_STARTUP_TIMEOUT"));
      }, 30000);
      worker.child.on("message", receive);
      worker.child.once("close", gone);
    }).catch(async (error) => {
      await worker.stop();
      await this.markStopped(worker);
      throw error;
    });
  }
  request(input: ManagedRequest): Promise<ManagedResponse> {
    if (this.closed) return Promise.reject(Error("MANAGED_CLOSED"));
    if (this.pending >= 64) return Promise.reject(Error("MANAGED_QUEUE_FULL"));
    this.pending++;
    const enqueued = Date.now();
    const work = this.queue.then(() => {
      if (Date.now() - enqueued > 30000) throw Error("MANAGED_QUEUE_EXPIRED");
      return this.execute(input);
    });
    this.queue = work.then(
      () => {},
      () => {},
    );
    return work.finally(() => {
      this.pending--;
    });
  }
  private async exchange(input: ManagedRequest, ticket: ManagedTicket) {
    const worker = this.current!;
    const id = randomUUID();
    return new Promise<ManagedResponse>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        worker.child.off("message", receive);
        worker.child.off("close", gone);
      };
      const receive = (message: any) => {
        if (message?.id !== id) return;
        if (message.kind === "response") {
          cleanup();
          resolve(message);
        } else if (message.kind === "error") {
          cleanup();
          reject(Error("MANAGED_REQUEST_FAILED"));
        }
      };
      const gone = () => {
        cleanup();
        reject(Error("MANAGED_CHILD_EXITED"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(Error("MANAGED_REQUEST_TIMEOUT"));
      }, 30000);
      worker.child.on("message", receive);
      worker.child.once("close", gone);
      try {
        worker.child.send(
          { kind: "request", id, ...input, ticket },
          (error) => {
            if (error) {
              cleanup();
              reject(Error("MANAGED_IPC_FAILED"));
            }
          },
        );
      } catch {
        cleanup();
        reject(Error("MANAGED_IPC_FAILED"));
      }
    });
  }
  private async execute(input: ManagedRequest) {
    if (this.closed || !this.current) throw Error("MANAGED_CLOSED");
    if (!managedRouteAllowed(input.method, input.url))
      return {
        status: 503,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
        body: Buffer.from(
          JSON.stringify({
            request_id: randomUUID(),
            error: {
              code: "STANDALONE_MODULE_UNAVAILABLE",
              message: "当前单例模式尚未开放该操作",
            },
          }),
        ).toString("base64"),
      };
    await assertRecoveryQuiescent(this.client.db());
    let ticket = await this.admission.reserve(this.current.owner);
    if (!ticket) throw Error("STANDALONE_WRITER_BLOCKED");
    await this.admission.begin(ticket);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this.exchange(input, ticket);
        if (
          await this.client
            .db()
            .collection("training_standalone_operations")
            .findOne({ state: { $ne: "completed" } })
        ) {
          await this.admission.quarantine(ticket);
          throw Error("MANAGED_RECOVERY_REQUIRED");
        }
        let safeUnavailable = false;
        if (result.status === 503) {
          try {
            const code = JSON.parse(
              Buffer.from(result.body, "base64").toString("utf8"),
            )?.error?.code;
            safeUnavailable =
              typeof code === "string" &&
              (/^[A-Z_]+_DISABLED$/.test(code) ||
                [
                  "TRAINING_TRANSACTION_REQUIRED",
                  "STANDALONE_MODULE_UNAVAILABLE",
                ].includes(code));
          } catch {}
        }
        if (result.status >= 500 && !safeUnavailable) {
          await this.admission.quarantine(ticket);
          throw Error("MANAGED_RECOVERY_REQUIRED");
        }
        await this.admission.complete(ticket);
        return result;
      } catch (error) {
        // A timeout is not an exit. Kill and observe close before any recovery admission.
        const dead = this.current!;
        const proof = await dead.stop();
        await this.markStopped(dead);
        const assignment =
          input.method === "POST" &&
          /^\/api\/v1\/training\/courses\/[0-9a-f]{24}\/assign(?:\?|$)/.test(
            input.url,
          );
        if (!assignment || attempt === 1 || this.closed) {
          await this.admission.quarantine(ticket).catch(() => {});
          throw error;
        }
        // Unknown earlier owners cannot use this path: only this supervisor's observed child has proof.
        const nextOwner = "managed-" + randomUUID();
        ticket = await this.admission.recoverAfterExit(
          ticket,
          proof,
          nextOwner,
        );
        await this.launch(nextOwner);
        await this.admission.begin(ticket);
        // Expire operation leases only after original process exit under exclusive global admission.
        await this.client
          .db()
          .collection("training_standalone_operations")
          .updateMany(
            { state: "recovering" },
            { $set: { until: new Date(0) } },
          );
      }
    }
    throw Error("MANAGED_RECOVERY_REQUIRED");
  }
  private async markStopped(worker: ReturnType<typeof launchManagedWriter>) {
    await worker.exit;
    await this.client
      .db()
      .collection("operational_writers")
      .updateMany(
        {
          token: worker.owner.slice(8),
          pid: worker.child.pid,
          state: "running",
        },
        {
          $set: {
            state: "stopped",
            stopped_at: new Date(),
            heartbeat_at: new Date(),
          },
        },
      );
  }
  async close() {
    this.closed = true;
    if (this.current) {
      await this.current.stop();
      await this.markStopped(this.current);
    }
    await this.queue;
    await this.client.close();
  }
}
export async function startManagedApi(port = loadConfig().port) {
  const client = new MongoClient(loadConfig().mongoUri);
  await client.connect();
  const supervisor = new ManagedApiSupervisor(client);
  try {
    await supervisor.initialize();
  } catch (error) {
    await supervisor.close();
    throw error;
  }
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      try {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 64 * 1024) throw Error("MANAGED_BODY_TOO_LARGE");
          chunks.push(chunk);
        }
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (
            [
              "connection",
              "host",
              "content-length",
              "transfer-encoding",
            ].includes(key) ||
            key.startsWith("x-kl-managed-")
          )
            continue;
          if (typeof value === "string") headers[key] = value;
        }
        const result = await supervisor.request({
          method: req.method || "GET",
          url: req.url || "/",
          headers,
          body: Buffer.concat(chunks).toString("base64"),
        });
        res.writeHead(result.status, result.headers);
        res.end(Buffer.from(result.body, "base64"));
      } catch (error) {
        const name = error instanceof Error ? error.message : "";
        const oversized = name === "MANAGED_BODY_TOO_LARGE";
        const busy = ["MANAGED_QUEUE_FULL", "MANAGED_QUEUE_EXPIRED"].includes(
          name,
        );
        res.writeHead(oversized ? 413 : 503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(
          JSON.stringify({
            request_id: randomUUID(),
            error: {
              code: oversized
                ? "BODY_TOO_LARGE"
                : busy
                  ? "STANDALONE_BUSY"
                  : "STANDALONE_RECOVERY_REQUIRED",
              message: oversized
                ? "请求内容超过限制"
                : busy
                  ? "服务繁忙，请保留原请求编号后重试"
                  : "服务正在隔离，请保留原请求编号",
            },
          }),
        );
      }
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    await supervisor.close();
    throw error;
  }
  return {
    server,
    supervisor,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await supervisor.close();
    },
  };
}
