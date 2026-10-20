import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { AdminRepository } from './admin.repository';
import { AdminService } from './admin.service';
import { OrgAdminController, PermissionsAdminController, RolesAdminController, SystemAdminController, UsersAdminController } from './admin.controllers';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { BootstrapAdminService } from './bootstrap-admin.service';
import { IdentityGuard } from './identity.guard';
import { PasswordService } from './password.service';

/**
 * Identity module: login/OTP/sessions/devices/step-up/password (`ADR-0004`).
 * Exposes `IdentityGuard` (default-deny authentication) for global wiring and
 * `BootstrapAdminService` for the first-install seed.
 */
@Module({
  controllers: [AuthController, UsersAdminController, RolesAdminController, PermissionsAdminController, OrgAdminController, SystemAdminController],
  providers: [AdminRepository, AdminService, AuthRepository, PasswordService, AuthRateLimitService, AuthService, BootstrapAdminService, IdentityGuard],
  exports: [IdentityGuard, AuthService, BootstrapAdminService, AuthRepository, PasswordService],
})
export class IdentityModule {}
