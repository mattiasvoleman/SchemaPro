import React from 'react';
import { Text, View, type ColorValue } from 'react-native';

/**
 * A tab's glyph, and under the selected tab's a short bar in its colour.
 *
 * The selected tab is in the accent and the others in muted ink, each
 * legible on the bar (theme/contrast.test.ts), but the two differ from each
 * other by little (about 1.1:1 in light and 1.4:1 in dark), so colour alone
 * would not say which tab is open (WCAG 1.4.1). The bar does, in both
 * appearances. Glyph, gap and bar fit the tab bar's 28 pt icon slot.
 */
export function TabGlyph({
  glyph,
  color,
  focused,
}: {
  readonly glyph: string;
  readonly color: ColorValue;
  readonly focused: boolean;
}): React.JSX.Element {
  return (
    <View style={{ alignItems: 'center' }}>
      <Text style={{ fontSize: 18, lineHeight: 22, color }}>{glyph}</Text>
      <View style={{ width: 16, height: 2, borderRadius: 1, marginTop: 2, backgroundColor: focused ? color : 'transparent' }} />
    </View>
  );
}
