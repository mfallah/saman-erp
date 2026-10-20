import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../config/env.schema';
import { AuthRepository } from './auth.repository';
import { PasswordService } from './password.service';

/**
 * Idempotent bootstrap admin (`BOOTSTRAP_ADMIN_*`, `INSTALL-FA.md`).
 * Called by the seed/CLI on first install: creates the superadmin with
 * `must_change_password=true` and assigns the `superadmin` system role.
 * Safe to call repeatedly (no-op when an active user already exists).
 */
@Injectable()
export class BootstrapAdminService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly repository: AuthRepository,
    private readonly passwords: PasswordService,
  ) {}

  async ensureBootstrapAdmin(): Promise<{ created: boolean; userId?: string }> {
    const organization = await this.repository.loadOrganization();
    const existing = await this.repository.countActiveUsers(organization.id);
    if (existing > 0) return { created: false };
    const role = await this.repository.findBootstrapRole(organization.id);
    if (role === null) throw new Error('bootstrap_role_missing: run db:seed first');
    const passwordHash = await this.passwords.hashPassword(this.config.bootstrapAdminPassword);
    const user = await this.repository.createUser({
      organizationId: organization.id,
      username: this.config.bootstrapAdminMobile,
      mobile: this.config.bootstrapAdminMobile,
      fullName: 'مدیر ارشد سامانه',
      passwordHash,
      mustChangePassword: true,
    });
    await this.repository.assignRole(user.id, role.id);
    return { created: true, userId: user.publicId };
  }
}
