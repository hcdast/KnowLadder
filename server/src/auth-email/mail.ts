import { Injectable, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { connect as connectNet, isIP, type Socket } from "node:net";
import { connect as connectTls, checkServerIdentity, type PeerCertificate } from "node:tls";
import nodemailer, { type Transporter } from "nodemailer";
import type { SMTPTransportOptions, SMTPSentMessageInfo } from "nodemailer/lib/smtp-transport";
import type { ClientSession, Db, Document } from "mongodb";
import { Database } from "../database/database";
import { newId } from "../database/object-id";
import { probeTopology } from "../database/topology";
import { loadEmailConfig, type EmailConfig } from "./config";
import type { EmailPurpose } from "./contracts";
import { normalizeEmail, tokenDigest } from "./tokens";

export interface EnqueueEmailInput { challengeId: string; userId: string | null; invitationId: string | null;
  purpose: EmailPurpose; email: string; token: string; expiresAt: Date }
interface MailRow extends Document { _id: string; challenge_id: string; user_id: string | null;
  invitation_id: string | null; purpose: EmailPurpose; key_id: string; encrypted_payload: string | null;
  lease_token: string | null; expires_at: Date; transport_token: string | null; transport_writer_id: string | null }
interface MailPayload { email: string; token: string }
const DEADLINE_MS = 10000, LEASE_MS = 30000;
const terminal = { lease_token: null, lease_until: null, encrypted_payload: null };

export async function enqueueEmail(db: Db, transaction: ClientSession, input: EnqueueEmailInput): Promise<string> {
  if (!transaction.inTransaction()) throw Error("AUTH_TRANSACTION_REQUIRED");
  const config = loadEmailConfig();
  if (!config.actionsEnabled || !config.mailEncryptionKey || !config.smtp) throw Error("AUTH_EMAIL_DISABLED");
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(input.email) || /[\r\n\x00]/.test(input.email) ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.token) || !Number.isFinite(input.expiresAt.getTime())) throw Error("AUTH_MAIL_INPUT_INVALID");
  const challenge = await db.collection("auth_email_challenges").findOne({
    _id: input.challengeId as never, purpose: input.purpose, token_hash: tokenDigest(input.token),
    user_id: input.userId, invitation_id: input.invitationId, email_key: normalizeEmail(input.email).key,
    status: "pending", expires_at: input.expiresAt, $expr: { $gt: ["$expires_at", "$$NOW"] },
  }, { session: transaction });
  if (!challenge) throw Error("AUTH_MAIL_CHALLENGE_INVALID");
  const invitation = input.invitationId ? await db.collection("auth_invitations").findOne({ _id: input.invitationId as never }, { session: transaction }) : null;
  if (input.invitationId && !invitation) throw Error("AUTH_MAIL_CHALLENGE_INVALID");
  const id = newId(), nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.mailEncryptionKey, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify([id, input.purpose, config.keyId])));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ email: input.email, token: input.token }), "utf8"), cipher.final()]);
  await db.collection<MailRow>("auth_mail_outbox").updateOne({ _id: id }, [{ $set: {
    challenge_id: input.challengeId, user_id: input.userId, invitation_id: input.invitationId, purpose: input.purpose, status: "pending",
    recipient_key_hash: tokenDigest(normalizeEmail(input.email).key), actor_user_id: invitation?.actor_user_id ?? null,
    transport_token: null, transport_writer_id: null, transport_closed_at: null,
    encrypted_payload: { $literal: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64") }, key_id: config.keyId,
    expires_at: input.expiresAt, lease_token: null, lease_until: null, safe_error_code: "", created_at: "$$NOW", updated_at: "$$NOW",
  } }], { upsert: true, session: transaction });
  return id;
}
function decryptMail(row: MailRow, config: EmailConfig): MailPayload {
  if (!config.mailEncryptionKey || row.key_id !== config.keyId || !row.encrypted_payload) throw Error("AUTH_MAIL_CIPHERTEXT_INVALID");
  const packed = Buffer.from(row.encrypted_payload, "base64");
  if (packed.length < 29 || packed.length > 6144 || packed.toString("base64") !== row.encrypted_payload) throw Error("AUTH_MAIL_CIPHERTEXT_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", config.mailEncryptionKey, packed.subarray(0, 12));
  decipher.setAAD(Buffer.from(JSON.stringify([row._id, row.purpose, row.key_id])));
  decipher.setAuthTag(packed.subarray(12, 28));
  const plaintext = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]);
  try {
    const payload: MailPayload = JSON.parse(plaintext.toString("utf8"));
    if (Object.keys(payload).sort().join(",") !== "email,token" || typeof payload.email !== "string" ||
      !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(payload.email) || /[\r\n\x00]/.test(payload.email) ||
      typeof payload.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(payload.token)) throw Error("AUTH_MAIL_CIPHERTEXT_INVALID");
    return payload;
  } finally { plaintext.fill(0); }
}
@Injectable()
export class MailDeliveryService implements OnModuleInit, OnModuleDestroy {
  private stopping = false;
  private loop?: Promise<void>;
  private closedTransports = new Map<string, { token: string; writerId: string }>();
  private wake?: () => void;
  private sockets = new Map<Socket, Promise<void>>();
  private active = new Set<Promise<unknown>>();
  private availability?: Promise<void>;
  private availabilityUntil = 0;
  constructor(private readonly database: Database) {}
  async onModuleInit() {
    const config = loadEmailConfig();
    if (!config.actionsEnabled) return;
    if ((await probeTopology(this.database.db)).mode !== "replicaSet") throw Error("AUTH_TRANSACTION_REQUIRED");
    this.loop = this.run();
  }
  async onModuleDestroy() {
    this.stopping = true;
    this.wake?.();
    const closed = [...this.sockets.values()];
    for (const socket of this.sockets.keys()) socket.destroy();
    await Promise.allSettled([...this.active, ...closed]);
    await this.loop;
  }
  async assertAvailable(): Promise<void> {
    const config = loadEmailConfig();
    if (!config.actionsEnabled || !config.smtp || this.stopping) throw Error("AUTH_EMAIL_DISABLED");
    if (!this.availability || Date.now() >= this.availabilityUntil) {
      this.availabilityUntil = Date.now() + 10000;
      this.availability = this.smtpOperation(config, transport => transport.verify()).then(() => undefined, () => { throw Error("AUTH_MAIL_UNAVAILABLE"); });
    }
    return this.availability;
  }
  private async smtpOperation<T>(config: EmailConfig, work: (transport: Transporter<SMTPSentMessageInfo>) => Promise<T>,
    eligible?: () => Promise<boolean>): Promise<T> {
    if (!config.smtp || this.stopping) throw Error("AUTH_MAIL_UNAVAILABLE");
    const smtp = config.smtp, localSockets = new Map<Socket, Promise<void>>();
    const tlsOptions = { rejectUnauthorized: true, minVersion: "TLSv1.2" as const,
      servername: isIP(smtp.host) ? undefined : smtp.host,
      checkServerIdentity: (_hostname: string, certificate: PeerCertificate) => checkServerIdentity(smtp.host, certificate) };
    let cancelled = false;
    const options: SMTPTransportOptions = { host: smtp.host, port: smtp.port, secure: smtp.secure,
      requireTLS: !smtp.secure, auth: { user: smtp.user, pass: smtp.password }, forceAuth: true,
      connectionTimeout: DEADLINE_MS, greetingTimeout: DEADLINE_MS, socketTimeout: DEADLINE_MS,
      tls: tlsOptions, logger: false, debug: false,
      disableFileAccess: true, disableUrlAccess: true,
      getSocket: (_options, callback) => {
        if (cancelled || this.stopping) { callback(Error("AUTH_MAIL_CANCELLED"), undefined); return; }
        const socket = smtp.secure ? connectTls({ host: smtp.host, port: smtp.port, ...tlsOptions })
          : connectNet({ host: smtp.host, port: smtp.port });
        let returned = false;
        const closed = new Promise<void>(resolve => socket.once("close", () => {
          this.sockets.delete(socket); resolve();
          if (!returned) { returned = true; callback(Error("AUTH_MAIL_CANCELLED"), undefined); }
        }));
        this.sockets.set(socket, closed); localSockets.set(socket, closed);
        socket.once("error", () => { if (!returned) { returned = true; callback(Error("AUTH_MAIL_CONNECTION_FAILED"), undefined); } });
        socket.once(smtp.secure ? "secureConnect" : "connect", () => {
          if (returned) return; returned = true;
          if (cancelled || this.stopping) { socket.destroy(); callback(Error("AUTH_MAIL_CANCELLED"), undefined); return; }
          callback(null, { connection: socket, secured: smtp.secure });
        });
      } };
    const transport = nodemailer.createTransport(options);
    let timer: NodeJS.Timeout | undefined;
    let monitorTimer: NodeJS.Timeout | undefined, monitorDone = false;
    let rejectCancelled!: (error: Error) => void;
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
    const monitor = async () => {
      if (monitorDone || !eligible) return;
      try {
        if (this.stopping || !await eligible()) throw Error("AUTH_MAIL_CANCELLED");
      } catch {
        cancelled = true;
        for (const socket of localSockets.keys()) socket.destroy();
        rejectCancelled(Error("AUTH_MAIL_CANCELLED"));
        return;
      }
      if (!monitorDone) monitorTimer = setTimeout(() => { void monitor(); }, 100);
    };
    const operation = work(transport);
    this.active.add(operation);
    if (eligible) void monitor();
    try {
      return await Promise.race([operation, cancellation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          cancelled = true;
          for (const socket of localSockets.keys()) socket.destroy();
          reject(Error("AUTH_MAIL_TIMEOUT"));
        }, DEADLINE_MS);
      })]);
    } finally {
      cancelled = true;
      monitorDone = true;
      clearTimeout(monitorTimer);
      clearTimeout(timer);
      transport.close();
      for (const socket of localSockets.keys()) socket.destroy();
      await Promise.allSettled([operation, ...localSockets.values()]);
      this.active.delete(operation);
    }
  }
  private async run() {
    while (!this.stopping) {
      try { await this.runOnce(); } catch { /* Retry infrastructure work, never an SMTP sending row. No secret-bearing errors logged. */ }
      if (this.stopping) break;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.wake = undefined; resolve(); }, 1000);
        this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
      });
    }
  }
  private async publishClosedTransports(): Promise<void> {
    let count = 0;
    for (const [id, proof] of this.closedTransports) {
      if (count++ >= 5) break;
      await this.database.db.collection("auth_mail_outbox").updateOne({
        _id: id as never, transport_token: proof.token, transport_writer_id: proof.writerId,
      }, [{ $set: { transport_token: null, transport_writer_id: null, transport_closed_at: "$$NOW", updated_at: "$$NOW" } }]);
      this.closedTransports.delete(id);
    }
  }
  async runOnce(): Promise<number> {
    // Retry only recorded actual close acknowledgements, never a mail transmission.
    await this.publishClosedTransports();
    await this.database.ready();
    if (await this.database.writerStopRequested()) return 0;
    const db = this.database.db, outbox = db.collection<MailRow>("auth_mail_outbox");
    // Never reclaim a possibly transmitted message. Expired sending leases are final unknown results.
    await outbox.updateMany({ status: "sending", $expr: { $lte: ["$lease_until", "$$NOW"] } },
      [{ $set: { ...terminal, status: "uncertain", safe_error_code: "SMTP_RESULT_UNKNOWN", updated_at: "$$NOW" } }]);
    await outbox.updateMany({ status: "pending", $expr: { $lte: ["$expires_at", "$$NOW"] } },
      [{ $set: { ...terminal, status: "cancelled", safe_error_code: "CHALLENGE_EXPIRED", updated_at: "$$NOW" } }]);
    const config = loadEmailConfig();
    if (!config.actionsEnabled || this.stopping) return 0;
    if ((await probeTopology(db)).mode !== "replicaSet") throw Error("AUTH_TRANSACTION_REQUIRED");
    const writerId = this.database.writerRegistrationId();
    if (!writerId) return 0;
    let count = 0;
    for (; count < 5 && !this.stopping; count++) {
      const lease = randomUUID();
      const row = await outbox.findOneAndUpdate({ status: "pending", transport_token: null, $expr: { $gt: ["$expires_at", "$$NOW"] } },
        [{ $set: { status: "sending", lease_token: lease, lease_until: { $add: ["$$NOW", LEASE_MS] },
          transport_token: lease, transport_writer_id: writerId, transport_closed_at: null, updated_at: "$$NOW" } }],
        { sort: { created_at: 1, _id: 1 }, returnDocument: "after" });
      if (!row) break;
      let status: "sent" | "failed" | "uncertain" | "cancelled" = "cancelled", code = "CHALLENGE_INACTIVE";
      try {
        if (await this.eligible(row)) {
          let payload: MailPayload;
          try { payload = decryptMail(row, config); } catch { throw Error("AUTH_MAIL_CIPHERTEXT_INVALID"); }
          if (await this.eligible(row, payload) && !this.stopping) {
            const routes = { register: "/verify-email", bind: "/verify-email", reset: "/reset-password", invite: "/accept-invitation" };
            const fragment = new URLSearchParams({ token: payload.token });
            if (row.purpose === "bind") fragment.set("purpose", "bind");
            const link = `${process.env.APP_ORIGIN}${routes[row.purpose]}#${fragment}`;
            const info = await this.smtpOperation(config, transport => transport.sendMail({
              from: config.smtp!.from, to: payload.email, subject: "KnowLadder 账号验证",
              text: `请在 KnowLadder 页面确认本次账号操作。链接将在有效期后失效：\n${link}\n\n如果这不是您发起的操作，请忽略本邮件。`,
              disableFileAccess: true, disableUrlAccess: true,
            }), () => this.eligible(row));
            status = info.accepted.length === 1 && info.rejected.length === 0 ? "sent" : "failed";
            code = status === "sent" ? "" : "SMTP_REJECTED";
          }
        }
      } catch (error) {
        const e = error as { message?: string; responseCode?: number };
        if (e.message === "AUTH_MAIL_CIPHERTEXT_INVALID") { status = "failed"; code = "MAIL_CIPHERTEXT_INVALID"; }
        else if (typeof e.responseCode === "number" && e.responseCode >= 400 && e.responseCode <= 599) { status = "failed"; code = "SMTP_REJECTED"; }
        else { status = "uncertain"; code = "SMTP_RESULT_UNKNOWN"; }
      }
      this.closedTransports.set(row._id, { token: lease, writerId });
      try {
        await outbox.updateOne({ _id: row._id, status: "sending", lease_token: lease },
          [{ $set: { ...terminal, status, safe_error_code: code, updated_at: "$$NOW" } }]);
      } finally {
        // SMTP has awaited every real socket close; a failed terminal status write
        // cannot suppress the independent proof required by privacy deletion.
        await this.publishClosedTransports();
      }
    }
    return count;
  }
  private async eligible(row: MailRow, payload?: MailPayload): Promise<boolean> {
    const db = this.database.db;
    const challenge = await db.collection("auth_email_challenges").findOne({ _id: row.challenge_id as never,
      purpose: row.purpose, status: "pending", user_id: row.user_id, invitation_id: row.invitation_id,
      $expr: { $gt: ["$expires_at", "$$NOW"] } });
    if (!challenge) return false;
    if (payload && (challenge.token_hash !== tokenDigest(payload.token) || challenge.email_key !== normalizeEmail(payload.email).key))
      throw Error("AUTH_MAIL_CIPHERTEXT_INVALID");
    const subjects = new Set<string>();
    if (row.user_id) subjects.add(row.user_id);
    if (row.invitation_id) {
      const invitation = await db.collection("auth_invitations").findOne({ _id: row.invitation_id as never,
        state: "pending", revision: challenge.invitation_revision, email_key: challenge.email_key,
        $expr: { $gt: ["$expires_at", "$$NOW"] } });
      if (!invitation?.operation_id || !await db.collection("administration_operations").findOne({ _id: invitation.operation_id, status: "applied" })) return false;
      subjects.add(invitation.actor_user_id);
      if (invitation.target_user_id) subjects.add(invitation.target_user_id);
    }
    for (const identity of await db.collection("auth_email_identities").find({ email_key: challenge.email_key }).toArray()) subjects.add(identity.user_id);
    for (const userId of subjects) {
      const user = await db.collection("users").findOne({ _id: userId as never, status: "active", privacy_state: "active" });
      if (!user || (row.user_id === userId && challenge.credential_version !== null && user.credential_version !== challenge.credential_version)) return false;
      if (await db.collection("privacy_tombstones").findOne({ user_id: userId })) return false;
    }
    if (row.purpose === "bind") {
      const old = await db.collection("auth_email_identities").findOne({ user_id: row.user_id }, { sort: { revision: -1 } });
      if ((old?.revision ?? null) !== challenge.email_revision) return false;
    } else if (challenge.email_revision !== null && !await db.collection("auth_email_identities").findOne({
      user_id: row.user_id, email_key: challenge.email_key, state: "verified", revision: challenge.email_revision,
    })) return false;
    return !!await db.collection("auth_mail_outbox").findOne({ _id: row._id as never, status: "sending", lease_token: row.lease_token,
      $expr: { $gt: ["$lease_until", "$$NOW"] } });
  }
}
