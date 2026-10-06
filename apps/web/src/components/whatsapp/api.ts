import { get, post, del } from '@/api/client';

/** GET /whatsapp/link: the signed-in person's own state (the number is masked by the API). */
export interface LinkStatus {
  phone: string | null;
  verifiedAt: string | null;
  assistant: { on: boolean; enabled: boolean; allowed: boolean; reason: string | null };
  pending: { method: 'sent' | 'typed'; expiresAt: string } | null;
  businessNumber: string | null;
  waLink: string | null;
}

/** The four states of the profile card (keys of WHATSAPP_LINK_COLORS). */
export type LinkState = 'linked' | 'verified' | 'pending' | 'none';
export const linkStateOf = (s: Pick<LinkStatus, 'verifiedAt' | 'assistant' | 'pending'>): LinkState => (s.verifiedAt ? (s.assistant.on ? 'linked' : 'verified') : s.pending ? 'pending' : 'none');

export interface Finding {
  level: 'ok' | 'warn' | 'error';
  text: string;
}

/** GET /whatsapp/assistant/status: readiness, counts and the saved settings. */
export interface AssistantStatus {
  enabled: boolean;
  ready: boolean;
  checks: Finding[];
  linkedUsers: number;
  verifiedUsers: number;
  inboundToday: number;
  repliedToday: number;
  failedToday: number;
  settings: { enabled: boolean; audiences: string[]; dailyMessageCap: number; threadIdleHours: number; greeting: string; unlinkedReply: string; displayNumber: string; appSecretSet: boolean; webhookUrl: string };
}

/** One row of the inbound log (GET /whatsapp/inbound); the number is masked, the text is an excerpt. */
export interface InboundRow {
  id: string;
  receivedAt: string;
  handledAt: string | null;
  phone: string;
  displayName: string | null;
  user: { id: string; name: string; userType: 'msp' | 'customer' } | null;
  kind: string;
  text: string | null;
  status: string;
  outcome: string | null;
  error: string | null;
  reply: { status: string; deliveryStatus: string | null; lastError: string | null } | null;
  conversationId: string | null;
}
export interface InboundQuery {
  limit?: number;
  phone?: string;
  outcome?: string;
}

/** Plain labels for whatsapp_inbound.outcome. */
export const INBOUND_OUTCOME_LABELS: Record<string, string> = {
  replied: 'Replied',
  linked: 'Linked',
  started: 'Chat on (START)',
  stopped: 'Chat off (STOP)',
  unverified: 'Unverified',
  chat_off: 'Chat off',
  feature_off: 'Switched off',
  audience: 'Not allowed',
  unsupported: 'Unsupported',
  throttled: 'Throttled',
  cap: 'Daily cap',
  inactive: 'Inactive account',
  ignored: 'Ignored',
  failed: 'Failed',
};

export const whatsappApi = {
  link: () => get<LinkStatus>('/whatsapp/link'),
  turnOn: () => post<{ on: boolean }>('/whatsapp/link', {}),
  turnOff: () => del<{ on: boolean }>('/whatsapp/link'),
  assistantStatus: () => get<AssistantStatus>('/whatsapp/assistant/status'),
  inbound: (q: InboundQuery = {}) => get<{ items: InboundRow[] }>('/whatsapp/inbound', { ...q }),
  revokeUser: (id: string) => post<{ ok: true }>(`/iam/users/${id}/whatsapp/unlink`, {}),
  revokePortalUser: (id: string) => post<{ ok: true }>(`/portal/users/${id}/whatsapp/unlink`, {}),
};

export const whatsappKeys = {
  link: ['whatsapp', 'link'] as const,
  status: ['whatsapp', 'assistant', 'status'] as const,
  inbound: (q: InboundQuery = {}) => ['whatsapp', 'inbound', q] as const,
};
