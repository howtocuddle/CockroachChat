import { useColorScheme } from 'react-native';

import { Colors, type Theme } from '@/constants/theme';

export function useTheme(): Theme {
  // Dark is the default: it costs less battery and is less visible over your
  // shoulder. Light is used only when the OS explicitly asks for it.
  return useColorScheme() === 'light' ? Colors.light : Colors.dark;
}

/**
 * Some decisions differ between schemes beyond a colour swap — a scrim that
 * darkens on dark and lightens on light, for instance. Those need to know
 * which scheme they are in, not just which tokens they got.
 */
export function useIsDark(): boolean {
  return useColorScheme() !== 'light';
}
