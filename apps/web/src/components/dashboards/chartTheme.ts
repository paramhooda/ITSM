import { CATEGORICAL, DEEMPHASIS, SEQUENTIAL, ORDINAL } from '@itsm/shared';

/**
 * Categorical slots: the brand blue keeps slot 1 (so every existing single-series
 * chart looks as it did) and the rest follow the validated shared palette
 * (`packages/shared/src/palette.ts`, the same hues the report documents print)
 * in its fixed order. Slots are assigned in sequence and never cycled: a chart
 * with more categories than slots folds the rest into "Other" in the
 * de-emphasis gray.
 */
const SERIES_LIGHT = ['#2563eb', ...CATEGORICAL.slice(1)];
/** Status colours are reserved for state (good/warning/serious/critical), always paired with a label, never reused as a series colour. */
export const STATUS_COLORS = { good: '#16a34a', warning: '#f59e0b', serious: '#ea580c', critical: '#dc2626' } as const;

export interface ChartTheme {
  dark: boolean;
  series: string[];
  /** Single-hue ramp for magnitude (heatmaps), light to dark; zero cells use the surface. */
  sequential: readonly string[];
  /** Ordered discrete marks (age buckets), light to dark. */
  ordinal: readonly string[];
  /** The gray every folded or de-emphasised mark wears. */
  deemphasis: string;
  grid: string;
  axis: string;
  text: string;
  surface: string;
  tooltip: { background: string; border: string; color: string };
}

/** The product ships a single light theme. */
export function useIsDark() {
  return false;
}

const LIGHT: ChartTheme = {
  dark: false,
  series: SERIES_LIGHT,
  sequential: SEQUENTIAL,
  ordinal: ORDINAL,
  deemphasis: DEEMPHASIS,
  grid: '#f0f0f1',
  axis: '#d4d4d8',
  text: '#71717a',
  surface: '#ffffff',
  tooltip: { background: '#ffffff', border: '#e4e4e7', color: '#09090b' },
};

export function useChartTheme(): ChartTheme {
  return LIGHT;
}

/** Option colour names (config_options.color) → chart hex, matching the badge palette. */
const OPTION_HEX: Record<string, string> = {
  red: '#e11d48', orange: '#f97316', amber: '#eda100', yellow: '#eda100', green: '#1a7f37', emerald: '#0f9d6f',
  teal: '#0f9d6f', cyan: '#2563eb', sky: '#2563eb', blue: '#2563eb', indigo: '#6d28d9', violet: '#6d28d9', purple: '#c026d3',
  rose: '#e11d48', lime: '#1a7f37', slate: '#a1a1aa', gray: '#a1a1aa',
};
export const optionHex = (color: string | null | undefined, _dark: boolean, fallback: string) => (color && OPTION_HEX[color] ? OPTION_HEX[color] : fallback);
