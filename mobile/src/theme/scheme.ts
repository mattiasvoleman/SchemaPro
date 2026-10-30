import type { ColorSchemeName } from 'react-native';
import type { SchemeName } from './tokens';

/**
 * The phone's appearance as one of the two palettes. iOS 13+ and Android 10+
 * answer 'light' or 'dark' under userInterfaceStyle "automatic"; an older
 * Android, which has no dark mode, answers 'light', and 'unspecified' or no
 * answer at all means the system has no preference, which is light.
 */
export function schemeOf(raw: ColorSchemeName | null | undefined): SchemeName {
  return raw === 'dark' ? 'dark' : 'light';
}
