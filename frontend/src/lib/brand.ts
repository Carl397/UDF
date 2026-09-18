/**
 * UDF brand design tokens — professional corporate system.
 * Primary red + ink black (per the party logo), clean neutral surfaces.
 * The protest-era gold is retired; CTAs and accents are red.
 */
export const brand = {
  red: '#C8102E',
  redDark: '#A00D24',
  redDeep: '#7C0A1B',
  redTint: '#FBECEE',
  black: '#141414',
  ink: '#1C1917',
  white: '#FFFFFF',
  gray: '#57534E',
  grayLight: '#F6F3F1',
} as const;

/** Reusable gradient washes built on the brand palette. */
export const gradients = {
  heroRed: `linear-gradient(150deg, ${brand.red} 0%, ${brand.redDark} 60%, ${brand.redDeep} 100%)`,
  ctaRed: `linear-gradient(140deg, ${brand.red} 0%, ${brand.redDark} 100%)`,
  darkCard: `linear-gradient(160deg, #1E1E1E 0%, ${brand.black} 100%)`,
} as const;

export const radius = { sm: 10, md: 14, lg: 20, pill: 999 } as const;

export const shadow = {
  card: '0 1px 2px rgba(28,25,23,0.06), 0 2px 8px rgba(28,25,23,0.05)',
  cta: '0 8px 20px rgba(200,16,46,0.30)',
  lift: '0 6px 20px rgba(28,25,23,0.10)',
} as const;
