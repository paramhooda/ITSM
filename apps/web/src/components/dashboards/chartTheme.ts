/** Categorical slots (validated reference palette, light surface). Fixed order, never cycled past 8. */
const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
/** Status colours are reserved for state (good/warning/serious/critical) and always paired with a label. */
export const STATUS_COLORS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' } as const;

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
  grid: '#eceff4',
  axis: '#c3cad6',
  text: '#67758a',
  surface: '#ffffff',
  tooltip: { background: '#ffffff', border: '#e6e9ef', color: '#0b1a33' },
};

export function useChartTheme(): ChartTheme {
  return LIGHT;
}

/** Option colour names (config_options.color) → chart hex, matching the badge palette. */
const OPTION_HEX: Record<string, string> = {
  red: '#e34948', orange: '#eb6834', amber: '#eda100', yellow: '#eda100', green: '#008300', emerald: '#1baf7a',
  teal: '#1baf7a', cyan: '#2a78d6', sky: '#2a78d6', blue: '#2a78d6', indigo: '#4a3aa7', violet: '#4a3aa7', purple: '#4a3aa7',
  rose: '#e87ba4', lime: '#008300', slate: '#97a3b5', gray: '#97a3b5',
};
export const optionHex = (color: string | null | undefined, _dark: boolean, fallback: string) => (color && OPTION_HEX[color] ? OPTION_HEX[color] : fallback);
