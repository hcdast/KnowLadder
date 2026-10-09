import { createApp } from "../app";
import { loadConfig } from "../config";
import { Database } from "../database/database";
import {
  assertManagedInvocation,
  runManagedInvocation,
  managedRouteAllowed,
  type ManagedTicket,
} from "./managed-invocation";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Request, Response, NextFunction } from "express";
async function main() {
  if (
    !process.send ||
    !process.env.KL_MANAGED_WRITER_OWNER ||
    process.env.KL_STANDALONE_RECOVERY_ENABLED !== "true" ||
    process.env.KL_STANDALONE_MANAGED_API_ENABLED !== "true" ||
    loadConfig().production
  )
    throw Error("MANAGED_WRITER_REQUIRED");
  const secret = randomBytes(32).toString("hex");
  let database: Database;
  const guard = (req: Request, res: Response, next: NextFunction) => {
    const provided = req.get("X-KL-Managed-Secret");
    if (
      !provided ||
      provided.length !== secret.length ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(secret))
    ) {
      res.status(403).end();
      return;
    }
    const encoded = req.get("X-KL-Managed-Ticket");
    let ticket: ManagedTicket;
    try {
      ticket = JSON.parse(encoded || "");
    } catch {
      res.status(403).end();
      return;
    }
    if (
      !ticket ||
      typeof ticket !== "object" ||
      ticket.owner !== process.env.KL_MANAGED_WRITER_OWNER ||
      !managedRouteAllowed(req.method, req.originalUrl)
    ) {
      res
        .status(503)
        .json({
          error: {
            code: "STANDALONE_MODULE_UNAVAILABLE",
            message: "当前单例模式尚未开放该操作",
          },
        });
      return;
    }
    runManagedInvocation(ticket, () => {
      void assertManagedInvocation(database.db)
        .then(() => next())
        .catch(() => {
          res.status(503).end();
        });
    });
  };
  const app = await createApp({ managedGuard: guard });
  database = app.get(Database);
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo;
  const close = async () => {
    await app.close();
    process.disconnect?.();
  };
  process.once("disconnect", () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  });
  process.on("message", async (message: any) => {
    if (
      !message ||
      message.kind !== "request" ||
      typeof message.id !== "string"
    )
      return;
    try {
      const headers = {
        ...message.headers,
        "X-KL-Managed-Secret": secret,
        "X-KL-Managed-Ticket": JSON.stringify(message.ticket),
      };
      const response = await fetch(
        "http://127.0.0.1:" + address.port + message.url,
        {
          method: message.method,
          headers,
          body: ["GET", "HEAD"].includes(message.method)
            ? undefined
            : Buffer.from(message.body, "base64"),
          redirect: "manual",
          signal: AbortSignal.timeout(25000),
        },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      if (response.body) {
        for await (const bytes of response.body as any) {
          size += bytes.length;
          if (size > 8 * 1024 * 1024) throw Error("MANAGED_RESPONSE_TOO_LARGE");
          chunks.push(Buffer.from(bytes));
        }
      }
      const data = Buffer.concat(chunks);
      const outgoing: Record<string, string | string[]> = {};
      for (const key of [
        "content-type",
        "cache-control",
        "x-request-id",
        "location",
      ]) {
        const value = response.headers.get(key);
        if (value) outgoing[key] = value;
      }
      outgoing["set-cookie"] = response.headers.getSetCookie();
      process.send?.({
        kind: "response",
        id: message.id,
        status: response.status,
        headers: outgoing,
        body: data.toString("base64"),
      });
    } catch {
      process.send?.({ kind: "error", id: message.id });
    }
  });
  process.send({ kind: "ready", port: address.port });
}
main().catch(() => {
  process.send?.({ kind: "startup-error" });
  process.exitCode = 1;
  process.disconnect?.();
});
