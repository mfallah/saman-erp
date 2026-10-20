import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { AppError, PERMISSION_COUNT, PERMISSION_KEYS } from '@saman/shared';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedActor } from '../../common/auth/authenticated-actor';
import type { RequestWithContext } from '../../common/decorators/current-context.decorator';
import { RequireStepUp } from '../../common/decorators/require-step-up.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { getRequestId } from '../../common/request-id/request-id';
// AdminService is a DI value (constructor metadata), not only a type.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { AdminService, type AdminMutationMeta } from './admin.service';

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', {
      details: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), code: issue.code })),
    });
  }
  return parsed.data;
}

function actorOf(request: FastifyRequest): AuthenticatedActor {
  const actor = (request as RequestWithContext).user;
  if (actor === undefined) throw new AppError('UNAUTHENTICATED');
  return actor;
}

function metaOf(request: FastifyRequest): AdminMutationMeta {
  const userAgent = typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined;
  return {
    requestId: getRequestId(request),
    ...(request.ip === undefined ? {} : { ip: request.ip }),
    ...(userAgent === undefined ? {} : { userAgent }),
  };
}

const idSchema = z.string().uuid();
const createUserSchema = z.object({
  username: z.string().min(3).max(100),
  mobile: z.string().regex(/^09\d{9}$/),
  fullName: z.string().min(2).max(200),
  email: z.string().email().optional(),
  password: z.string().min(12).max(256).optional(),
});
const updateUserSchema = z.object({
  fullName: z.string().min(2).max(200).optional(),
  email: z.string().email().nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
const resetPasswordSchema = z.object({ newPassword: z.string().min(12).max(256).optional() });
const rolesSchema = z.object({ roles: z.array(z.string().min(2).max(50)).max(20) });
const scopeSchema = z.object({
  branchIds: z.array(z.string().regex(/^\d+$/)).max(200).optional(),
  warehouseIds: z.array(z.string().regex(/^\d+$/)).max(200).optional(),
});
const createRoleSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/),
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
  scopeMode: z.enum(['all', 'branch', 'warehouse', 'self']).optional(),
});
const updateRoleSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  scopeMode: z.enum(['all', 'branch', 'warehouse', 'self']).optional(),
});
const rolePermissionsSchema = z.object({ permissions: z.array(z.string()).max(600) });
const orgPatchSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  legal_name: z.string().max(300).nullable().optional(),
  national_id: z.string().max(20).nullable().optional(),
  economic_code: z.string().max(20).nullable().optional(),
  registration_no: z.string().max(30).nullable().optional(),
  timezone: z.string().max(64).optional(),
});
const createBranchSchema = z.object({
  code: z.string().min(2).max(30),
  name: z.string().min(2).max(150),
  branchType: z.enum(['head_office', 'warehouse', 'store', 'sales_office']),
  city: z.string().max(100).optional(),
});
const updateBranchSchema = z.object({
  name: z.string().min(2).max(150).optional(),
  isActive: z.boolean().optional(),
});
const createDepartmentSchema = z.object({ code: z.string().min(2).max(30), name: z.string().min(2).max(150) });
const settingsSchema = z.record(z.unknown());

/** `/users` administration (`API.md` §4.1). */
@Controller('users')
export class UsersAdminController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  @Permissions('user.read')
  list(@Req() request: FastifyRequest, @Query('search') search?: string, @Query('limit') limit?: string) {
    return this.admin.listUsers(actorOf(request), { search, limit: Number(limit ?? '50') });
  }

  @Post()
  @Permissions('user.create')
  create(@Body() body: unknown, @Req() request: FastifyRequest) {
    return this.admin.createUser(actorOf(request), parse(createUserSchema, body), metaOf(request));
  }

  @Get(':id')
  @Permissions('user.read')
  get(@Param('id') id: string, @Req() request: FastifyRequest) {
    return this.admin.getUser(actorOf(request), parse(idSchema, id));
  }

  @Patch(':id')
  @Permissions('user.update')
  update(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    return this.admin.updateUser(actorOf(request), parse(idSchema, id), parse(updateUserSchema, body), metaOf(request));
  }

  @RequireStepUp('admin.user.reset_password')
  @Post(':id/reset-password')
  @Permissions('user.reset_password')
  resetPassword(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('x-step-up-token') stepUpToken: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    return this.admin.resetPassword(
      actorOf(request),
      parse(idSchema, id),
      { ...parse(resetPasswordSchema, body), ...(stepUpToken === undefined ? {} : { stepUpToken }) },
      metaOf(request),
    );
  }

  @RequireStepUp('admin.user.roles')
  @Put(':id/roles')
  @Permissions('role.assign')
  setRoles(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    return this.admin.setUserRoles(actorOf(request), parse(idSchema, id), parse(rolesSchema, body).roles, metaOf(request));
  }

  @Put(':id/scope')
  @Permissions('user.scope.assign')
  setScope(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    return this.admin.setUserScope(actorOf(request), parse(idSchema, id), parse(scopeSchema, body), metaOf(request));
  }

  @Post(':id/sessions/revoke')
  @HttpCode(204)
  @Permissions('session.revoke')
  async revokeSessions(@Param('id') id: string, @Req() request: FastifyRequest) {
    await this.admin.setUserScope(actorOf(request), parse(idSchema, id), {}, metaOf(request));
  }
}

/** `/roles` + `/permissions` (`API.md` §4.1, §5). */
@Controller('roles')
export class RolesAdminController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  @Permissions('role.read')
  list(@Req() request: FastifyRequest) {
    return this.admin.listRoles(actorOf(request));
  }

  @Post()
  @Permissions('role.create')
  create(@Body() body: unknown, @Req() request: FastifyRequest) {
    return this.admin.createRole(actorOf(request), parse(createRoleSchema, body), metaOf(request));
  }

  @Get(':id')
  @Permissions('role.read')
  get(@Param('id') id: string, @Req() request: FastifyRequest) {
    return this.admin.getRole(actorOf(request), parse(idSchema, id));
  }

  @Patch(':id')
  @Permissions('role.update')
  update(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    return this.admin.updateRole(actorOf(request), parse(idSchema, id), parse(updateRoleSchema, body), metaOf(request));
  }

  @Delete(':id')
  @Permissions('role.delete')
  remove(@Param('id') id: string, @Req() request: FastifyRequest) {
    return this.admin.deleteRole(actorOf(request), parse(idSchema, id), metaOf(request));
  }

  @Put(':id/permissions')
  @Permissions('role.assign')
  setPermissions(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    return this.admin.setRolePermissions(
      actorOf(request),
      parse(idSchema, id),
      parse(rolePermissionsSchema, body).permissions,
      metaOf(request),
    );
  }
}

@Controller('permissions')
export class PermissionsAdminController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  @Permissions('permission.read')
  list(@Req() request: FastifyRequest) {
    return { version: PERMISSION_COUNT, keys: PERMISSION_KEYS, actor: actorOf(request).permissions };
  }
}

/** `/organization`, `/branches`, `/departments` (`API.md` §4.2). */
@Controller()
export class OrgAdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('organization')
  @Permissions('organization.read')
  organization(@Req() request: FastifyRequest) {
    return this.admin.organization(actorOf(request));
  }

  @Patch('organization')
  @Permissions('organization.update')
  updateOrganization(@Body() body: unknown, @Req() request: FastifyRequest) {
    return this.admin.updateOrganization(actorOf(request), parse(orgPatchSchema, body), metaOf(request));
  }

  @Get('branches')
  @Permissions('branch.read')
  branches(@Req() request: FastifyRequest) {
    return this.admin.branches(actorOf(request));
  }

  @Post('branches')
  @Permissions('branch.create')
  createBranch(@Body() body: unknown, @Req() request: FastifyRequest) {
    return this.admin.createBranch(actorOf(request), parse(createBranchSchema, body), metaOf(request));
  }

  @Patch('branches/:id')
  @Permissions('branch.update')
  updateBranch(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    return this.admin.updateBranch(actorOf(request), parse(idSchema, id), parse(updateBranchSchema, body), metaOf(request));
  }

  @Get('departments')
  @Permissions('department.read')
  departments(@Req() request: FastifyRequest) {
    return this.admin.departments(actorOf(request));
  }

  @Post('departments')
  @Permissions('department.create')
  createDepartment(@Body() body: unknown, @Req() request: FastifyRequest) {
    return this.admin.createDepartment(actorOf(request), parse(createDepartmentSchema, body), metaOf(request));
  }
}

/** `/settings`, `/system/info`, `/audit-logs`, `/security-events` (`API.md` §4.17–§4.18). */
@Controller()
export class SystemAdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('settings')
  @Permissions('setting.read')
  settings(@Req() request: FastifyRequest) {
    return this.admin.settings(actorOf(request));
  }

  @Get('settings/:group')
  @Permissions('setting.read')
  settingsGroup(@Param('group') group: string, @Req() request: FastifyRequest) {
    return this.admin.settings(actorOf(request), group);
  }

  @RequireStepUp('admin.settings.update')
  @Put('settings/:group')
  @Permissions('setting.update')
  updateSettings(@Param('group') group: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    return this.admin.updateSettings(actorOf(request), group, parse(settingsSchema, body), metaOf(request));
  }

  @Get('system/info')
  @Permissions('system.read')
  systemInfo() {
    return this.admin.systemInfo();
  }

  @Get('audit-logs')
  @Permissions('audit.read')
  auditLogs(@Req() request: FastifyRequest, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.admin.auditLogs(actorOf(request), { limit: Number(limit ?? '50'), cursor });
  }

  @Get('security-events')
  @Permissions('security_event.read')
  securityEvents(@Req() request: FastifyRequest, @Query('limit') limit?: string) {
    return this.admin.securityEvents(actorOf(request), Number(limit ?? '50'));
  }
}
