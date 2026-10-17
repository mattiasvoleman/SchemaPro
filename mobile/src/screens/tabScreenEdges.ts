import type { Edge } from 'react-native-safe-area-context';

/**
 * The safe-area edges a tab screen pads itself. The bottom belongs to the tab
 * bar, which already pads by the bottom inset. safe-area-context's
 * SafeAreaView pads by the provider's insets rather than by where the view
 * sits, so with the bottom edge too it would add that inset a second time,
 * as an empty strip above the tab bar (the home indicator's height on a Face
 * ID iPhone, the navigation bar's on an edge-to-edge Android phone).
 */
export const TAB_SCREEN_EDGES: readonly Edge[] = ['top', 'left', 'right'];
