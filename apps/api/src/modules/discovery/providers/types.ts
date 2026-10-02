/**
 * Discovery provider abstraction. A provider turns a `discovery_sources` row
 * of its `type` into findings (hosts/devices/resources). Network scanning is
 * the first provider; agents, cloud inventories and monitoring imports plug in
 * by implementing this interface and calling `registerProvider`.
 */
export interface DiscoverySourceTarget {
  id: string;
  customerId: string;
  siteId: string | null;
  name: string;
  sourceType: string;
  /** Decrypted configuration (secrets are plain inside the worker only). */
  config: Record<string, unknown>;
}

export interface DiscoveredInterface {
  name: string;
  ifIndex?: number | null;
  description?: string | null;
  macAddress?: string | null;
  ipAddress?: string | null;
  speedMbps?: number | null;
  adminStatus?: string | null;
  operStatus?: string | null;
}

export interface DiscoveredNeighbor {
  protocol: 'lldp' | 'cdp' | 'other';
  localPort?: string | null;
  remoteSysName?: string | null;
  remotePort?: string | null;
  remoteIp?: string | null;
}

/** A device/host as seen by a provider, before reconciliation with the CMDB. */
export interface RawFinding {
  ipAddress: string;
  hostname?: string | null;
  fqdn?: string | null;
  macAddress?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  osName?: string | null;
  osVersion?: string | null;
  sysDescr?: string | null;
  sysObjectId?: string | null;
  sysName?: string | null;
  sysLocation?: string | null;
  sysContact?: string | null;
  suggestedTypeKey?: string | null;
  openPorts: number[];
  interfaces: DiscoveredInterface[];
  neighbors: DiscoveredNeighbor[];
  raw: Record<string, unknown>;
}

export interface DiscoveryStats {
  hostsScanned: number;
  responsive: number;
  snmp: number;
  [k: string]: number;
}

export interface DiscoveryContext {
  log(line: string): void;
  onFinding(finding: RawFinding): Promise<void>;
  /** Set when the run should stop early (worker shutdown). */
  signal?: AbortSignal;
}

export interface ReachabilityResult { host: string; reachable: boolean; openPorts: number[]; snmp: boolean; hostname?: string | null; sysDescr?: string | null; latencyMs: number }

export interface DiscoveryProvider {
  type: string;
  label: string;
  discover(source: DiscoverySourceTarget, ctx: DiscoveryContext): Promise<DiscoveryStats>;
  /** Quick connectivity check for the UI ("Test"). */
  test?(source: DiscoverySourceTarget): Promise<{ ok: boolean; message: string; results: ReachabilityResult[] }>;
}
