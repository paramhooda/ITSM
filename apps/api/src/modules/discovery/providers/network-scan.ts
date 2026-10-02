/**
 * Network scan provider: expands subnets/ranges into hosts, probes TCP ports
 * and queries SNMP (v2c / v3) for system, interface, IP, LLDP and ENTITY-MIB
 * data. Pure helpers (target expansion, type heuristics, vendor lookup, sysDescr
 * parsing) are exported for tests and other providers.
 */
import net from 'node:net';
import dns from 'node:dns';
import snmp from 'net-snmp';
import type { DiscoveryContext, DiscoveryProvider, DiscoverySourceTarget, DiscoveredInterface, DiscoveredNeighbor, RawFinding, ReachabilityResult } from './types';

// ---------------------------------------------------------------- config

export const DEFAULT_PORTS = [22, 80, 443, 161, 3389, 445, 8443];

export interface NetworkScanConfig {
  subnets: string[];
  snmp: { version: '2c' | '3'; communities: string[]; v3?: { username?: string; authProtocol?: string; authKey?: string; privProtocol?: string; privKey?: string } };
  ports: number[];
  timeoutMs: number;
  concurrency: number;
  dnsResolve: boolean;
  maxHosts: number;
  snmpAlways: boolean;
}

export function normaliseConfig(raw: Record<string, unknown>): NetworkScanConfig {
  const snmpCfg = (raw.snmp ?? {}) as Partial<NetworkScanConfig['snmp']>;
  return {
    subnets: Array.isArray(raw.subnets) ? raw.subnets.map(String) : [],
    snmp: { version: snmpCfg.version === '3' ? '3' : '2c', communities: Array.isArray(snmpCfg.communities) ? snmpCfg.communities.map(String).filter(Boolean) : [], v3: snmpCfg.v3 },
    ports: Array.isArray(raw.ports) && raw.ports.length ? raw.ports.map(Number).filter((p) => p > 0 && p < 65536) : [...DEFAULT_PORTS],
    timeoutMs: Math.min(10_000, Math.max(200, Number(raw.timeoutMs) || 1500)),
    concurrency: Math.min(256, Math.max(1, Number(raw.concurrency) || 64)),
    dnsResolve: !!raw.dnsResolve,
    maxHosts: Math.min(65_536, Math.max(1, Number(raw.maxHosts) || 2048)),
    snmpAlways: raw.snmpAlways === undefined ? true : !!raw.snmpAlways,
  };
}

// ---------------------------------------------------------------- target expansion (pure)

const ipToInt = (ip: string) => ip.split('.').reduce((acc, o) => acc * 256 + Number(o), 0) >>> 0;
const intToIp = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
export const isIPv4 = (s: string) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every((o) => Number(o) <= 255);

/**
 * Expands CIDR blocks (10.0.0.0/24), ranges (10.0.0.1-10.0.0.50 or 10.0.0.1-50)
 * and single addresses into a de-duplicated host list, capped at `maxHosts`.
 */
export function expandTargets(subnets: string[], maxHosts = 2048): { hosts: string[]; truncated: boolean; invalid: string[] } {
  const seen = new Set<string>();
  const hosts: string[] = [];
  const invalid: string[] = [];
  let truncated = false;
  const push = (ip: string) => {
    if (seen.has(ip)) return true;
    if (hosts.length >= maxHosts) {
      truncated = true;
      return false;
    }
    seen.add(ip);
    hosts.push(ip);
    return true;
  };
  for (const rawEntry of subnets) {
    const entry = rawEntry.trim();
    if (!entry || entry.startsWith('#')) continue;
    let m: RegExpMatchArray | null;
    if ((m = entry.match(/^([\d.]+)\/(\d{1,2})$/)) && isIPv4(m[1]) && Number(m[2]) <= 32) {
      const bits = Number(m[2]);
      const base = ipToInt(m[1]);
      const size = 2 ** (32 - bits);
      const network = bits === 0 ? 0 : (base & (~0 << (32 - bits))) >>> 0;
      const first = bits >= 31 ? network : network + 1;
      const last = bits >= 31 ? network + size - 1 : network + size - 2;
      for (let n = first; n <= last; n++) if (!push(intToIp(n))) break;
    } else if ((m = entry.match(/^([\d.]+)\s*-\s*([\d.]+)$/)) && isIPv4(m[1])) {
      const start = ipToInt(m[1]);
      let endStr = m[2];
      if (!endStr.includes('.')) endStr = m[1].split('.').slice(0, 3).join('.') + '.' + endStr;
      if (!isIPv4(endStr)) {
        invalid.push(entry);
        continue;
      }
      const end = ipToInt(endStr);
      if (end < start) {
        invalid.push(entry);
        continue;
      }
      for (let n = start; n <= end; n++) if (!push(intToIp(n))) break;
    } else if (isIPv4(entry)) {
      push(entry);
    } else {
      invalid.push(entry);
    }
    if (truncated) break;
  }
  return { hosts, truncated, invalid };
}

// ---------------------------------------------------------------- vendor / type heuristics (pure)

export const ENTERPRISE_VENDORS: Record<number, string> = {
  9: 'Cisco', 2636: 'Juniper', 12356: 'Fortinet', 11: 'HPE', 674: 'Dell', 2011: 'Huawei', 25506: 'H3C', 14823: 'Aruba', 4413: 'Broadcom', 8072: 'Linux (net-snmp)',
  311: 'Microsoft', 6876: 'VMware', 318: 'APC', 232: 'HP', 1588: 'Brocade', 3375: 'F5', 2021: 'Linux (UCD-SNMP)', 4526: 'Netgear', 41112: 'Ubiquiti', 14988: 'MikroTik',
  25461: 'Palo Alto Networks', 6574: 'Synology', 789: 'NetApp', 1916: 'Extreme Networks', 3224: 'Juniper (NetScreen)', 2620: 'Check Point', 11863: 'TP-Link', 10002: 'Ubiquiti', 43: '3Com', 171: 'D-Link', 1991: 'Brocade (Foundry)', 1248: 'Seiko Epson', 2435: 'Brother', 236: 'Samsung', 641: 'Lexmark', 253: 'Xerox', 1602: 'Canon', 4: 'Unix', 2: 'IBM', 5951: 'Citrix', 1004849: 'Dell (iDRAC)', 1718: 'Lenovo',
};

export function manufacturerFromSysObjectId(oid?: string | null): string | null {
  if (!oid) return null;
  const m = oid.replace(/^\./, '').match(/^1\.3\.6\.1\.4\.1\.(\d+)/);
  if (!m) return null;
  return ENTERPRISE_VENDORS[Number(m[1])] ?? null;
}

export interface TypeHints { sysDescr?: string | null; sysObjectId?: string | null; openPorts?: number[]; manufacturer?: string | null }

/** Maps SNMP sysDescr / sysObjectID / open ports to a CI type key (`other` when unsure). */
export function suggestType(h: TypeHints): string {
  const d = (h.sysDescr ?? '').toLowerCase();
  const oid = (h.sysObjectId ?? '').replace(/^\./, '');
  const ports = new Set(h.openPorts ?? []);
  const has = (...words: string[]) => words.some((w) => d.includes(w.toLowerCase()));

  if (has('adaptive security appliance', 'fortigate', 'pan-os', 'palo alto', 'firepower', 'sonicwall', 'check point', 'checkpoint', 'pfsense', 'opnsense', 'srx', 'usg', 'netscreen', 'watchguard', 'sophos xg', 'asa ')) return 'firewall';
  if (has('vmware esxi', 'esxi', 'hyper-v', 'proxmox', 'xenserver', 'citrix hypervisor', 'nutanix ahv')) return 'hypervisor';
  if (has('apc ', 'smart-ups', 'symmetra', 'eaton', 'network management card', 'ups ')) return 'ups';
  if (has('synology', 'netapp', 'ontap', 'qnap', 'truenas', 'freenas', 'unity', 'powerstore', 'storage array', 'isilon', 'pure storage', 'nimble', 'equallogic', 'compellent', 'msa 2')) return 'storage_array';
  if (has('unifi ap', 'uap-', 'aruba ap', 'aruba instant', 'access point', 'air-ap', 'air-cap', 'aironet', 'ruckus', 'meraki mr')) return 'access_point';
  if (has('wireless controller', 'wlc', 'aruba mobility', 'aruba7', 'mobility controller')) return 'wireless_controller';
  if (has('big-ip', 'f5 networks', 'netscaler', 'citrix adc', 'load balancer', 'a10 thunder', 'haproxy')) return 'load_balancer';
  if (has('printer', 'laserjet', 'officejet', 'imagerunner', 'xerox', 'lexmark', 'brother', 'kyocera', 'ricoh', 'konica', 'epson')) return 'printer';
  if (has('routeros', 'mikrotik', ' isr', 'isr4', 'isr1', ' asr', 'asr1', 'c1100', 'c1000 ', 'cisco ios xr', 'junos') && !has('switch', 'ex2', 'ex3', 'ex4', 'qfx')) return 'router';
  if (has('ios software, c9', 'catalyst', 'c9200', 'c9300', 'c9500', 'c2960', 'c3650', 'c3850', 'nx-os', 'nexus', 'procurve', 'aruba 2', 'aruba 6', 'arubaos-switch', 'arubaos-cx', 'comware', 'extremexos', 'exos', 'ex2300', 'ex3400', 'ex4300', 'qfx', 'switch', 'fastiron', 'icx', 'dell emc networking', 'dell networking', 's4048', 'n3048', 'unifi switch', 'usw-', 'sg3', 'sg2', 'sg5')) return 'network_switch';
  if (has('ip phone', 'cp-', 'sip phone', 'polycom', 'yealink')) return 'ip_phone';
  if (has('windows server', 'windows 2', 'windows nt', 'hardware: ') && !has('windows 10', 'windows 11')) return 'server';
  if (has('windows 10', 'windows 11', 'windows 7', 'windows 8', 'macos', 'darwin')) return 'endpoint';
  if (has('linux', 'ubuntu', 'debian', 'centos', 'red hat', 'rhel', 'rocky', 'almalinux', 'suse', 'freebsd', 'openbsd', 'netbsd', 'solaris', 'sunos', 'aix', 'hp-ux', 'unix')) return 'server';
  if (has('idrac', 'ilo ', 'integrated lights-out', 'bmc', 'imm2', 'xclarity', 'cimc')) return 'server';
  if (has('camera', 'nvr', 'axis communications', 'hikvision', 'dahua', 'plc', 'modbus', 'scada', 'sensor')) return 'iot_device';

  // sysObjectID enterprise hints (device families)
  if (oid.startsWith('1.3.6.1.4.1.9.1.')) return has('router') ? 'router' : 'network_switch';
  if (oid.startsWith('1.3.6.1.4.1.12356.101')) return 'firewall';
  if (oid.startsWith('1.3.6.1.4.1.25461')) return 'firewall';
  if (oid.startsWith('1.3.6.1.4.1.6876')) return 'hypervisor';
  if (oid.startsWith('1.3.6.1.4.1.318')) return 'ups';
  if (oid.startsWith('1.3.6.1.4.1.6574')) return 'storage_array';
  if (oid.startsWith('1.3.6.1.4.1.789')) return 'storage_array';
  if (oid.startsWith('1.3.6.1.4.1.14988')) return 'router';
  if (oid.startsWith('1.3.6.1.4.1.14823.1.2')) return 'access_point';
  if (oid.startsWith('1.3.6.1.4.1.14823.1.1')) return 'wireless_controller';
  if (oid.startsWith('1.3.6.1.4.1.3375')) return 'load_balancer';
  if (oid.startsWith('1.3.6.1.4.1.2636')) return 'network_switch';
  if (oid.startsWith('1.3.6.1.4.1.311.1.1.3.1.2')) return 'server';
  if (oid.startsWith('1.3.6.1.4.1.311')) return 'endpoint';
  if (oid.startsWith('1.3.6.1.4.1.8072') || oid.startsWith('1.3.6.1.4.1.2021')) return 'server';

  // Port-based fallback
  if (ports.has(9100) || ports.has(631)) return 'printer';
  if (ports.has(3389) && !ports.has(22) && !ports.has(80) && !ports.has(443)) return 'endpoint';
  if (ports.has(3389) && (ports.has(445) || ports.has(443))) return 'server';
  if (ports.has(22) && (ports.has(80) || ports.has(443) || ports.has(8443)) && !ports.has(445)) return d ? 'server' : 'other';
  if (ports.has(22) && !ports.has(80) && !ports.has(443)) return 'server';
  if (ports.has(5900) || ports.has(5901)) return 'endpoint';
  return 'other';
}

/** Extracts OS / version / model hints from sysDescr. */
export function parseSysDescr(sysDescr?: string | null): { osName: string | null; osVersion: string | null; model: string | null } {
  if (!sysDescr) return { osName: null, osVersion: null, model: null };
  const s = sysDescr.replace(/\s+/g, ' ').trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/Cisco (IOS[- ]?XE|IOS XR|NX-OS|IOS|Adaptive Security Appliance) Software.*?Version ([\w.()]+)/i))) {
    const model = s.match(/\b(C\d{4}[A-Z0-9-]*|ISR\d{4}[A-Z0-9/-]*|ASR\d{3,4}[A-Z0-9-]*|N\d+K-[A-Z0-9-]+|WS-C[A-Z0-9-]+|ASA\s?\d{4}[A-Z0-9-]*)\b/i);
    return { osName: `Cisco ${m[1]}`, osVersion: m[2], model: model?.[1] ?? null };
  }
  if ((m = s.match(/FortiGate-?([\w-]+)?.*?v?(\d+\.\d+(?:\.\d+)?)/i))) return { osName: 'FortiOS', osVersion: m[2], model: m[1] ? `FortiGate-${m[1]}` : 'FortiGate' };
  if ((m = s.match(/Palo Alto Networks (PA-\w+).*?(\d+\.\d+(?:\.\d+)?)/i))) return { osName: 'PAN-OS', osVersion: m[2], model: m[1] };
  if ((m = s.match(/Juniper Networks, Inc\. (\S+).*?JUNOS (\S+)/i))) return { osName: 'Junos', osVersion: m[2].replace(/,$/, ''), model: m[1] };
  if ((m = s.match(/RouterOS ([\w.]+)/i))) return { osName: 'RouterOS', osVersion: m[1], model: s.match(/RouterOS [\w.]+ (\S+)/)?.[1] ?? null };
  if ((m = s.match(/VMware ESXi (\d+\.\d+(?:\.\d+)?)/i))) return { osName: 'VMware ESXi', osVersion: m[1], model: null };
  if ((m = s.match(/Hardware: .*? - Software: Windows (?:Version )?(\d+\.\d+)/i))) return { osName: 'Windows', osVersion: m[1], model: null };
  if ((m = s.match(/Windows Server (\d{4}\s?R?2?)/i))) return { osName: `Windows Server ${m[1].trim()}`, osVersion: s.match(/Version ([\d.]+)/)?.[1] ?? null, model: null };
  if ((m = s.match(/Windows (10|11|7|8\.1|8)/i))) return { osName: `Windows ${m[1]}`, osVersion: s.match(/Version ([\d.]+)/)?.[1] ?? null, model: null };
  if ((m = s.match(/^Linux (\S+) ([\d][\w.\-+]*)/i))) {
    const distro = s.match(/(Ubuntu|Debian|CentOS|Red Hat|Rocky|AlmaLinux|SUSE|Fedora|Amazon Linux)/i)?.[1];
    return { osName: distro ? `Linux (${distro})` : 'Linux', osVersion: m[2], model: null };
  }
  if ((m = s.match(/^(Darwin|FreeBSD|OpenBSD|NetBSD|SunOS|AIX|HP-UX) \S+ ([\d][\w.\-]*)/i))) return { osName: m[1], osVersion: m[2], model: null };
  if ((m = s.match(/(ArubaOS-CX|ArubaOS|ProCurve|Comware|ExtremeXOS|EXOS|FastIron|ONTAP|DSM|Synology|APC Web\/SNMP Management Card|AOS)\s*(?:Version|V|v)?\s*([\d][\w.]*)?/i))) return { osName: m[1], osVersion: m[2] ?? null, model: s.match(/\b([A-Z]{1,3}\d{3,4}[A-Z0-9-]*)\b/)?.[1] ?? null };
  const ver = s.match(/\b(?:version|v)\s?(\d+\.\d+[\w.]*)/i)?.[1] ?? null;
  return { osName: s.split(/[,;(]/)[0].slice(0, 80) || null, osVersion: ver, model: null };
}

export function suggestedCategory(f: Pick<RawFinding, 'sysDescr' | 'sysObjectId' | 'openPorts' | 'manufacturer'>) {
  return suggestType({ sysDescr: f.sysDescr, sysObjectId: f.sysObjectId, openPorts: f.openPorts, manufacturer: f.manufacturer });
}

// ---------------------------------------------------------------- probing

export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/** Simple bounded worker pool. */
export async function runPool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>, signal?: AbortSignal) {
  let next = 0;
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length && !signal?.aborted) {
        const i = next++;
        try {
          await worker(items[i], i);
        } catch {
          /* worker errors are reported by the worker itself */
        }
      }
    }),
  );
}

// ---------------------------------------------------------------- SNMP

const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysObjectId: '1.3.6.1.2.1.1.2.0',
  sysContact: '1.3.6.1.2.1.1.4.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  sysLocation: '1.3.6.1.2.1.1.6.0',
  ifDescr: '1.3.6.1.2.1.2.2.1.2',
  ifPhysAddress: '1.3.6.1.2.1.2.2.1.6',
  ifAdminStatus: '1.3.6.1.2.1.2.2.1.7',
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
  ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15',
  ifName: '1.3.6.1.2.1.31.1.1.1.1',
  ipAdEntIfIndex: '1.3.6.1.2.1.4.20.1.2',
  lldpRemPortId: '1.0.8802.1.1.2.1.4.1.1.7',
  lldpRemSysName: '1.0.8802.1.1.2.1.4.1.1.9',
  lldpLocPortId: '1.0.8802.1.1.2.1.3.7.1.3',
  entPhysicalSerialNum: '1.3.6.1.2.1.47.1.1.1.1.11',
  entPhysicalModelName: '1.3.6.1.2.1.47.1.1.1.1.13',
  cdpCacheDeviceId: '1.3.6.1.4.1.9.9.23.1.2.1.1.6',
  cdpCacheDevicePort: '1.3.6.1.4.1.9.9.23.1.2.1.1.7',
};
const MAX_ROWS = 256;

export interface SnmpResult {
  community?: string;
  sysDescr: string | null;
  sysObjectId: string | null;
  sysName: string | null;
  sysLocation: string | null;
  sysContact: string | null;
  serialNumber: string | null;
  model: string | null;
  interfaces: DiscoveredInterface[];
  neighbors: DiscoveredNeighbor[];
}

const vbText = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) {
    const s = v.toString('utf8').replace(/\0/g, '').trim();
    return s.length ? s : null;
  }
  const s = String(v).trim();
  return s.length ? s : null;
};
const vbMac = (v: unknown): string | null => {
  if (!Buffer.isBuffer(v) || v.length !== 6) return null;
  const hex = v.toString('hex');
  if (/^0+$/.test(hex)) return null;
  return hex.match(/.{2}/g)!.join(':');
};
const vbInt = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const lastIndex = (oid: string, base: string) => Number(oid.slice(base.length + 1).split('.')[0]);

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      onTimeout();
      reject(new Error('timeout'));
    }, ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function snmpGet(session: snmp.Session, oids: string[], hardTimeout: number): Promise<Map<string, unknown>> {
  return withTimeout(
    new Promise<Map<string, unknown>>((resolve, reject) => {
      session.get(oids, (err, varbinds) => {
        if (err) return reject(err);
        const out = new Map<string, unknown>();
        for (const vb of varbinds ?? []) if (!snmp.isVarbindError(vb)) out.set(vb.oid.replace(/^\./, ''), vb.value);
        resolve(out);
      });
    }),
    hardTimeout,
    () => session.cancelRequests(new Error('timeout')),
  );
}

function snmpSubtree(session: snmp.Session, oid: string, hardTimeout: number, maxRows = MAX_ROWS): Promise<{ oid: string; value: unknown }[]> {
  return withTimeout(
    new Promise<{ oid: string; value: unknown }[]>((resolve) => {
      const rows: { oid: string; value: unknown }[] = [];
      session.subtree(
        oid,
        20,
        (varbinds) => {
          for (const vb of varbinds) if (!snmp.isVarbindError(vb)) rows.push({ oid: vb.oid.replace(/^\./, ''), value: vb.value });
          return rows.length >= maxRows; // true stops the walk
        },
        () => resolve(rows.slice(0, maxRows)),
      );
    }),
    hardTimeout,
    () => session.cancelRequests(new Error('timeout')),
  ).catch(() => [] as { oid: string; value: unknown }[]);
}

function createSession(host: string, cfg: NetworkScanConfig, community: string | null) {
  const timeout = cfg.timeoutMs;
  if (cfg.snmp.version === '3' && cfg.snmp.v3?.username) {
    const v3 = cfg.snmp.v3;
    const auth = (v3.authProtocol ?? 'none').toLowerCase();
    const priv = (v3.privProtocol ?? 'none').toLowerCase();
    const level = auth !== 'none' && v3.authKey ? (priv !== 'none' && v3.privKey ? snmp.SecurityLevel.authPriv : snmp.SecurityLevel.authNoPriv) : snmp.SecurityLevel.noAuthNoPriv;
    const authMap: Record<string, number> = { md5: snmp.AuthProtocols.md5, sha: snmp.AuthProtocols.sha, sha1: snmp.AuthProtocols.sha, sha224: snmp.AuthProtocols.sha224, sha256: snmp.AuthProtocols.sha256, sha384: snmp.AuthProtocols.sha384, sha512: snmp.AuthProtocols.sha512 };
    const privMap: Record<string, number> = { des: snmp.PrivProtocols.des, aes: snmp.PrivProtocols.aes, aes128: snmp.PrivProtocols.aes, aes256: snmp.PrivProtocols.aes256b, aes256b: snmp.PrivProtocols.aes256b, aes256r: snmp.PrivProtocols.aes256r };
    return snmp.createV3Session(host, { name: v3.username!, level, authProtocol: authMap[auth], authKey: v3.authKey, privProtocol: privMap[priv], privKey: v3.privKey }, { version: snmp.Version3, timeout, retries: 0 });
  }
  return snmp.createSession(host, community ?? 'public', { version: snmp.Version2c, timeout, retries: 0 });
}

/** Queries a host over SNMP, trying each community in turn (v2c) or the v3 user. Returns null when nothing answers. */
export async function snmpQuery(host: string, cfg: NetworkScanConfig, opts: { full?: boolean } = {}): Promise<SnmpResult | null> {
  const candidates = cfg.snmp.version === '3' ? [null] : cfg.snmp.communities.length ? cfg.snmp.communities : [];
  for (const community of candidates) {
    let session: snmp.Session | null = null;
    try {
      session = createSession(host, cfg, community);
      session.on('error', () => undefined);
      const sys = await snmpGet(session, [OID.sysDescr, OID.sysObjectId, OID.sysName, OID.sysLocation, OID.sysContact], cfg.timeoutMs * 2 + 500);
      if (!sys.size) continue;
      const result: SnmpResult = {
        community: community ?? undefined,
        sysDescr: vbText(sys.get(OID.sysDescr)),
        sysObjectId: vbText(sys.get(OID.sysObjectId))?.replace(/^\./, '') ?? null,
        sysName: vbText(sys.get(OID.sysName)),
        sysLocation: vbText(sys.get(OID.sysLocation)),
        sysContact: vbText(sys.get(OID.sysContact)),
        serialNumber: null,
        model: null,
        interfaces: [],
        neighbors: [],
      };
      if (opts.full !== false) {
        const walkTimeout = Math.max(cfg.timeoutMs * 4, 6000);
        const [ifDescr, ifPhys, ifOper, ifAdmin, ifSpeed, ipIf, lldpSys, lldpPort, entSerial, entModel] = await Promise.all([
          snmpSubtree(session, OID.ifDescr, walkTimeout),
          snmpSubtree(session, OID.ifPhysAddress, walkTimeout),
          snmpSubtree(session, OID.ifOperStatus, walkTimeout),
          snmpSubtree(session, OID.ifAdminStatus, walkTimeout),
          snmpSubtree(session, OID.ifHighSpeed, walkTimeout),
          snmpSubtree(session, OID.ipAdEntIfIndex, walkTimeout),
          snmpSubtree(session, OID.lldpRemSysName, walkTimeout, 128),
          snmpSubtree(session, OID.lldpRemPortId, walkTimeout, 128),
          snmpSubtree(session, OID.entPhysicalSerialNum, walkTimeout, 64),
          snmpSubtree(session, OID.entPhysicalModelName, walkTimeout, 64),
        ]);
        const ifs = new Map<number, DiscoveredInterface>();
        const ifOf = (idx: number) => {
          let i = ifs.get(idx);
          if (!i) ifs.set(idx, (i = { name: `if${idx}`, ifIndex: idx }));
          return i;
        };
        for (const r of ifDescr) {
          const idx = lastIndex(r.oid, OID.ifDescr);
          const name = vbText(r.value);
          if (name) ifOf(idx).name = name.slice(0, 120);
        }
        for (const r of ifPhys) ifOf(lastIndex(r.oid, OID.ifPhysAddress)).macAddress = vbMac(r.value);
        const statusText = (v: unknown) => ({ 1: 'up', 2: 'down', 3: 'testing', 5: 'dormant', 6: 'notPresent', 7: 'lowerLayerDown' } as Record<number, string>)[vbInt(v) ?? 0] ?? null;
        for (const r of ifOper) ifOf(lastIndex(r.oid, OID.ifOperStatus)).operStatus = statusText(r.value);
        for (const r of ifAdmin) ifOf(lastIndex(r.oid, OID.ifAdminStatus)).adminStatus = statusText(r.value);
        for (const r of ifSpeed) ifOf(lastIndex(r.oid, OID.ifHighSpeed)).speedMbps = vbInt(r.value);
        for (const r of ipIf) {
          const ip = r.oid.slice(OID.ipAdEntIfIndex.length + 1);
          const idx = vbInt(r.value);
          if (idx !== null && isIPv4(ip) && ifs.has(idx)) {
            const i = ifs.get(idx)!;
            if (!i.ipAddress) i.ipAddress = ip;
          }
        }
        result.interfaces = [...ifs.values()].filter((i) => i.name && !/^(lo|loopback|null0|unrouted)/i.test(i.name) || i.macAddress).slice(0, MAX_ROWS);
        const neighborsByKey = new Map<string, DiscoveredNeighbor>();
        for (const r of lldpSys) {
          const key = r.oid.slice(OID.lldpRemSysName.length + 1);
          const local = key.split('.')[1];
          neighborsByKey.set(key, { protocol: 'lldp', localPort: local ? `ifIndex ${local}` : null, remoteSysName: vbText(r.value), remotePort: null, remoteIp: null });
        }
        for (const r of lldpPort) {
          const key = r.oid.slice(OID.lldpRemPortId.length + 1);
          const n = neighborsByKey.get(key);
          const port = Buffer.isBuffer(r.value) && r.value.length === 6 ? vbMac(r.value) : vbText(r.value);
          if (n) n.remotePort = port;
          else neighborsByKey.set(key, { protocol: 'lldp', localPort: null, remoteSysName: null, remotePort: port, remoteIp: null });
        }
        if (result.sysObjectId?.startsWith('1.3.6.1.4.1.9.')) {
          const [cdpId, cdpPort] = await Promise.all([snmpSubtree(session, OID.cdpCacheDeviceId, walkTimeout, 128), snmpSubtree(session, OID.cdpCacheDevicePort, walkTimeout, 128)]);
          const cdp = new Map<string, DiscoveredNeighbor>();
          for (const r of cdpId) cdp.set(r.oid.slice(OID.cdpCacheDeviceId.length + 1), { protocol: 'cdp', localPort: `ifIndex ${r.oid.slice(OID.cdpCacheDeviceId.length + 1).split('.')[0]}`, remoteSysName: vbText(r.value), remotePort: null, remoteIp: null });
          for (const r of cdpPort) {
            const n = cdp.get(r.oid.slice(OID.cdpCacheDevicePort.length + 1));
            if (n) n.remotePort = vbText(r.value);
          }
          for (const [k, v] of cdp) if (!neighborsByKey.has(`cdp:${k}`)) neighborsByKey.set(`cdp:${k}`, v);
        }
        result.neighbors = [...neighborsByKey.values()].filter((n) => n.remoteSysName || n.remotePort).slice(0, 128);
        result.serialNumber = entSerial.map((r) => vbText(r.value)).find((s) => s && s.length >= 4 && !/^(n\/a|none|unknown|not available)$/i.test(s)) ?? null;
        result.model = entModel.map((r) => vbText(r.value)).find((s) => s && s.length >= 2 && !/^(n\/a|none|unknown)$/i.test(s)) ?? null;
      }
      return result;
    } catch {
      // timeout / wrong community: try the next candidate
    } finally {
      try {
        session?.close();
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

async function reverseDns(ip: string, timeoutMs: number): Promise<string | null> {
  try {
    const names = await withTimeout(dns.promises.reverse(ip), timeoutMs, () => undefined);
    return names[0]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- per host

export async function scanHost(ip: string, cfg: NetworkScanConfig): Promise<RawFinding | null> {
  const openPorts: number[] = [];
  const snmpPossible = cfg.snmp.version === '3' ? !!cfg.snmp.v3?.username : cfg.snmp.communities.length > 0;
  const [portResults, snmpRes] = await Promise.all([
    Promise.all(cfg.ports.map((p) => tcpProbe(ip, p, cfg.timeoutMs).then((ok) => (ok ? p : null)))),
    snmpPossible && cfg.snmpAlways ? snmpQuery(ip, cfg) : Promise.resolve(null),
  ]);
  for (const p of portResults) if (p !== null) openPorts.push(p);
  let snmpData = snmpRes;
  if (!snmpData && snmpPossible && !cfg.snmpAlways && openPorts.length) snmpData = await snmpQuery(ip, cfg);
  if (!openPorts.length && !snmpData) return null;

  const fqdn = cfg.dnsResolve ? await reverseDns(ip, Math.max(cfg.timeoutMs, 1000)) : null;
  const parsed = parseSysDescr(snmpData?.sysDescr);
  const hostname = (snmpData?.sysName ?? fqdn)?.split('.')[0].toLowerCase() ?? null;
  const manufacturer = manufacturerFromSysObjectId(snmpData?.sysObjectId) ?? (parsed.osName?.startsWith('Cisco') ? 'Cisco' : null);
  const primaryMac = snmpData?.interfaces.find((i) => i.ipAddress === ip && i.macAddress)?.macAddress ?? snmpData?.interfaces.find((i) => i.macAddress)?.macAddress ?? null;
  const finding: RawFinding = {
    ipAddress: ip,
    hostname,
    fqdn: fqdn ?? (snmpData?.sysName?.includes('.') ? snmpData.sysName.toLowerCase() : null),
    macAddress: primaryMac,
    manufacturer,
    model: snmpData?.model ?? parsed.model,
    serialNumber: snmpData?.serialNumber ?? null,
    osName: parsed.osName,
    osVersion: parsed.osVersion,
    sysDescr: snmpData?.sysDescr ?? null,
    sysObjectId: snmpData?.sysObjectId ?? null,
    sysName: snmpData?.sysName ?? null,
    sysLocation: snmpData?.sysLocation ?? null,
    sysContact: snmpData?.sysContact ?? null,
    suggestedTypeKey: suggestType({ sysDescr: snmpData?.sysDescr, sysObjectId: snmpData?.sysObjectId, openPorts, manufacturer }),
    openPorts: openPorts.sort((a, b) => a - b),
    interfaces: snmpData?.interfaces ?? [],
    neighbors: snmpData?.neighbors ?? [],
    raw: { snmp: !!snmpData, community: snmpData?.community ? '********' : undefined, sysLocation: snmpData?.sysLocation, sysContact: snmpData?.sysContact, reverseDns: fqdn, scannedAt: new Date().toISOString() },
  };
  return finding;
}

// ---------------------------------------------------------------- provider

export const networkScanProvider: DiscoveryProvider = {
  type: 'network_scan',
  label: 'Network scan (TCP + SNMP)',
  async discover(source: DiscoverySourceTarget, ctx: DiscoveryContext) {
    const cfg = normaliseConfig(source.config);
    const { hosts, truncated, invalid } = expandTargets(cfg.subnets, cfg.maxHosts);
    if (invalid.length) ctx.log(`Ignoring invalid targets: ${invalid.join(', ')}`);
    if (truncated) ctx.log(`Target list truncated to maxHosts=${cfg.maxHosts}`);
    ctx.log(`Scanning ${hosts.length} host(s), ports [${cfg.ports.join(', ')}], SNMP v${cfg.snmp.version} ${cfg.snmp.version === '3' ? (cfg.snmp.v3?.username ? `user ${cfg.snmp.v3.username}` : 'disabled (no user)') : `${cfg.snmp.communities.length} communit${cfg.snmp.communities.length === 1 ? 'y' : 'ies'}`}, timeout ${cfg.timeoutMs}ms, concurrency ${cfg.concurrency}`);
    const stats = { hostsScanned: 0, responsive: 0, snmp: 0 };
    await runPool(
      hosts,
      cfg.concurrency,
      async (ip) => {
        stats.hostsScanned++;
        try {
          const finding = await scanHost(ip, cfg);
          if (!finding) return;
          stats.responsive++;
          if (finding.raw.snmp) stats.snmp++;
          ctx.log(`${ip}${finding.hostname ? ` (${finding.hostname})` : ''}: ports [${finding.openPorts.join(',')}]${finding.raw.snmp ? ' snmp' : ''} -> ${finding.suggestedTypeKey}`);
          await ctx.onFinding(finding);
        } catch (err) {
          ctx.log(`${ip}: error ${(err as Error).message}`);
        }
      },
      ctx.signal,
    );
    return stats;
  },
  async test(source: DiscoverySourceTarget) {
    const cfg = normaliseConfig(source.config);
    const { hosts, invalid } = expandTargets(cfg.subnets, cfg.maxHosts);
    if (!hosts.length) return { ok: false, message: invalid.length ? `No valid targets (${invalid.join(', ')})` : 'No targets configured', results: [] };
    const sample = hosts.slice(0, 5);
    const results: ReachabilityResult[] = [];
    await runPool(sample, 5, async (host) => {
      const started = Date.now();
      const quick = { ...cfg, timeoutMs: Math.min(cfg.timeoutMs, 2000) };
      const [ports, snmpRes] = await Promise.all([
        Promise.all(quick.ports.map((p) => tcpProbe(host, p, quick.timeoutMs).then((ok) => (ok ? p : null)))),
        (quick.snmp.version === '3' ? !!quick.snmp.v3?.username : quick.snmp.communities.length > 0) ? snmpQuery(host, quick, { full: false }) : Promise.resolve(null),
      ]);
      const openPorts = ports.filter((p): p is number => p !== null);
      results.push({ host, reachable: openPorts.length > 0 || !!snmpRes, openPorts, snmp: !!snmpRes, hostname: snmpRes?.sysName ?? null, sysDescr: snmpRes?.sysDescr?.slice(0, 160) ?? null, latencyMs: Date.now() - started });
    });
    results.sort((a, b) => ipToInt(a.host) - ipToInt(b.host));
    const reachable = results.filter((r) => r.reachable).length;
    return { ok: reachable > 0, message: `${reachable}/${results.length} sampled host(s) reachable${hosts.length > sample.length ? ` (first ${sample.length} of ${hosts.length})` : ''}`, results };
  },
};
