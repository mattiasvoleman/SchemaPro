"use client";

// Client-side undo/redo command stack for timetable editing.
//
// Every edit is registered as a pair of async inverse operations. Undo/redo
// replays them through the normal gateway mutations, so server-side conflict
// validation and the audit trail still apply to every step.
//
// Created lessons get fresh ids when an undone creation is redone; the
// `IdRef` indirection keeps later entries in the chain pointing at the
// current id.

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * What a step was about, as data: the list of the session's steps says it in words (components/schedule/versions-dialog.tsx, which is fetched the first time
 * Versioner is pressed), so the words are not in the code of the page. A step without it is named by its label.
 */
export type HistoryMeta =
  | { what: "update"; lesson: HistoryLesson; patch: object }
  | { what: "create" | "delete"; lesson: HistoryLesson }
  | { what: "bulk-lock"; locked: boolean; count: number }
  | { what: "bulk-delete"; count: number }
  | { what: "block-move"; name: string; dayOfWeek: number; startTime: string; endTime: string }
  | { what: "block-lock"; name: string; locked: boolean }
  | { what: "lunch"; kind: "place" | "move" | "remove"; dayOfWeek: number; startTime: string };

/** The lesson a step is about: what names it ("Matematik 7A"). */
export interface HistoryLesson {
  subjectId: string;
  studentGroupId: string;
  extraGroupIds?: readonly string[];
  /** Where it stood, which a change that names only a clock is about. */
  dayOfWeek?: number;
  startTime?: string;
  endTime?: string;
  /** What the lesson held of the fields a save can change (a step is given the lesson as it stood), so that the list says only what the step changed. */
  roomId?: string | null;
  teacherId?: string | null;
  isLocked?: boolean;
  isParked?: boolean;
  recurrence?: string;
  startDate?: string | null;
  endDate?: string | null;
}

/** Mutable holder so undo/redo closures survive id changes across recreates. */
export interface IdRef {
  id: string;
}

export interface HistoryEntry {
  /** Short human label, e.g. "move", "create" — used in toasts. */
  label: string;
  /** What the step was about, for the list of the session's steps (E9). */
  meta?: HistoryMeta;
  /** When it was taken (`push` says it): the list shows the clock. */
  at?: number;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /**
   * Whether an error of `undo` is the gateway's final no (the judge refused to put the lesson back, E1): then the step is dropped, stays
   * as it is and cannot be redone, and the next undo takes the step before it. Left on top, a refusal that is the same every time would
   * shut every older step behind it. Absent, or false for the error (the network, a 5xx): the step stays on top for a retry.
   */
  refusedUndo?: (error: unknown) => boolean;
}

export interface ScheduleHistory {
  push: (entry: HistoryEntry) => void;
  /**
   * The session's steps as they stand: the ones done, oldest first, and the ones undone, in the order a redo takes them (E9). `lost` is how many
   * steps have left the history without being undone (the oldest, past the depth the history keeps, and one that could not be undone for good, see
   * `refusedUndo`): what they did stands, and the first of the done steps is then not where the session began.
   */
  steps: () => { done: readonly HistoryEntry[]; undone: readonly HistoryEntry[]; lost?: number };
  undo: () => Promise<HistoryEntry | null>;
  redo: () => Promise<HistoryEntry | null>;
  canUndo: boolean;
  canRedo: boolean;
  clear: () => void;
}

const MAX_DEPTH = 100;

export function useScheduleHistory(): ScheduleHistory {
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const busy = useRef(false);
  const lost = useRef(0);
  const [, bump] = useState(0);
  const refresh = () => bump((n) => n + 1);

  const push = useCallback((entry: HistoryEntry) => {
    entry.at ??= Date.now();
    undoStack.current.push(entry);
    if (undoStack.current.length > MAX_DEPTH) {
      undoStack.current.shift();
      lost.current++;
    }
    redoStack.current = [];
    refresh();
  }, []);

  const undo = useCallback(async (): Promise<HistoryEntry | null> => {
    const entry = undoStack.current[undoStack.current.length - 1];
    if (!entry || busy.current) return null;
    busy.current = true;
    try {
      await entry.undo();
      undoStack.current.pop();
      redoStack.current.push(entry);
      return entry;
    } catch (error) {
      if (entry.refusedUndo?.(error)) {
        undoStack.current.pop();
        lost.current++;
      }
      throw error;
    } finally {
      busy.current = false;
      refresh();
    }
  }, []);

  const redo = useCallback(async (): Promise<HistoryEntry | null> => {
    const entry = redoStack.current[redoStack.current.length - 1];
    if (!entry || busy.current) return null;
    busy.current = true;
    try {
      await entry.redo();
      redoStack.current.pop();
      undoStack.current.push(entry);
      return entry;
    } finally {
      busy.current = false;
      refresh();
    }
  }, []);

  const steps = useCallback(() => ({ done: [...undoStack.current], undone: [...redoStack.current].reverse(), lost: lost.current }), []);

  const clear = useCallback(() => {
    undoStack.current = [];
    redoStack.current = [];
    lost.current = 0;
    refresh();
  }, []);

  return {
    push,
    steps,
    undo,
    redo,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    clear,
  };
}

/**
 * Binds Ctrl/Cmd+Z (undo) and Ctrl/Cmd+Shift+Z or Ctrl+Y (redo). A failed
 * operation is routed to `onError` (the entry stays replayable on its stack)
 * and never escapes as an unhandled rejection — the toolbar buttons catch the
 * same failure and report it, so the shortcut must not be the one path that
 * fails silently.
 */
export function useHistoryKeyboard(
  history: Pick<ScheduleHistory, "undo" | "redo">,
  onDone?: (kind: "undo" | "redo", entry: HistoryEntry | null) => void,
  onError?: (kind: "undo" | "redo", error: unknown) => void,
): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;

      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        void history.undo().then(
          (entry) => onDone?.("undo", entry),
          (error) => onError?.("undo", error),
        );
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        void history.redo().then(
          (entry) => onDone?.("redo", entry),
          (error) => onError?.("redo", error),
        );
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [history, onDone, onError]);
}
