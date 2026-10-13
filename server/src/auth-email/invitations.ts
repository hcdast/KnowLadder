import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { Database } from '../database/database';
import { AdministrationService } from '../administration/administration.service';
import { fail, type ApiRequest } from '../errors';
import { hashPassword } from '../security/password';
import { AuthEmailService } from './service';
import { emailCollections } from './contracts';
import { consumeEmailChallenge, normalizeEmail, readEmailChallenge } from './tokens';
import type { ActivateEmailDto, EmailTokenDto } from './dto';

@Injectable()
export class AuthInvitationsService {
  constructor(readonly database: Database, readonly email: AuthEmailService, readonly administration: AdministrationService) {}

  async inspect(req: ApiRequest, body: EmailTokenDto) {
    await this.email.assertTransaction();
    await this.email.confirmRate(req);
    return this.database.transaction(async transaction => {
      await this.email.actionSession(req, 'any', transaction);
      const challenge = await readEmailChallenge(this.database.db, transaction, body.token, 'invite');
      const invitation = await this.administration.invitationForChallenge(challenge, transaction);
      const organization = await this.database.db.collection<{ _id: string; name: string }>('organizations').findOne({ _id: invitation.org_id, status: 'active' }, { session: transaction });
      if (!organization) fail(409, 'INVITATION_UNAVAILABLE', '邀请组织已失效');
      const identity = await emailCollections(this.database.db).identities.findOne({ email_key: invitation.email_key, state: 'verified' }, { session: transaction, projection: { _id: 1 } });
      return { invitation_id: invitation._id, organization: { id: organization._id, name: organization.name }, state: invitation.state,
        expires_at: invitation.expires_at, action: identity ? 'accept' : 'activate' };
    });
  }

  async accept(req: ApiRequest, body: EmailTokenDto) {
    await this.email.assertTransaction();
    await this.email.confirmRate(req);
    return this.database.transaction(async transaction => {
      const current = await this.email.actionSession(req, 'authenticated', transaction);
      if (!current.user) fail(401, 'SESSION_EXPIRED', '请先登录再接受邀请');
      const challenge = await readEmailChallenge(this.database.db, transaction, body.token, 'invite');
      const result = await this.administration.applyInvitation(req, challenge, current.user._id, transaction);
      await consumeEmailChallenge(this.database.db, transaction, challenge);
      return result;
    });
  }

  async activate(req: ApiRequest, body: ActivateEmailDto, res: Response) {
    await this.email.assertTransaction();
    await this.email.confirmRate(req);
    // Verify the browser/session matrix before doing expensive password work.
    await this.email.actionSession(req, 'preauth');
    this.email.admission(body);
    const passwordHash = await hashPassword(body.new_password);
    const result = await this.database.transaction(async transaction => {
      const current = await this.email.actionSession(req, 'preauth', transaction);
      const challenge = await readEmailChallenge(this.database.db, transaction, body.token, 'invite');
      const invitation = await this.administration.invitationForChallenge(challenge, transaction);
      if (invitation.target_user_id || await emailCollections(this.database.db).identities.findOne({ email_key: invitation.email_key, state: 'verified' }, { session: transaction }))
        fail(409, 'INVITATION_UNAVAILABLE', '该邮箱已有账号，请登录原账号后接受邀请');
      const activated = await this.email.createActivatedUser(req, current.session, transaction, {
        email: normalizeEmail(invitation.email_key), displayName: body.display_name, passwordHash, admission: this.email.admission(body), source: 'invite_activate',
      });
      await this.administration.applyInvitation(req, challenge, activated.user._id, transaction, true);
      await consumeEmailChallenge(this.database.db, transaction, challenge);
      return activated;
    });
    return this.email.activationResponse(res, result);
  }
}
