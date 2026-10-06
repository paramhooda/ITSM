import { z } from 'zod';
import { inArray } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';

/**
 * The assistant's WhatsApp settings: one read per inbound message (no cache, so
 * an administrator's change applies to the next message). Every field falls
 * back to its default when the stored value is malformed.
 */

export const inboundQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  phone: z.string().max(30).optional(),
  outcome: z.string().max(20).optional(),
});
export type InboundQuery = z.infer<typeof inboundQuery>;

export const DEFAULT_GREETING = 'Hi {{name}}, this is Grady from {{platform}}. Ask me about tickets, services, visits and approvals; when I propose a change, reply YES to go ahead or NO to drop it.';
export const DEFAULT_UNLINKED_REPLY = 'This number is not linked to a {{platform}} account. Sign in, open Profile & preferences and link your WhatsApp number to chat here.';

export const ASSISTANT_SETTING_KEYS = ['whatsapp.assistant.enabled', 'whatsapp.assistant.audiences', 'whatsapp.assistant.daily_message_cap', 'whatsapp.assistant.thread_idle_hours', 'whatsapp.assistant.greeting', 'whatsapp.assistant.unlinked_reply', 'whatsapp.display_number'] as const;

export const AUDIENCES = ['staff', 'customers'] as const;
export type Audience = (typeof AUDIENCES)[number];

export const assistantSettingsSchema = z.object({
  enabled: z.boolean().catch(false),
  audiences: z.array(z.enum(AUDIENCES)).min(1).catch([...AUDIENCES]),
  dailyMessageCap: z.number().int().min(1).max(2000).catch(100),
  /** 0 lets a test force a fresh thread per message; the administrator's validation keeps 1-168. */
  threadIdleHours: z.number().int().min(0).max(168).catch(24),
  greeting: z.string().min(10).max(500).catch(DEFAULT_GREETING),
  unlinkedReply: z.string().min(10).max(500).catch(DEFAULT_UNLINKED_REPLY),
  displayNumber: z.string().max(30).catch(''),
});
export type AssistantSettings = z.infer<typeof assistantSettingsSchema>;

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = assistantSettingsSchema.parse({});

export async function loadAssistantSettings(tx: Tx): Promise<AssistantSettings> {
  const rows = await tx.select({ key: schema.systemSettings.key, value: schema.systemSettings.value }).from(schema.systemSettings).where(inArray(schema.systemSettings.key, [...ASSISTANT_SETTING_KEYS]));
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const raw = {
    enabled: get('whatsapp.assistant.enabled'),
    audiences: get('whatsapp.assistant.audiences'),
    dailyMessageCap: get('whatsapp.assistant.daily_message_cap'),
    threadIdleHours: get('whatsapp.assistant.thread_idle_hours'),
    greeting: get('whatsapp.assistant.greeting'),
    unlinkedReply: get('whatsapp.assistant.unlinked_reply'),
    displayNumber: typeof get('whatsapp.display_number') === 'string' ? (get('whatsapp.display_number') as string).trim() : '',
  };
  const parsed = assistantSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_ASSISTANT_SETTINGS;
}

/** Staff chat when `staff` is listed; portal users when `customers` is. */
export const audienceAllowed = (settings: AssistantSettings, userType: 'msp' | 'customer') => settings.audiences.includes(userType === 'customer' ? 'customers' : 'staff');
