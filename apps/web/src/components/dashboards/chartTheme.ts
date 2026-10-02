import { useEffect, useState } from 'react';

/** Categorical slots (validated reference palette, light/dark steps). Fixed order, never cycled past 8. */
const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
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

function readDark() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

/** Tracks the app theme (`.dark` on <html>) so charts re-colour when the user toggles. */
export function useIsDark() {
  const [dark, setDark] = useState(readDark);
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(readDark()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

export function useChartTheme(): ChartTheme {
  const dark = useIsDark();
  return dark
    ? { dark, series: SERIES_DARK, grid: '#223047', axis: '#64748b', text: '#96a3b8', surface: '#111a2b', tooltip: { background: '#172238', border: '#223047', color: '#e5eaf2' } }
    : { dark, series: SERIES_LIGHT, grid: '#e3e6eb', axis: '#94a3b8', text: '#64748b', surface: '#ffffff', tooltip: { background: '#ffffff', border: '#e3e6eb', color: '#0f172a' } };
}

/** Option colour names (config_options.color) → chart hex, matching the badge palette. */
const OPTION_HEX: Record<string, [string, string]> = {
  red: ['#e34948', '#e66767'], orange: ['#eb6834', '#d95926'], amber: ['#eda100', '#c98500'], yellow: ['#eda100', '#c98500'], green: ['#008300', '#008300'], emerald: ['#1baf7a', '#199e70'],
  teal: ['#1baf7a', '#199e70'], cyan: ['#2a78d6', '#3987e5'], sky: ['#2a78d6', '#3987e5'], blue: ['#2a78d6', '#3987e5'], indigo: ['#4a3aa7', '#9085e9'], violet: ['#4a3aa7', '#9085e9'], purple: ['#4a3aa7', '#9085e9'],
  rose: ['#e87ba4', '#d55181'], lime: ['#008300', '#008300'], slate: ['#94a3b8', '#64748b'], gray: ['#94a3b8', '#64748b'],
};
export const optionHex = (color: string | null | undefined, dark: boolean, fallback: string) => (color && OPTION_HEX[color] ? OPTION_HEX[color][dark ? 1 : 0] : fallback);
