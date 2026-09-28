import { PRIVACY_POLICY_REVISION, PRIVACY_STATUSES } from './schema';

export interface PrivacyRequest {
  _id: string;
  user_id: string;
  scope: 'account';
  policy_revision: typeof PRIVACY_POLICY_REVISION;
  status: typeof PRIVACY_STATUSES[number];
  revision: number;
  plan_hash: string | null;
  actor: string | null;
  reason_code: string | null;
  deleted_categories: string[];
  retained_categories: string[];
  retention_basis: string | null;
  remaining_actions: string[];
  created_at: Date;
  updated_at: Date;
  lease_token: string | null;
  lease_until: Date | null;
  ledger_sequence: number | null;
  completed_steps: string[];
}
export interface PrivacyReceipt {
  _id: string;
  user_id: string;
  key_hash: string;
  request_hash: string;
  request_id: string;
  created_at: Date;
}
export interface PrivacyRequestView {
  id: string;
  scope: 'account';
  policy_revision: typeof PRIVACY_POLICY_REVISION;
  status: PrivacyRequest['status'];
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_categories: string[];
  retained_categories: string[];
  retention_basis: string | null;
  remaining_actions: string[];
}
export interface PrivacyRequestPage {
  items: PrivacyRequestView[];
  next_cursor: string | null;
}
export function privacyRequestView(row: PrivacyRequest): PrivacyRequestView {
  return {
    id: row._id, scope: row.scope, policy_revision: row.policy_revision,
    status: row.status, revision: row.revision,
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
    deleted_categories: row.deleted_categories, retained_categories: row.retained_categories,
    retention_basis: row.retention_basis, remaining_actions: row.remaining_actions,
  };
}
