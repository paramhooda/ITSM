import { inArray } from 'drizzle-orm';
import { PENDING_REASON_MODES, REJECTED_CHANGE_MODES, REJECTION_NOTE_MODES, TRANSITION_PROFILE_KEYS, type PendingReasonMode, type RejectedChangeMode, type RejectionNoteMode, type TransitionProfile } from '@itsm/shared';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';

/**
 * The lifecycle rules an administrator may change (the six `tickets.*` and
 * `approvals.*` settings below). Every default reproduces the ServiceNow base;
 * the shipped strictness survives as a value. The Settings page route does not
 * validate values, so every loader falls back to the default on an unknown or
 * malformed one. This file imports nothing from the ticket services: `status.ts`,
 * `service.ts`, `approvals.ts`, the CAB and the assistant's tools all read it.
 */

export const LIFECYCLE_SETTING_KEYS = {
  transitionRules: 'tickets.transition_rules',
  pendingReasonRequired: 'tickets.pending_reason_required',
  cancelCommentRequired: 'tickets.cancel_comment_required',
  reopenCommentRequired: 'tickets.reopen_comment_required',
  rejectedChange: 'approvals.rejected_change',
  rejectionNoteRequired: 'approvals.rejection_note_required',
} as const;

export interface LifecycleSettings {
  /** Which status moves the lifecycle allows: strict (the shipped matrix), standard (the ServiceNow base), loose (only Closed is final). */
  transitionRules: TransitionProfile;
  /** When putting a ticket on hold needs a written reason: customer (only when the customer is waited on), always, never. */
  pendingReasonRequired: PendingReasonMode;
  /** Staff must give a reason to cancel a ticket. */
  cancelCommentRequired: boolean;
  /** Staff must give a reason to reopen a resolved, closed or cancelled ticket. */
  reopenCommentRequired: boolean;
  /** What a rejected change becomes: return (back to Draft with the note posted) or rejected (ends as Rejected). */
  rejectedChange: RejectedChangeMode;
  /** Who must give a note when rejecting an approval: none, portal (customer approvers), all (staff too). */
  rejectionNoteRequired: RejectionNoteMode;
}

export const DEFAULT_LIFECYCLE_SETTINGS: LifecycleSettings = {
  transitionRules: 'standard',
  pendingReasonRequired: 'customer',
  cancelCommentRequired: false,
  reopenCommentRequired: false,
  rejectedChange: 'return',
  rejectionNoteRequired: 'portal',
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], def: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : def);
const bool = (v: unknown, def: boolean): boolean => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : def);

/** The six lifecycle settings with their defaults (one select; an unset or malformed value falls back). */
export async function loadLifecycleSettings(tx: Tx): Promise<LifecycleSettings> {
  const rows = await tx.select({ key: schema.systemSettings.key, value: schema.systemSettings.value }).from(schema.systemSettings).where(inArray(schema.systemSettings.key, Object.values(LIFECYCLE_SETTING_KEYS)));
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const d = DEFAULT_LIFECYCLE_SETTINGS;
  return {
    transitionRules: oneOf(get(LIFECYCLE_SETTING_KEYS.transitionRules), TRANSITION_PROFILE_KEYS, d.transitionRules),
    pendingReasonRequired: oneOf(get(LIFECYCLE_SETTING_KEYS.pendingReasonRequired), PENDING_REASON_MODES, d.pendingReasonRequired),
    cancelCommentRequired: bool(get(LIFECYCLE_SETTING_KEYS.cancelCommentRequired), d.cancelCommentRequired),
    reopenCommentRequired: bool(get(LIFECYCLE_SETTING_KEYS.reopenCommentRequired), d.reopenCommentRequired),
    rejectedChange: oneOf(get(LIFECYCLE_SETTING_KEYS.rejectedChange), REJECTED_CHANGE_MODES, d.rejectedChange),
    rejectionNoteRequired: oneOf(get(LIFECYCLE_SETTING_KEYS.rejectionNoteRequired), REJECTION_NOTE_MODES, d.rejectionNoteRequired),
  };
}

/** Whether a wait on `waitingOn` needs a written reason under the setting (a customer wait: the reason is the message the customer reads). */
export function reasonRequired(settings: Pick<LifecycleSettings, 'pendingReasonRequired'>, waitingOn: string | null | undefined): boolean {
  switch (settings.pendingReasonRequired) {
    case 'always':
      return true;
    case 'never':
      return false;
    default:
      return waitingOn === 'customer';
  }
}

/** Whether this decider must give a note to reject (the portal: the note is the reply the requester reads; `all` holds staff to it too). */
export function rejectionNoteRequired(settings: Pick<LifecycleSettings, 'rejectionNoteRequired'>, customerUser: boolean): boolean {
  switch (settings.rejectionNoteRequired) {
    case 'none':
      return false;
    case 'all':
      return true;
    default:
      return customerUser;
  }
}
