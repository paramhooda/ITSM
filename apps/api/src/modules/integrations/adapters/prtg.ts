import { AdapterParseError, clip, firstStr, isIp, isRecord, normalizeKeys, slug, toDate, type EventSeverity, type EventStatus, type IntegrationAdapter, type NormalizedEvent } from './types';

/**
 * PRTG Network Monitor "Execute HTTP Action" notifications. PRTG cannot set
 * custom headers, so the notification posts form-encoded placeholders
 * (`sensorid=%sensorid&status=%status&...`) to the webhook URL carrying the API
 * key as `?key=`. JSON bodies with the same keys (with or without `%`) are
 * accepted as well.
 */

const STAR_SEVERITY: Record<number, EventSeverity> = { 5: 'critical', 4: 'high', 3: 'medium', 2: 'low', 1: 'info' };

function severityFromPriority(priority: string | undefined): EventSeverity | undefined {
  if (!priority) return undefined;
  const stars = (priority.match(/\*/g) ?? []).length;
  if (stars) return STAR_SEVERITY[Math.min(5, stars)];
  const n = Number(priority);
  if (Number.isFinite(n) && n >= 1 && n <= 5) return STAR_SEVERITY[Math.round(n)];
  const word = priority.toLowerCase();
  if (word.includes('critical')) return 'critical';
  if (word.includes('high')) return 'high';
  if (word.includes('medium') || word.includes('normal')) return 'medium';
  if (word.includes('low')) return 'low';
  return undefined;
}

export interface PrtgStatusMapping {
  status: EventStatus;
  severity?: EventSeverity;
  key: string;
}

/** Maps the PRTG sensor status text (`%status`) to the normalized status. */
export function mapPrtgStatus(raw: string | undefined): PrtgStatusMapping {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return { status: 'open', key: 'unknown' };
  if (s.includes('acknowledged')) return { status: 'acknowledged', key: 'down_acknowledged' };
  if (s.startsWith('down') || s.startsWith('error')) return { status: 'open', key: s.includes('partial') ? 'down_partial' : s.startsWith('error') ? 'error' : 'down' };
  if (s.startsWith('up') || s === 'ok') return { status: 'resolved', key: 'up' };
  if (s.startsWith('warning')) return { status: 'open', severity: 'medium', key: 'warning' };
  if (s.startsWith('unusual')) return { status: 'open', severity: 'low', key: 'unusual' };
  if (s.startsWith('paused')) return { status: 'info', severity: 'info', key: 'paused' };
  if (s.startsWith('unknown') || s === 'none' || s.startsWith('collecting')) return { status: 'info', severity: 'info', key: slug(s) };
  return { status: 'open', key: slug(s) };
}

export function parsePrtgEvent(payload: unknown): NormalizedEvent {
  if (!isRecord(payload)) throw new AdapterParseError('PRTG payload must be a JSON object or form-encoded body');
  const p = normalizeKeys(payload);
  const sensorId = firstStr(p, 'sensorid', 'sensor_id', 'objid', 'id');
  const deviceId = firstStr(p, 'deviceid', 'device_id', 'parentid');
  const device = firstStr(p, 'device', 'devicename');
  const hostField = firstStr(p, 'host', 'hostname', 'ip', 'ipaddress');
  const sensor = firstStr(p, 'name', 'sensor', 'sensorname');
  const statusRaw = firstStr(p, 'status', 'sensorstatus', 'state');
  const mapped = mapPrtgStatus(statusRaw);
  const message = firstStr(p, 'message', 'lastmessage', 'text', 'msg') ?? [sensor, statusRaw].filter(Boolean).join(' is ') ?? 'PRTG notification';
  const prioritySeverity = severityFromPriority(firstStr(p, 'priority', 'prio'));
  // Priority stars describe how important the sensor is; the status decides whether it is a problem at all.
  const severity: EventSeverity = mapped.status === 'info' ? 'info' : mapped.key === 'warning' ? 'medium' : (prioritySeverity ?? (mapped.key === 'unusual' ? 'low' : 'high'));

  const externalId = sensorId ? (deviceId ? `${deviceId}:${sensorId}` : sensorId) : device && sensor ? `${device}/${sensor}` : undefined;
  if (!externalId) throw new AdapterParseError('PRTG payload needs a sensorid (or device + sensor name)');

  const ipAddress = isIp(hostField) ? hostField : isIp(device) ? device : undefined;
  const host = device && !isIp(device) ? device : hostField && !isIp(hostField) ? hostField : device ?? hostField;
  const group = firstStr(p, 'group', 'groupname');
  const probe = firstStr(p, 'probe', 'probename');
  const tags = ['prtg', `prtg:${mapped.key}`];
  if (group) tags.push(`group:${clip(group, 40)}`);

  return {
    externalId,
    eventType: `prtg.${mapped.key}`,
    severity,
    status: mapped.status,
    host,
    ipAddress,
    sensor,
    message: clip(message, 2000)!,
    occurredAt: toDate(p.datetime ?? p.date ?? p.timestamp ?? p.since),
    monitoringRef: deviceId,
    tags,
    group,
    probe,
    raw: payload,
  };
}

export const prtgAdapter: IntegrationAdapter = {
  type: 'prtg',
  label: 'PRTG Network Monitor',
  description: 'Sensor state notifications from PRTG (HTTP action). Down/Warning create incidents, Up resolves them.',
  refField: 'monitoringRef',
  parse: (payload) => parsePrtgEvent(payload),
  samplePayload: {
    sensorid: '2345',
    deviceid: '2001',
    device: 'fw-01',
    host: '10.1.1.1',
    name: 'Ping',
    status: 'Down',
    message: 'Request timed out (ICMP error # 11010)',
    priority: '*****',
    datetime: '02.10.2026 14:03:12',
    laststatus: 'Up',
    down: '5 m',
    group: 'Customer A',
    probe: 'Local Probe',
  },
  defaultRules: { domain: 'noc', defaultCategoryKey: 'availability', assignTeamKey: 'noc', titleTemplate: '{{host}}: {{sensor}} {{statusText}}' },
  docs: `### Configure PRTG

1. In PRTG open **Setup → Account Settings → Notification Templates** and add a template, e.g. *ITSM webhook*.
2. Enable **Execute HTTP Action** and set:
   * **URL**: \`{{webhookUrl}}?key={{apiKey}}\` (PRTG cannot send custom headers, so the API key travels as a query parameter; use HTTPS)
   * **HTTP method**: \`POST\`
   * **Payload** (form-encoded, one line):
     \`sensorid=%sensorid&deviceid=%deviceid&device=%device&host=%host&name=%name&status=%status&message=%message&priority=%priority&datetime=%datetime&laststatus=%laststatus&down=%down&group=%group&probe=%probe\`
3. Under **Notification Triggers** of the root group (inherited by all sensors) add a **State Trigger**: *When sensor is Down for at least 60 seconds perform ITSM webhook* and *When sensor is Up again perform ITSM webhook*. The "Up" notification is what resolves tickets automatically.
4. Optional: add a trigger for the **Warning** state and give important sensors a higher **priority** (stars) – 5 stars map to P1, 4 to P2, 3 to P3.

Set the **device id** of a PRTG device on the matching CI (*Monitoring reference*) for exact correlation; otherwise events are matched by IP address or hostname and the reference is learned automatically.`,
};
