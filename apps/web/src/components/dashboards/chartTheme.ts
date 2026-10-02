/** Categorical slots (validated with the dataviz palette checks on a white surface). Fixed order, never cycled past 8. */
const SERIES_LIGHT = ['#2563eb', '#f97316', '#0f9d6f', '#eda100', '#c026d3', '#1a7f37', '#6d28d9', '#e11d48'];
/** Status colours are reserved for state (good/warning/serious/critical) and always paired with a label. */
export const STATUS_COLORS = { good: '#16a34a', warning: '#f59e0b', serious: '#ea580c', critical: '#dc2626' } as const;

export interface ChartTheme {
  dark: boolean;
  series: string[];
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
