import type { ClientSession, Db } from 'mongodb';
import { fail } from '../errors';
import { assertOperationalAccess } from '../operations/control';

/** Accepted evidence survives disable, but never irreversible subject erasure. */
export async function fenceEvidenceSubject(db: Db, session: ClientSession, userId: string): Promise<boolean> {
  await assertOperationalAccess(db);
  if (!session.inTransaction()) fail(503, 'ASSESSMENT_TRANSACTION_REQUIRED', '证据写入必须位于事务');
  const result = await db.collection<{ _id: string; privacy_state?: string; identity_revision: number }>('users').updateOne(
    { _id: userId, $or: [{ privacy_state: 'active' }, { privacy_state: { $exists: false } }] },
    { $inc: { identity_revision: 1 } }, { session });
  return result.matchedCount === 1;
}

export async function requireEvidenceSubject(db: Db, session: ClientSession, userId: string): Promise<void> {
  if (!await fenceEvidenceSubject(db, session, userId)) fail(410, 'SUBJECT_ERASED', '主体证据已不可用');
}

export async function fenceEvidenceMember(db: Db, session: ClientSession, orgId: string, memberId: string): Promise<boolean> {
  await assertOperationalAccess(db);
  if (!session.inTransaction()) fail(503, 'ASSESSMENT_TRANSACTION_REQUIRED', '证据写入必须位于事务');
  const member = await db.collection<{ _id: string; org_id: string; user_id: string }>('organization_members').findOne({ _id: memberId, org_id: orgId }, { session });
  return !!member && fenceEvidenceSubject(db, session, member.user_id);
}
