import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "mongodb";
import { rawDatabase } from "../database/object-id";
export interface ManagedTicket {
  owner: string;
  token: string;
  generation: number;
}
export function managedApiEnabled() {
  return process.env.KL_STANDALONE_MANAGED_API_ENABLED === "true";
}
const invocation = new AsyncLocalStorage<ManagedTicket>();
export function runManagedInvocation<T>(
  ticket: ManagedTicket,
  work: () => T,
): T {
  return invocation.run(ticket, work);
}
export function managedInvocation() {
  const current = invocation.getStore();
  return current && current.owner === process.env.KL_MANAGED_WRITER_OWNER
    ? current
    : undefined;
}
export async function assertManagedInvocation(db: Db) {
  const current = managedInvocation();
  if (
    !current ||
    !(await rawDatabase(db)
      .collection("training_standalone_writer")
      .findOne({ key: "global", ...current, state: "executing" }))
  )
    throw Error("MANAGED_WRITER_REQUIRED");
}
/** Admission policy for the verified first batch. Unsupported mutation routes fail closed. */
export function managedRouteAllowed(method: string, url: string) {
  const path = url.split("?")[0];
  if (/^\/api\/v1\/auth\/(csrf|login|logout|change-password)$/.test(path))
    return ["GET", "POST"].includes(method);
  if (["GET", "HEAD"].includes(method))
    return !/\/(?:files|media)(?:\/|$)/.test(path);
  return (
    method === "POST" &&
    (/^\/api\/v1\/training\/courses\/[0-9a-f]{24}\/(assign|assignments\/preview)$/.test(
      path,
    ) ||
      path === "/api/v1/training/receipts/query")
  );
}
export function assertManagedBusinessWrite(name: string) {
  if (!managedApiEnabled()) return;
  if (
    ["operational_writers", "operational_state", "schema_migrations"].includes(
      name,
    )
  )
    return;
  if (!managedInvocation()) throw Error("MANAGED_WRITER_REQUIRED");
}
