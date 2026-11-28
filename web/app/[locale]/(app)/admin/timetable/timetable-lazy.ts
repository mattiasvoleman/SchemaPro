import { lazy } from "react";

/*
 * The timetable page's code-split pieces, in a module of their own: the page
 * is the route that carries the most JavaScript in the app, and what its first
 * load does not need is fetched here when it is asked for. React's own lazy(),
 * not next/dynamic — see the first comment below.
 *
 * Six of them are `let`, and exported as live bindings: a lazy() keeps a
 * rejected fetch for good, so retrying takes a new wrapper, and the page reads
 * the binding again on its next render (resetLessonDialogs, resetLessonTimePanel,
 * resetSelectionBar, resetRoomOptimizationDialog, resetVersionsDialog,
 * resetSwapDialog). Kept at module level between failures so a later visit in
 * the same tab renders the already resolved ones without suspending.
 */
/*
 * Fetched when the school asks to optimise rooms, not when the page loads.
 *
 * This page carries the most JavaScript in the app, and the dialog is the one
 * part of it a school opens rarely: a grundschema is set once a term, and the
 * rooms are redistributed after that. Its code took the route's own initial JS
 * from 190.1KB to 191.9KB gzipped, past the 190KB admin budget — the same
 * reasoning lib/pdf.ts already applies to jspdf, which it imports inside the
 * export function rather than at the top of the module.
 *
 * React's own lazy(), not next/dynamic — here and for the two splits below.
 * next/dynamic brings its loader runtime (BailoutToCSR, PreloadChunks,
 * loadable) into the route, 1.4KB gzipped, most of what the splits save; and
 * once the people page stopped sharing that runtime it sat in a chunk of its
 * own here and compressed worse, 190.0 -> 190.1KB, past the budget by the
 * decimal. React is in every route already, so lazy() costs nothing on top.
 * No lazy component is reachable during SSR: every *Used latch below
 * (confirm, edit, create, suggest, versions, rooms, publish) is false at first
 * render, and each lazy dialog is mounted only behind its latch. The
 * selection's bar is drawn once the lessons are read, which they are not at
 * first render either.
 */
const lazyRoomOptimizationDialog = () =>
  lazy(() =>
    import("@/components/schedule/room-optimization-dialog").then((module) => ({
      default: module.RoomOptimizationDialog,
    })),
  );
export let RoomOptimizationDialog = lazyRoomOptimizationDialog();
/** A fresh wrapper after the fetch failed or the dialog threw while it drew; the page reads the binding again. */
export function resetRoomOptimizationDialog(): void {
  RoomOptimizationDialog = lazyRoomOptimizationDialog();
}
/*
 * Fetched the first time Versioner is pressed, like the room optimisation
 * dialog above and for its reason: the version diff is most of the dialog's
 * code, and nothing on the grid needs it (see versions-dialog.tsx).
 */
const lazyVersionsDialog = () =>
  lazy(() =>
    import("@/components/schedule/versions-dialog").then((module) => ({
      default: module.VersionsDialog,
    })),
  );
export let VersionsDialog = lazyVersionsDialog();
export function resetVersionsDialog(): void {
  VersionsDialog = lazyVersionsDialog();
}
/*
 * Byten och flyttar, fetched the first time "Föreslå byten" is pressed in
 * Justera: the swap search is asked a few times a day and the grid needs none
 * of its code (see swap-dialog.tsx).
 */
const lazySwapDialog = () =>
  lazy(() =>
    import("@/components/schedule/swap-dialog").then((module) => ({
      default: module.SwapDialog,
    })),
  );
export let SwapDialog = lazySwapDialog();
export function resetSwapDialog(): void {
  SwapDialog = lazySwapDialog();
}
/*
 * The lesson dialogs — Lägg till, Justera, Publicera and the shared-move and
 * placement questions after a drag — fetched as one chunk right after the page
 * mounts (see components/schedule/lesson-dialogs.ts for why one). Justera,
 * Publicera and the two questions used to be written out at the bottom of this
 * page; with them went the route's whole copy of @radix-ui/react-dialog, the
 * Switch and the date picker, none of which the grid draws on load. The two
 * draft types are imported as types only, which brings no code with them.
 */
export const loadLessonDialogs = () => import("@/components/schedule/lesson-dialogs");
/*
 * Made by a function, and made again when one fails: lazy() keeps a rejected
 * fetch for good and rethrows it on every later render, so retrying a chunk
 * that did not arrive takes new lazy() wrappers (see lessonDialogsFailed in the
 * page). Kept at module level between failures so a later visit in the same
 * tab renders the already resolved ones without suspending.
 */
const lazyLessonDialogs = () => ({
  CreateLessonDialog: lazy(() =>
    loadLessonDialogs().then((module) => ({ default: module.CreateLessonDialog })),
  ),
  LessonEditDialog: lazy(() =>
    loadLessonDialogs().then((module) => ({ default: module.LessonEditDialog })),
  ),
  PublishReviewDialog: lazy(() =>
    loadLessonDialogs().then((module) => ({ default: module.PublishReviewDialog })),
  ),
  PublicationBadge: lazy(() =>
    loadLessonDialogs().then((module) => ({ default: module.PublicationBadge })),
  ),
  SharedMoveDialog: lazy(() =>
    loadLessonDialogs().then((module) => ({ default: module.SharedMoveDialog })),
  ),
  SuggestPlacementsDialog: lazy(() =>
    loadLessonDialogs().then((module) => ({ default: module.SuggestPlacementsDialog })),
  ),
  ConflictList: lazy(() => loadLessonDialogs().then((module) => ({ default: module.ConflictList }))),
  TrayHead: lazy(() => loadLessonDialogs().then((module) => ({ default: module.TrayHead }))),
  TrayPanel: lazy(() => loadLessonDialogs().then((module) => ({ default: module.TrayPanel }))),
  FillHead: lazy(() => loadLessonDialogs().then((module) => ({ default: module.FillHead }))),
});
export let lessonDialogs = lazyLessonDialogs();
/** A fresh set after a dialog failed to load or draw; the page reads `lessonDialogs` again. */
export function resetLessonDialogs(): void {
  lessonDialogs = lazyLessonDialogs();
}
/*
 * Lektionstid — schemalagt mot planerat for the groups in view — fetched on
 * the first press of its button, with the layer-2 module and the week
 * arithmetic it brings (components/timplan/schedule-delta-panel.tsx). Made
 * again after a failed fetch, for the reason lazyLessonDialogs is.
 */
const lazyLessonTime = () =>
  lazy(() =>
    import("@/components/timplan/schedule-delta-panel").then((module) => ({
      default: module.ScheduleDeltaPanel,
    })),
  );
export let LessonTimePanel = lazyLessonTime();
export function resetLessonTimePanel(): void {
  LessonTimePanel = lazyLessonTime();
}
/*
 * The selection's bar (components/schedule/selection-bar.tsx), from the lesson
 * dialogs' chunk but with a lazy() of its own: a dialog that fails to load
 * remakes lazyLessonDialogs, and a bar on screen would go with it. Made again
 * after its own failed fetch, for the reason lazyLessonDialogs is.
 */
const lazySelectionBar = () =>
  lazy(() => loadLessonDialogs().then((module) => ({ default: module.SelectionBar })));
export let SelectionBar = lazySelectionBar();
export function resetSelectionBar(): void {
  SelectionBar = lazySelectionBar();
}
