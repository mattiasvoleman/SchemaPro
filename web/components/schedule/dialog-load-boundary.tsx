"use client";

import { Component, type ReactNode } from "react";

/*
 * Catches what a lazily fetched dialog throws while it renders — above all a
 * chunk that did not arrive — and hands it to the page instead of letting it
 * climb to the root, where Next draws its client-exception screen over the
 * whole page (the app has no error.tsx). It draws nothing once it has caught:
 * the page reports the error, closes the dialogs and remounts this boundary
 * under a new key, so the next open fetches again.
 */
export class DialogLoadBoundary extends Component<
  { onError: (error: unknown) => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
