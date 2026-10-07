import { CATEGORICAL, DEEMPHASIS, SEQUENTIAL, ORDINAL, DIVERGING, STATUS, DELTA_TEXT } from '@itsm/shared';

/**
 * Design tokens of the printed report document: a light theme of its own
 * (the application UI never uses the brand navy and red) and the type scale.
 * The validated chart palette lives in the shared package
 * (`packages/shared/src/palette.ts`) so the dashboards draw the same colours;
 * it is re-exported here for the document renderer. Brand colours are never
 * used as data colours.
 */

export { CATEGORICAL, DEEMPHASIS, SEQUENTIAL, ORDINAL, DIVERGING, STATUS, DELTA_TEXT };

export const DOC = {
  ink: '#09090b',
  ink2: '#3f3f46',
  muted: '#71717a',
  subtle: '#a1a1aa',
  surface: '#ffffff',
  surface2: '#fafafa',
  surface3: '#f4f4f5',
  border: '#e4e4e7',
  borderStrong: '#d4d4d8',
  /** Brand defaults, overridden by platform.brand_color / platform.brand_accent. */
  navy: '#292345',
  red: '#ee3137',
  gridline: '#e4e4e7',
  baseline: '#d4d4d8',
  axisText: '#71717a',
  font: `"Geist Variable", "Liberation Sans", "DejaVu Sans", Helvetica, Arial, sans-serif`,
} as const;

export const TYPE = { body: '10.5pt', small: '9pt', caption: '8pt', h1: '30pt', h2: '15pt', h3: '11.5pt', tile: '20pt', hero: '36pt' } as const;

/** Series keys that carry a status meaning on charts flagged `statusSeries`. */
export const STATUS_SERIES: Record<string, string> = {
  met: STATUS.good,
  completed: STATUS.good,
  good: STATUS.good,
  resolved: STATUS.good,
  implemented: STATUS.good,
  compliant: STATUS.good,
  breached: STATUS.critical,
  failed: STATUS.critical,
  missed: STATUS.critical,
  backed_out: STATUS.critical,
  expired: STATUS.critical,
  critical: STATUS.critical,
  warning: STATUS.warning,
  expiring: STATUS.warning,
  open: STATUS.warning,
  // the five survey ratings, by their meaning (1-2 critical, 3 warning, 4-5 good)
  very_dissatisfied: STATUS.critical,
  dissatisfied: STATUS.critical,
  neutral: STATUS.warning,
  satisfied: STATUS.good,
  very_satisfied: STATUS.good,
};
