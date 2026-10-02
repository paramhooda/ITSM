import { AdapterParseError, clip, firstStr, isIp, isRecord, normalizeKeys, slug, str, toDate, type EventSeverity, type EventStatus, type IntegrationAdapter, type NormalizedEvent } from './types';

/**
 * FortiSIEM incident notifications (Notification Policy → HTTP(S) action with
 * a JSON body). Accepts the common incident attributes: incidentId,
 * incidentTitle / eventName, incidentSeverity (0-10) or severityCat,
 * incidentStatus, incidentSrc / incidentTarget, incidentCategory,
 * incidentDetail, incidentFirstSeen / incidentLastSeen, rawEvents.
 */

export function mapFortisiemSeverity(numeric: unknown, category: unknown): EventSeverity {
  const n = typeof numeric === 'number' ? numeric : typeof numeric === 'string' && numeric.trim() !== '' ? Number(numeric) : NaN;
  if (Number.isFinite(n)) {
    if (n >= 9) return 'critical';
    if (n >= 7) return 'high';
    if (n >= 4) return 'medium';
    return 'low';
  }
  const c = String(category ?? '').trim().toUpperCase();
  if (c === 'CRITICAL') return 'critical';
  if (c === 'HIGH') return 'high';
  if (c === 'MEDIUM' || c === 'MED') return 'medium';
  if (c === 'LOW' || c === 'INFO') return 'low';
  return 'medium';
}

export function mapFortisiemStatus(raw: unknown): EventStatus {
  if (typeof raw === 'number') return raw === 0 ? 'open' : 'resolved';
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s === 'active' || s === '0' || s === 'open') return 'open';
  if (s.includes('clear') || s.includes('closed') || s.includes('resolved') || s === '1' || s === '2' || s === '3') return 'resolved';
  if (s.includes('progress') || s.includes('ack')) return 'acknowledged';
  return 'open';
}

interface HostRef {
  hostName?: string;
  ip?: string;
}

/** `incidentSrc` / `incidentTarget` arrive as objects, arrays or the FortiSIEM attribute string `hostName:fw-01,hostIpAddr:10.1.1.1`. */
export function parseHostRef(v: unknown): HostRef {
  if (Array.isArray(v)) return parseHostRef(v[0]);
  if (isRecord(v)) {
    const p = normalizeKeys(v);
    const hostName = firstStr(p, 'hostname', 'destname', 'srcname', 'name', 'devname', 'host');
    const ip = firstStr(p, 'hostipaddr', 'destipaddr', 'srcipaddr', 'ipaddr', 'ip');
    return { hostName, ip: isIp(ip) ? ip : undefined };
  }
  const s = str(v);
  if (!s) return {};
  const pick = (re: RegExp) => s.match(re)?.[1]?.trim();
  const hostName = pick(/(?:hostName|destName|srcName|name)\s*[:=]\s*([^,;|]+)/i);
  const ip = pick(/(?:hostIpAddr|destIpAddr|srcIpAddr|ipAddr|ip)\s*[:=]\s*([^,;|\s]+)/i);
  if (!hostName && !ip && isIp(s)) return { ip: s };
  if (!hostName && !ip) return { hostName: s };
  return { hostName, ip: isIp(ip) ? ip : undefined };
}

export function parseFortisiemEvent(payload: unknown): NormalizedEvent {
  if (!isRecord(payload)) throw new AdapterParseError('FortiSIEM payload must be a JSON object');
  const p = normalizeKeys(payload);
  const incidentId = firstStr(p, 'incidentid', 'incident', 'id');
  if (!incidentId) throw new AdapterParseError('FortiSIEM payload needs an incidentId');
  const title = firstStr(p, 'incidenttitle', 'eventname', 'incidentrulename', 'rulename', 'title') ?? `FortiSIEM incident ${incidentId}`;
  const detailRaw = p.incidentdetail ?? p.detail ?? p.incidentdetails;
  const detail = isRecord(detailRaw) ? Object.entries(detailRaw).map(([k, v]) => `${k}: ${str(v) ?? JSON.stringify(v)}`).join(', ') : str(detailRaw);
  const severity = mapFortisiemSeverity(p.incidentseverity ?? p.severity, p.severitycat ?? p.severitycategory);
  const status = mapFortisiemStatus(p.incidentstatus ?? p.status);
  const target = parseHostRef(p.incidenttarget ?? p.target);
  const source = parseHostRef(p.incidentsrc ?? p.incidentsource ?? p.source);
  const host = target.hostName ?? source.hostName;
  const ipAddress = target.ip ?? source.ip;
  const category = firstStr(p, 'incidentcategory', 'category', 'eventtype');
  const subcategory = firstStr(p, 'incidentsubcategory', 'subcategory');
  const organization = firstStr(p, 'customer', 'orgname', 'organization', 'custname', 'custid', 'org');
  const tags = ['fortisiem'];
  if (category) tags.push(`category:${clip(slug(category), 40)}`);
  if (subcategory) tags.push(`subcategory:${clip(slug(subcategory), 40)}`);
  const message = detail ? `${title} — ${detail}` : title;

  return {
    externalId: incidentId,
    eventType: `fortisiem.${category ? slug(category) : 'incident'}`,
    severity,
    status,
    host,
    ipAddress,
    sensor: firstStr(p, 'eventname', 'incidentrulename', 'rulename') ?? title,
    message: clip(message, 2000)!,
    occurredAt: toDate(p.incidentlastseen ?? p.incidentfirstseen ?? p.lastseen ?? p.firstseen ?? p.timestamp),
    siemRef: host,
    tags,
    group: organization,
    raw: payload,
  };
}

export const fortisiemAdapter: IntegrationAdapter = {
  type: 'fortisiem',
  label: 'FortiSIEM',
  description: 'Security incidents from FortiSIEM notification policies. Active incidents create SOC tickets, cleared incidents resolve them.',
  refField: 'siemRef',
  parse: (payload) => parseFortisiemEvent(payload),
  samplePayload: {
    incidentId: 1024,
    incidentTitle: 'Brute force login attempt from 203.0.113.5 to fw-01',
    eventName: 'Multiple Logon Failures: Same Source',
    incidentSeverity: 8,
    severityCat: 'HIGH',
    incidentStatus: 'Active',
    incidentCategory: 'Security/Authentication',
    incidentSrc: { hostName: 'attacker-host', hostIpAddr: '203.0.113.5' },
    incidentTarget: { hostName: 'fw-01', hostIpAddr: '10.1.1.1' },
    incidentDetail: '15 failed SSH logins within 5 minutes',
    incidentFirstSeen: 1760000000000,
    incidentLastSeen: 1760000300000,
    customer: 'Customer A',
    rawEvents: ['<190>date=2026-10-02 time=14:03:11 devname="fw-01" logid="0100032002" type="event" subtype="system" level="alert" action="login" status="failed" user="admin" srcip=203.0.113.5'],
  },
  defaultRules: { domain: 'soc', defaultCategoryKey: 'security_incident', assignTeamKey: 'soc', minSeverityForTicket: 'medium', titleTemplate: '{{message}}' },
  docs: `### Configure FortiSIEM

1. Go to **ADMIN → Settings → General → Notification Policy** and create a policy for the rules / severities that should reach the service desk (e.g. severity ≥ 5).
2. In **Actions** choose **Invoke an HTTP(S) action** (or *Send notification via HTTP* on older releases):
   * **URL**: \`{{webhookUrl}}\`
   * **Method**: \`POST\`, **Content-Type**: \`application/json\`
   * **Header**: \`X-API-Key: {{apiKey}}\` – if headers cannot be set, append \`?key={{apiKey}}\` to the URL instead
   * **Body** (JSON with incident attributes):
     \`\`\`json
     {"incidentId": "$incidentId", "incidentTitle": "$incidentTitle", "eventName": "$ruleName", "incidentSeverity": "$incidentSeverity", "incidentStatus": "$incidentStatus", "incidentCategory": "$incidentCategory", "incidentSrc": "$incidentSrc", "incidentTarget": "$incidentTarget", "incidentDetail": "$incidentDetail", "incidentFirstSeen": "$incidentFirstSeen", "incidentLastSeen": "$incidentLastSeen", "customer": "$customer"}
     \`\`\`
3. Enable **Notify on incident clear** so that resolved incidents close tickets automatically.
4. For multi-tenant FortiSIEM deployments add a **customer mapping** rule per organization (\`group\` = FortiSIEM organization name) in this integration.

The incident target host name is stored as the CI's *SIEM reference* once matched by IP address or hostname.`,
};
