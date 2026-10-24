import 'server-only';
import { panelConfig } from './config.ts';

/**
 * The support address a sign-in page shows: the `PANEL_SUPPORT_EMAIL` value. Drive has no
 * admin-set support contact yet (the marketplace reads one from its notifications module).
 */
export function supportEmail(): Promise<string> {
  return Promise.resolve(panelConfig().supportEmail);
}
