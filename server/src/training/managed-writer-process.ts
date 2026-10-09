import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
const proofs = new WeakSet<object>();
export interface ManagedExitProof {
  readonly owner: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}
export function isManagedExitProof(proof: ManagedExitProof, owner: string) {
  return proofs.has(proof) && proof.owner === owner;
}
/** Proof is issued only after close for a child launched here, never from a PID lookup. */
export function launchManagedWriter(entry: string, nextOwner?: string) {
  const owner = nextOwner ?? "managed-" + randomUUID();
  if (!/^managed-[0-9a-f-]{36}$/.test(owner))
    throw Error("MANAGED_OWNER_INPUT");
  const child: ChildProcess = fork(entry, [], {
    execPath: process.execPath,
    execArgv: [],
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {
      ...process.env,
      KL_MANAGED_WRITER_OWNER: owner,
      KL_WRITER_LAUNCH_TOKEN: owner.slice(8),
    },
  });
  let closed = false;
  const exit = new Promise<ManagedExitProof>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      closed = true;
      const proof = Object.freeze({ owner, code, signal });
      proofs.add(proof);
      resolve(proof);
    });
  });
  exit.catch(() => {});
  return {
    owner,
    child,
    exit,
    stop: async () => {
      if (!closed) child.kill("SIGKILL");
      return exit;
    },
  };
}
