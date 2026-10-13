import type { ClientSession, Db, Document } from 'mongodb';
import { collections, type AuthorizationRequest, type AdministrativeGrant, type MemberCapabilityGrant, type ControlledCapability } from '../database/contracts';
import { MEMBER_CAPABILITY_CATALOG } from './catalog';

const protectedCapabilities = Object.keys(MEMBER_CAPABILITY_CATALOG).filter(
  (capability): capability is ControlledCapability => Object.hasOwn(MEMBER_CAPABILITY_CATALOG, capability) &&
    MEMBER_CAPABILITY_CATALOG[capability as ControlledCapability].sensitivity !== 'ordinary',
);
const notExpired: Document = { $or: [
  { $eq: [{ $ifNull: ['$valid_to', null] }, null] },
  { $gt: ['$valid_to', '$$NOW'] },
] };

/** Authoritative read-only account classification, including pending sensitive authority. */
export async function protectedAccount(db: Db, userId: string, session?: ClientSession): Promise<boolean> {
  const c = collections(db);
  const members = await c.members.find({ user_id: userId }, { session, projection: { _id: 1 } }).toArray();
  const ids = members.map(member => member._id);
  if (ids.length) {
    if (await c.memberRoles.findOne({ member_id: { $in: ids }, role_id: { $in: ['platform_ops', 'content_reviewer'] },
      status: { $ne: 'revoked' }, $expr: notExpired }, { session, projection: { _id: 1 } })) return true;
    if (await db.collection<MemberCapabilityGrant>('member_capability_grants').findOne({ member_id: { $in: ids },
      capability: { $in: protectedCapabilities }, status: { $in: ['pending', 'active'] }, $expr: notExpired },
      { session, projection: { _id: 1 } })) return true;
    if (await db.collection<AdministrativeGrant>('administrative_grants').findOne({ subject_member_id: { $in: ids },
      status: { $in: ['pending', 'active'] }, $expr: notExpired }, { session, projection: { _id: 1 } })) return true;
  }
  return !!await db.collection<AuthorizationRequest>('authorization_requests').findOne({ beneficiary_user_id: userId,
    status: { $in: ['pending', 'approved', 'applying', 'needs_recovery'] } }, { session, projection: { _id: 1 } });
}
