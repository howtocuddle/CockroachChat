/**
 * Design tokens.
 *
 * Constraints that are not aesthetic preferences:
 *
 *   - Contrast is a safety feature. This gets used outdoors, in daylight, at
 *     speed, possibly by someone who is frightened. Every text/background pair
 *     below has been measured, not eyeballed, and clears WCAG AA at its
 *     intended size — most clear AAA. If you change a value here, re-measure.
 *     The tightest pairs, and therefore the ones to re-check first, are
 *     textFaint on surfaceRaised (4.53:1) and danger.onFill on danger.fill
 *     (4.54:1). Nothing in here has slack; there is no "just a shade lighter".
 *   - Dark is the default. It costs less battery on OLED and is far less
 *     visible to the person standing behind you.
 *   - Status colour is never the only signal. Every state also carries a word,
 *     because colour alone fails for colour-blind users and in bright sun.
 *   - Tone is a scale of loudness, not a palette. `danger` is meant to be
 *     unmissable, `caution` to be read, `ok` to be quiet. A mode with weaker
 *     confidentiality must never render calmer than one with stronger.
 */

import { Platform } from 'react-native';

/**
 * A tone is the full recipe for rendering one confidence level, so a screen
 * never has to improvise a "slightly darker red" and drift out of contrast.
 *
 *   fg     — tone-coloured text on `bg` or `surface`
 *   fill   — a solid band; the loudest thing available
 *   onFill — text on `fill`
 *   tint   — a barely-there wash for a notice that must be read but not shouted
 *   edge   — border for `tint`, and the hairline that marks a toned container
 */
export type ToneColors = {
  fg: string;
  fill: string;
  onFill: string;
  tint: string;
  edge: string;
};

const dark = {
  // Not pure black: pure black against an OLED's off pixels makes text edges
  // bloom, and the near-black still reads as black in a dark square.
  bg: '#0B0B0D',
  surface: '#141417',
  surfaceRaised: '#1D1D22',
  surfaceSunken: '#08080A',
  border: '#2A2A31',
  borderStrong: '#4A4A56',

  text: '#F6F6F8',
  textMuted: '#A6A6B0',
  textFaint: '#84848E',

  bubbleIn: '#1D1D22',
  bubbleOut: '#2E5FC3',
  onBubbleOut: '#FFFFFF',

  accent: '#7FB0FF',
  accentFill: '#2F6FE4',
  onAccentFill: '#FFFFFF',

  // Kept as flat aliases because "green means connected" is referenced by name
  // in a dozen places and renaming it buys nothing.
  green: '#4ADE8B',
  amber: '#FFC061',
  red: '#FF7B7B',
  blue: '#7FB0FF',

  tone: {
    danger: {
      fg: '#FF7B7B',
      fill: '#D93A3F',
      onFill: '#FFFFFF',
      tint: '#2B1214',
      edge: '#A84348',
    },
    caution: {
      fg: '#FFC061',
      fill: '#FFB020',
      onFill: '#1B1200',
      tint: '#2A2010',
      edge: '#9C7524',
    },
    ok: {
      fg: '#4ADE8B',
      fill: '#17794A',
      onFill: '#FFFFFF',
      tint: '#10241A',
      edge: '#357F58',
    },
  } satisfies Record<string, ToneColors>,
};

const light = {
  bg: '#FFFFFF',
  surface: '#F5F5F7',
  surfaceRaised: '#EBEBEF',
  surfaceSunken: '#EFEFF2',
  border: '#D9D9E0',
  borderStrong: '#A8A8B4',

  text: '#0B0B0D',
  textMuted: '#55555F',
  textFaint: '#63636C',

  bubbleIn: '#EBEBEF',
  bubbleOut: '#1B57BE',
  onBubbleOut: '#FFFFFF',

  accent: '#1656C7',
  accentFill: '#1656C7',
  onAccentFill: '#FFFFFF',

  green: '#0B7A43',
  amber: '#8A5200',
  red: '#C0272D',
  blue: '#1656C7',

  tone: {
    danger: {
      fg: '#C0272D',
      fill: '#B21F25',
      onFill: '#FFFFFF',
      tint: '#FDECEC',
      edge: '#BF7A7C',
    },
    caution: {
      fg: '#8A5200',
      fill: '#7A4800',
      onFill: '#FFFFFF',
      tint: '#FFF3E0',
      edge: '#BC8E45',
    },
    ok: {
      fg: '#0B7A43',
      fill: '#0A6B3B',
      onFill: '#FFFFFF',
      tint: '#E6F6EC',
      edge: '#6BB48C',
    },
  } satisfies Record<string, ToneColors>,
};

export type Theme = typeof dark;

export const Colors: { dark: Theme; light: Theme } = { dark, light };

export type ToneName = keyof Theme['tone'];

// ---------------------------------------------------------------------------
// Rhythm

/**
 * One vertical scale, used everywhere. Steps are far enough apart that picking
 * the wrong one is visible, which is the point — it keeps the layout honest.
 */
export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const Radius = {
  sm: 8,
  md: 12,
  lg: 18,
  xl: 24,
  pill: 999,
} as const;

/** Minimum comfortable tap target. Non-negotiable — this is used one-handed. */
export const TAP_TARGET = 52;

export const Fonts = Platform.select({
  ios: { sans: 'system-ui', mono: 'ui-monospace', rounded: 'ui-rounded' },
  default: { sans: 'normal', mono: 'monospace', rounded: 'normal' },
})!;

// ---------------------------------------------------------------------------
// Type

/**
 * A real scale, not four weights of the same size. The jumps between adjacent
 * steps are large enough to establish hierarchy at arm's length in sunlight;
 * line heights are generous because long safety sentences are the norm here,
 * not the exception.
 */
export const Type = {
  /** Reserved for the status banner headline — the one question users have. */
  display: { fontSize: 32, fontWeight: '700' as const, letterSpacing: -0.8, lineHeight: 38 },
  hero: { fontSize: 27, fontWeight: '700' as const, letterSpacing: -0.6, lineHeight: 33 },
  title: { fontSize: 22, fontWeight: '700' as const, letterSpacing: -0.3, lineHeight: 28 },
  heading: { fontSize: 19, fontWeight: '600' as const, letterSpacing: -0.2, lineHeight: 25 },
  body: { fontSize: 17, fontWeight: '400' as const, lineHeight: 25 },
  bodyStrong: { fontSize: 17, fontWeight: '600' as const, lineHeight: 25 },
  callout: { fontSize: 15, fontWeight: '400' as const, lineHeight: 22 },
  calloutStrong: { fontSize: 15, fontWeight: '600' as const, lineHeight: 22 },
  caption: { fontSize: 13, fontWeight: '400' as const, lineHeight: 18 },
  /** Section eyebrows. Uppercase at the call site, tracked out to stay legible. */
  label: { fontSize: 12, fontWeight: '700' as const, letterSpacing: 1.1, lineHeight: 16 },
  /** Status words next to a colour. Never smaller than this. */
  micro: { fontSize: 12, fontWeight: '700' as const, letterSpacing: 0.4, lineHeight: 16 },
} as const;

// ---------------------------------------------------------------------------
// Motion

/**
 * Calm and fast. Nothing overshoots and nothing bounces — this is a tool people
 * open when they are frightened, and playful motion reads as a toy.
 *
 * Every animation built on these must also respect `useMotion()`, which returns
 * false when the OS asks for reduced motion.
 */
export const Duration = {
  fast: 130,
  base: 220,
  slow: 380,
  /** One half-cycle of the "still searching" pulse. Slow enough to read as breathing. */
  pulse: 1400,
} as const;
