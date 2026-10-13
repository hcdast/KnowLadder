import type { Document, Db } from "mongodb";
export type EmailPurpose = "register" | "bind" | "reset" | "invite";
export interface EmailIdentity extends Document {
  _id: string; user_id: string; email_key: string; email_display: string;
  state: "verified" | "needs_reverify"; verified_at: Date | null; revision: number;
  created_at: Date; updated_at: Date;
}
export interface EmailChallenge extends Document {
  _id: string; purpose: EmailPurpose; token_hash: string; user_id: string | null;
  email_key: string; invitation_id: string | null; credential_version: number | null;
  email_revision: number | null; invitation_revision: number | null;
  status: "pending" | "consumed" | "revoked"; expires_at: Date;
  consumed_at: Date | null; created_at: Date; updated_at: Date;
}
export interface AuthAdmission extends Document {
  _id: string; user_id: string; age_band: "adult"; source: "public_register" | "invite_activate";
  terms_version: string; privacy_notice_version: string; accepted_at: Date; policy_basis: string;
}
export interface AuthInvitation extends Document {
  _id: string; org_id: string; actor_user_id: string; target_user_id: string | null;
  email_key: string; roles: string[]; valid_to: Date | null; payload_hash: string; revision: number;
  state: "pending" | "accepted" | "revoked" | "expired"; expires_at: Date;
  accepted_user_id: string | null; accepted_at: Date | null; approval_id: string | null;
  operation_id: string | null; created_at: Date; updated_at: Date;
  payload: {
    invitation_id: string; org_id: string; actor_org_id: string; actor_member_id: string;
    actor_credential_version: number; actor_authorization_revision: number;
    target_user_id: string | null; email_key: string; roles: string[]; valid_to: string | null;
    expires_at: string; member_id: string; target_member_revision: number | null;
    target_credential_version: number | null;
  };
}
export const emailCollections = (db: Db) => ({
  identities: db.collection<EmailIdentity>("auth_email_identities"),
  challenges: db.collection<EmailChallenge>("auth_email_challenges"),
  admissions: db.collection<AuthAdmission>("auth_admissions"),
  invitations: db.collection<AuthInvitation>("auth_invitations"),
});
