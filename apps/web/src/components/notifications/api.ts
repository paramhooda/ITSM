import { get, post, put, patch } from '@/api/client';

/** One row of the person's preference matrix (mirror of the API's MatrixRow). */
export interface MatrixRow {
  key: string;
  label: string;
  description: string;
  email: { on: boolean; default: boolean; locked: boolean };
  whatsapp: { on: boolean; default: boolean; locked: boolean; available: boolean };
  inApp: true;
}

export interface PreferenceMatrix {
  audience: 'staff' | 'customer';
  rows: MatrixRow[];
  whatsapp: { channelEnabled: boolean; phone: string | null; optIn: boolean; verifiedAt: string | null };
}

export type PrefChannel = 'email' | 'whatsapp';
export type PrefRows = Record<string, { email?: boolean; whatsapp?: boolean }>;

/** A notification_categories row: the administrator's default and lock per channel (labels and audience come from NOTIFICATION_CATEGORIES). */
export interface CategoryRow {
  id: string;
  key: string;
  emailDefault: boolean;
  emailLocked: boolean;
  whatsappDefault: boolean;
  whatsappLocked: boolean;
  sortOrder: number;
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}
export type CategoryPatch = Partial<Pick<CategoryRow, 'emailDefault' | 'emailLocked' | 'whatsappDefault' | 'whatsappLocked'>>;

export interface VerifyStart {
  method: 'sent';
  sentTo: string;
  expiresAt: string;
}

/** The `typed` method: the code is shown once and the person sends it from their phone to the business number. */
export interface VerifyStartTyped {
  method: 'typed';
  code: string;
  phone: string;
  expiresAt: string;
  businessNumber: string | null;
  /** wa.me link with the code prefilled, when the display number is set. */
  waLink: string | null;
}

export const notificationPrefsApi = {
  matrix: () => get<PreferenceMatrix>('/notifications/preferences'),
  update: (rows: PrefRows) => put<PreferenceMatrix>('/notifications/preferences', { rows }),
  verifyStart: () => post<VerifyStart>('/notifications/phone/verify/start', { method: 'sent' }),
  verifyStartTyped: () => post<VerifyStartTyped>('/notifications/phone/verify/start', { method: 'typed' }),
  verifyConfirm: (code: string) => post<PreferenceMatrix>('/notifications/phone/verify/confirm', { code }),
  categories: () => get<CategoryRow[]>('/config/notification-categories'),
  updateCategory: (id: string, body: CategoryPatch) => patch<CategoryRow>(`/config/notification-categories/${id}`, body),
};

export const notificationPrefsKeys = {
  matrix: ['notifications', 'preferences'] as const,
  categories: ['config', 'notification-categories'] as const,
};
