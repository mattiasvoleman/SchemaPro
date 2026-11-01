import React, { type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { READABLE_MAX } from './responsive';

/**
 * A centred column inside a full-width ScrollView: the content stops at
 * `max`, the scroll area does not, so a swipe in the margin still scrolls.
 * On a phone it is the whole width, as before.
 */
export function Column({ max = READABLE_MAX, style, children }: {
  readonly max?: number;
  readonly style?: StyleProp<ViewStyle>;
  readonly children: ReactNode;
}): React.JSX.Element {
  return <View style={[{ width: '100%', maxWidth: max, alignSelf: 'center' }, style]}>{children}</View>;
}
