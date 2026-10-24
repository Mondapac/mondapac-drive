import { getRequestConfig } from 'next-intl/server';
import { panelConfig } from '../server/config.ts';

// The locale is the Market's (PANEL_LOCALE, ADR-0033 decision 10). The message catalogue is still
// the one English one until a Market needs another language.
export default getRequestConfig(async () => ({
  locale: panelConfig().locale,
  messages: (await import('../../messages/en.json')).default,
}));
