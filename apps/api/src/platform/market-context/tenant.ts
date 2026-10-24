import { parseTenantId } from '@mondapac-drive/shared-kernel';
import type { TenantId } from '@mondapac-drive/shared-kernel';

// The tenant is a seam only (ADR-0001 decision 2): one named constant supplied by the
// application (ADR-0020 decision 6), never an environment variable, a configuration field or
// a database default. It is provided through TENANT_ID so that tests can override it.
const tenant = parseTenantId('mondapac');
if (!tenant.ok) throw new Error('The platform tenant constant is malformed');

/** The single tenant of the platform. */
export const PLATFORM_TENANT_ID: TenantId = tenant.value;

/** Injection token for the tenant that `MarketContextFactory` puts in every context. */
export const TENANT_ID = Symbol('TENANT_ID');
