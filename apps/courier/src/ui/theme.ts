import { useColorScheme } from 'react-native';

/**
 * The "Night Drive" look: dark by night and light by day, following the phone's setting. Both
 * palettes have the same keys, so every screen reads its colours from `useTheme()`.
 */
export interface Palette {
  readonly scheme: 'light' | 'dark';
  /** Behind everything. */
  readonly background: string;
  /** Cards and sheets. */
  readonly surface: string;
  /** Inputs, secondary buttons and chips. */
  readonly raised: string;
  readonly border: string;
  readonly text: string;
  readonly muted: string;
  readonly primary: string;
  readonly primaryText: string;
  /** The status panel behind the home screen and the job header. */
  readonly hero: string;
  readonly heroText: string;
  readonly heroMuted: string;
  readonly danger: string;
  readonly dangerSurface: string;
  readonly warning: string;
  readonly warningSurface: string;
  readonly success: string;
  readonly successSurface: string;
  /** Cold-chain blue: the temperature strip and chilled or frozen chips. */
  readonly cold: string;
  readonly coldSurface: string;
  readonly coldStrip: string;
  readonly coldStripText: string;
  readonly shadow: string;
}

export const lightPalette: Palette = {
  scheme: 'light',
  background: '#F3F5F3',
  surface: '#FFFFFF',
  raised: '#EAEFEC',
  border: '#D9E0DC',
  text: '#121A16',
  muted: '#5B6A62',
  primary: '#0B6E4F',
  primaryText: '#FFFFFF',
  hero: '#0B6E4F',
  heroText: '#FFFFFF',
  heroMuted: '#BFE3D2',
  danger: '#B42318',
  dangerSurface: '#FDECEA',
  warning: '#8A5300',
  warningSurface: '#FFF4E0',
  success: '#0B6E4F',
  successSurface: '#E2F2EA',
  cold: '#0F5FA6',
  coldSurface: '#E3EFFA',
  coldStrip: '#0F5FA6',
  coldStripText: '#FFFFFF',
  shadow: '#0A1A12',
};

export const darkPalette: Palette = {
  scheme: 'dark',
  background: '#0E1311',
  surface: '#171E1B',
  raised: '#232D29',
  border: '#2E3A35',
  text: '#EEF3F0',
  muted: '#93A69D',
  primary: '#2BD48F',
  primaryText: '#03140C',
  hero: '#121916',
  heroText: '#EEF3F0',
  heroMuted: '#93A69D',
  danger: '#FF7A6E',
  dangerSurface: '#3A1714',
  warning: '#FFB547',
  warningSurface: '#33240C',
  success: '#2BD48F',
  successSurface: '#12301F',
  cold: '#7CCBFF',
  coldSurface: '#13283A',
  coldStrip: '#13283A',
  coldStripText: '#CDEBFF',
  shadow: '#000000',
};

export const space = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;
export const radius = { sm: 10, md: 14, lg: 22, pill: 999 } as const;
export const text = {
  caption: 12,
  small: 13,
  body: 15,
  label: 16,
  title: 20,
  heading: 26,
  display: 40,
} as const;

/** The palette for the phone's light or dark setting. */
export function useTheme(): Palette {
  return useColorScheme() === 'dark' ? darkPalette : lightPalette;
}

/** Styles built from the palette, rebuilt only when the phone switches between light and dark. */
export function makeStyles<T>(build: (palette: Palette) => T): () => T {
  const cache = new Map<Palette, T>();
  return function useStyles() {
    const palette = useTheme();
    let styles = cache.get(palette);
    if (!styles) {
      styles = build(palette);
      cache.set(palette, styles);
    }
    return styles;
  };
}
