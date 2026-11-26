import { Hono } from 'hono';
import type { AppEnv, Deps } from '../../context.ts';
import { auditRoutes } from '../audit/audit.routes.ts';
import { auditIntegrityRoutes } from '../audit/integrity.routes.ts';
import { adminQrRoutes } from '../qr/admin-qr.routes.ts';
import { adminCustodyRoutes } from '../custody/custody.routes.ts';
import { adminBranchRoutes } from './branches.routes.ts';
import { adminEmailRoutes } from './email.routes.ts';
import { adminInstructionRoutes } from './instructions.routes.ts';
import { adminRegistrationRoutes } from './registrations.routes.ts';
import { adminReportRoutes } from './reports.routes.ts';
import { adminStaffRoutes } from './staff.routes.ts';
import { adminStatsRoutes } from './stats.routes.ts';

/**
 * Everything under /api/v1/admin. Each route declares its own permission (and MFA via
 * requirePermission); none is granted to customers, collection staff or lab operators.
 */
export function adminRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.route('/', adminStatsRoutes(deps));
  r.route('/', adminRegistrationRoutes(deps));
  r.route('/', adminQrRoutes(deps));
  r.route('/', adminStaffRoutes(deps));
  r.route('/', adminBranchRoutes(deps));
  r.route('/', adminInstructionRoutes(deps));
  r.route('/', adminEmailRoutes(deps));
  r.route('/', auditRoutes(deps));
  r.route('/', auditIntegrityRoutes(deps));
  r.route('/', adminReportRoutes(deps));
  r.route('/', adminCustodyRoutes(deps));
  return r;
}
