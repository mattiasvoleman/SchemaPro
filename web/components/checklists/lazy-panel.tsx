"use client";

import { Component, Suspense, lazy, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { useChecklistsText } from "./use-checklists-text";

/*
 * A part of the page that is fetched when it is drawn and not with the page:
 * the Samtycken tab (nobody needs it until its tab is opened) and the
 * administrator's Mallar (a teacher never draws it, and a teacher's page is
 * the tighter budget). Unlike the dialogs, which are fetched on a click and
 * try again on the next one, these are drawn by the page itself, so a chunk that
 * does not arrive is said where the part would have been, with a button that
 * tries again: never a retry of its own, which would loop on a chunk that
 * keeps failing.
 */

/** A lazy component, and the way to make it afresh: a lazy component that failed once stays failed. */
export function useLazy<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  const [Part, setPart] = useState(() => lazy(load));
  return [Part, () => setPart(() => lazy(load))] as const;
}

/**
 * False while the page is rendered on the server and hydrated, true after.
 * A lazy part is drawn only then: the server has no data to draw it with, and
 * by the time its chunk has arrived a sibling has fetched what it reads, so
 * a part drawn during hydration is drawn from the cache where the server's
 * html shows it loading (a hydration mismatch, and the part drawn again).
 * Server and first client render both show the skeleton instead.
 */
const noSubscription = () => () => {};
function useDrawnInBrowser(): boolean {
  return useSyncExternalStore(noSubscription, () => true, () => false);
}

class FailureBoundary extends Component<{ failed: (retry: () => void) => ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.failed(() => this.setState({ failed: false })) : this.props.children;
  }
}

/** Draws `children` (a lazy component) with a skeleton while it is fetched and, if it cannot be, a notice with a button; `again` makes the lazy component afresh. */
export function LazyPanel({ again, height = "h-32", children }: { again: () => void; height?: string; children: ReactNode }) {
  const { t, tCommon } = useChecklistsText();
  const inBrowser = useDrawnInBrowser();
  const skeleton = (
    <div aria-busy="true">
      <Skeleton className={`${height} w-full`} />
    </div>
  );
  return (
    <FailureBoundary
      failed={(retry) => (
        <LoadError
          variant="inline"
          title={t("panelLoadFailed")}
          hint={t("panelLoadFailedHint")}
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                again();
                retry();
              }}
            >
              {tCommon("retry")}
            </Button>
          }
        />
      )}
    >
      {inBrowser ? <Suspense fallback={skeleton}>{children}</Suspense> : skeleton}
    </FailureBoundary>
  );
}
