/**
 * Design tokens of the printed report document: a light theme of its own
 * (the application UI never uses the brand navy and red), the validated chart
 * palette and the type scale. Every data colour below was checked with the
 * palette validator on a white surface (lightness band, chroma floor, colour
 * vision deficiency separation); brand colours are never used as data colours.
 */

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

/** Categorical slots, fixed order, assigned in sequence, never cycled (validated). */
export const CATEGORICAL = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'] as const;
/** The gray every non-emphasised mark wears when one category is singled out. */
export const DEEMPHASIS = '#c3c2b7';
/** Sequential blue ramp for heatmaps (near-zero to dark); zero cells use the surface. */
export const SEQUENTIAL = ['#cde2fb', '#9ec5f4', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b'] as const;
/** Ordinal ramp (discrete ordered marks such as age buckets). */
export const ORDINAL = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281'] as const;
export const DIVERGING = { negative: '#e34948', mid: '#f0efec', positive: '#2a78d6' } as const;
/** Status scale, fixed, always paired with an icon or a label. */
export const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' } as const;
/** Delta text colours (contrast safe on white). */
export const DELTA_TEXT = { good: '#006300', bad: '#d03b3b', neutral: '#52514e' } as const;
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
