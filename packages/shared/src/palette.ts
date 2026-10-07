/**
 * The validated chart palette, shared by the printed report documents and the
 * dashboards so a series wears the same colour on paper and on screen. Every
 * data colour was checked with the palette validator on a white surface
 * (lightness band, chroma floor, colour vision deficiency separation); brand
 * colours are never used as data colours.
 *
 * Rules the charts follow: categorical hues are assigned in this fixed order
 * and never cycled (at most six slices, then "Other"); magnitude uses the
 * single-hue sequential ramp; the status scale is reserved for state (always
 * paired with a label or an icon) and is never reused as a series colour;
 * numbers and labels print in the text tokens, never in the series colour.
 */

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

/** How many categorical slices a donut or a legend shows before the rest folds into "Other". */
export const MAX_SLICES = 6;
