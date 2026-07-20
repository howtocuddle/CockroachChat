import { useReducedMotion } from 'react-native-reanimated';

/**
 * Whether decorative motion is allowed to run.
 *
 * Reanimated reads the platform setting on both iOS ("Reduce Motion") and
 * Android ("Remove animations"), so there is one answer for both.
 *
 * Every animation in this app is decorative — it emphasises a state that is
 * already stated in words and colour. So when this returns false the correct
 * behaviour is to render the *settled* frame immediately, never to hide the
 * information the animation was decorating.
 */
export function useMotion(): boolean {
  return !useReducedMotion();
}
