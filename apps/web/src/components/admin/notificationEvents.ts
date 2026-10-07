/**
 * Notification events are named `<group>.<what>` (`ticket.created`, `sla.breached`).
 * The group is what the rules and templates pages filter on, so both pages read it
 * and its label from here.
 */
export const eventGroup = (event: string) => event.split('.')[0] ?? event;

const GROUP_LABELS: Record<string, string> = {
  ticket: 'Tickets',
  request: 'Requests',
  change: 'Changes',
  incident: 'Major incidents',
  sla: 'SLA',
  contract: 'Contracts',
  entitlement: 'Entitlements',
  pm: 'Preventive maintenance',
  field_visit: 'Field visits',
  licence: 'Licences',
  software: 'Software',
  report: 'Reports',
  user: 'Accounts',
  page: 'On-call pages',
  handover: 'Shift handover',
  briefing: 'Daily briefing',
  announcement: 'Announcements',
  kedb: 'Known errors',
  cab: 'CAB',
};

/** A readable label for an event group ("Field visits", "SLA"); an unknown group reads as its key with spaces. */
export const eventGroupLabel = (group: string) => GROUP_LABELS[group] ?? group.charAt(0).toUpperCase() + group.slice(1).replace(/_/g, ' ');

/** The select options for the groups present in a list of events, in alphabetical order of the key. */
export const eventGroupOptions = (events: string[]) => [...new Set(events.map(eventGroup))].sort().map((g) => ({ value: g, label: eventGroupLabel(g) }));

export const CHANNEL_LABELS: Record<string, string> = { email: 'Email', in_app: 'In-app', whatsapp: 'WhatsApp' };
export const channelLabel = (channel: string) => CHANNEL_LABELS[channel] ?? channel;
