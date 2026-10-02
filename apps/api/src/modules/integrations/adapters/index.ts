import type { IntegrationAdapter } from './types';
import { prtgAdapter } from './prtg';
import { fortisiemAdapter } from './fortisiem';
import { genericAdapter } from './generic';

export * from './types';

/** Registry of inbound adapters. Register new sources here (Zabbix, EDR, e-mail...). */
export const ADAPTERS: Record<string, IntegrationAdapter> = {
  prtg: prtgAdapter,
  fortisiem: fortisiemAdapter,
  generic: genericAdapter,
};

export const INTEGRATION_TYPES = Object.keys(ADAPTERS) as [string, ...string[]];

export function getAdapter(type: string): IntegrationAdapter {
  return ADAPTERS[type] ?? genericAdapter;
}

/** Path (relative to the API prefix) that the external system should post to. */
export function webhookPath(type: string, integrationId: string) {
  if (type === 'prtg' || type === 'fortisiem') return `/integrations/${type}/${integrationId}`;
  return `/integrations/${integrationId}/events`;
}
