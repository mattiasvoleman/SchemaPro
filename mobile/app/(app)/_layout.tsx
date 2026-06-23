import React from 'react';
import { Slot } from 'expo-router';

/**
 * Protected app shell.
 * Navigation guards are handled by AuthGate in the root _layout.tsx,
 * so this layout only needs to render the active child route.
 */
export default function AppLayout(): React.JSX.Element {
  return <Slot />;
}
