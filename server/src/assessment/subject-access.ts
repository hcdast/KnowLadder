import type { ClientSession, Db } from 'mongodb';
import { fail } from '../errors';
import { assertOperationalAccess } from '../operations/control';
import { assertAdministrationAccess } from '../administration/authorization';
import { isExplicitStandaloneWork } from '../database/txn';

/** Accepted evidence survives disable, but never irreversible subject erasure. */
export async function fenceEvidenceSubject(db: Db, session: ClientSession, userId: string, orgId: string): Promise<boolean> {
  await assertOperationalAccess(db);
  await assertAdministrationAccess(db, userId, orgId, session);
  if (!session.inTransaction() && !isExplicitStandaloneWork(session)) fail(503, 'ASSESSMENT_TRANSACTION_REQUIRED', '证据写入需要真实事务或显式本地standalone工作上下文');
  const result = await db.collection<{ _id: string; privacy_state?: string; identity_revision: number }>('users').updateOne(
    { _id: userId, $or: [{ privacy_state: 'active' }, { privacy_state: { $exists: false } }] },
    { $inc: { identity_revision: 1 } }, { session });
  return result.matchedCount === 1;
}

export async function requireEvidenceSubject(db: Db, session: ClientSession, userId: string, orgId: string): Promise<void> {
  if (!await fenceEvidenceSubject(db, session, userId, orgId)) fail(410, 'SUBJECT_ERASED', '主体证据已不可用');
}

export async function fenceEvidenceMember(db: Db, session: ClientSession, orgId: string, memberId: string): Promise<boolean> {
  await assertOperationalAccess(db);
  if (!session.inTransaction() && !isExplicitStandaloneWork(session)) fail(503, 'ASSESSMENT_TRANSACTION_REQUIRED', '证据写入需要真实事务或显式本地standalone工作上下文');
  const member = await db.collection<{ _id: string; org_id: string; user_id: string }>('organization_members').findOne({ _id: memberId, org_id: orgId }, { session });
  if (!member) return false;
  return fenceEvidenceSubject(db, session, member.user_id, orgId);
}
