import { z } from 'zod';
import { NOTIFICATION_CATEGORY_KEYS } from '@itsm/shared';
import { normalizePhone } from '@/lib/channels';
import { myPreferences, updateMyPreferences, checkCell, type MatrixRow, type PrefChannel } from '@/modules/notifications/preferences';
import { maskPhone } from '@/modules/notifications/phone';
import { define, type PreviewDetail } from './types';

/**
 * The person's own notification preferences: what reaches them by email and
 * WhatsApp per category, and one cell switched on or off by sentence. Both
 * tools act for the signed-in person only (staff and portal users alike);
 * nobody's preferences can be read or changed on their behalf. Nothing here
 * calls the model.
 */

const CHANNEL_LABEL: Record<PrefChannel, string> = { email: 'Email', whatsapp: 'WhatsApp' };

const rowView = (r: MatrixRow) => ({
  key: r.key,
  label: r.label,
  email: r.email.on,
  whatsapp: r.whatsapp.available ? r.whatsapp.on : null,
  locked: [r.email.locked ? 'email' : null, r.whatsapp.locked ? 'whatsapp' : null].filter((x): x is string => !!x),
});

const masked = (phone: string | null) => (phone ? maskPhone(normalizePhone(phone) ?? phone) : null);

export const NOTIFICATION_PREFS: ReturnType<typeof define>[] = [
  define({
    name: 'my_notification_preferences',
    toolset: 'profile',
    description: 'The user\'s own notification preferences: which categories reach them by email and by WhatsApp, which rows the administrator locked (always on), and the state of their mobile number (WhatsApp opt-in, verified or not). Answers "what do I get on WhatsApp", "am I getting SLA emails", "what notifications do I receive", "is my number verified". Read-only: set_notification_preference changes a cell.',
    inputSchema: z.object({}),
    requires: [],
    portal: ['portal:access'],
    action: false,
    run: async (ctx) => {
      const m = await myPreferences(ctx);
      const rows = m.rows.map(rowView);
      const emailOn = rows.filter((r) => r.email).length;
      const whatsappOn = rows.filter((r) => r.whatsapp === true).length;
      const phone = masked(m.whatsapp.phone);
      const facts = [
        `${rows.length} notification categories: email on for ${emailOn}, WhatsApp on for ${whatsappOn}`,
        `WhatsApp ${m.whatsapp.optIn ? 'on' : 'off'} on ${phone ?? 'no number'} (${m.whatsapp.verifiedAt ? 'verified' : 'not verified'})`,
        ...(m.whatsapp.channelEnabled ? [] : ['WhatsApp is not set up on this platform, so no WhatsApp message goes out']),
        'In-app notifications are always on',
      ];
      return { audience: m.audience, whatsapp: { optIn: m.whatsapp.optIn, verified: !!m.whatsapp.verifiedAt, verifiedAt: m.whatsapp.verifiedAt, phoneMasked: phone, channelEnabled: m.whatsapp.channelEnabled }, rows, facts, link: '/profile' };
    },
    summary: (_input, result) => `Listed notification preferences (${(result as { rows: unknown[] }).rows.length} rows)`,
  }),

  define({
    name: 'set_notification_preference',
    toolset: 'profile',
    description: 'Switch one notification category on or off for the user on one channel, email or WhatsApp: "stop WhatsApp for SLA warnings", "email me about surveys", "turn off contract emails". One category and one channel per call; in-app notifications are always on. Rows the administrator locked cannot be switched off, WhatsApp needs the opted-in mobile number, and the daily briefing row changes the briefing card\'s email channel.',
    inputSchema: z.object({
      category: z.enum(NOTIFICATION_CATEGORY_KEYS).describe('Row of the matrix, e.g. sla, tickets, approvals, feedback, contracts'),
      channel: z.enum(['email', 'whatsapp']),
      enabled: z.boolean(),
    }),
    requires: [],
    portal: ['portal:access'],
    action: true,
    tier: 'write_low',
    invalidates: ['preferences'],
    run: async (ctx, input) => {
      const m = await updateMyPreferences(ctx, { rows: { [input.category]: { [input.channel]: input.enabled } } });
      const row = m.rows.find((r) => r.key === input.category);
      const label = row?.label ?? input.category;
      return { category: input.category, label, channel: input.channel, enabled: input.enabled, facts: [`${label}: ${CHANNEL_LABEL[input.channel]} ${input.enabled ? 'on' : 'off'}`], link: '/profile' };
    },
    summary: (input, result) => `${(result as { label?: string } | undefined)?.label ?? input.category}: ${input.channel} ${input.enabled ? 'on' : 'off'}`,
    preview: async (ctx, input): Promise<PreviewDetail> => {
      const m = await myPreferences(ctx);
      const row = checkCell(m.rows, input.category, input.channel, input.enabled, m.whatsapp.optIn);
      const other: PrefChannel = input.channel === 'email' ? 'whatsapp' : 'email';
      const lines = [
        other === 'whatsapp' && !row.whatsapp.available ? null : `${CHANNEL_LABEL[other]} stays ${row[other].on ? 'on' : 'off'}`,
        'In-app notifications are always on',
      ].filter((x): x is string => !!x);
      return { text: `Turn ${CHANNEL_LABEL[input.channel]} ${input.enabled ? 'on' : 'off'} for "${row.label}"`, lines };
    },
  }),
];
