import type { DiscoveryProvider } from './types';
import { networkScanProvider } from './network-scan';

const registry = new Map<string, DiscoveryProvider>();

export function registerProvider(p: DiscoveryProvider) {
  registry.set(p.type, p);
}

export function getProvider(type: string): DiscoveryProvider | undefined {
  return registry.get(type);
}

export function listProviders() {
  return [...registry.values()].map((p) => ({ type: p.type, label: p.label, supportsTest: !!p.test }));
}

registerProvider(networkScanProvider);

export type { DiscoveryProvider, DiscoverySourceTarget, RawFinding, DiscoveryContext, DiscoveryStats } from './types';
