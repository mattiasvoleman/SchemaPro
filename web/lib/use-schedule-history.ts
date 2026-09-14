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

/** Mutable holder so undo/redo closures survive id changes across recreates. */
export interface IdRef {
  id: string;
}

export interface HistoryEntry {
  /** Short human label, e.g. "move", "create" — used in toasts. */
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

export interface ScheduleHistory {
  push: (entry: HistoryEntry) => void;
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
  const [, bump] = useState(0);
  const refresh = () => bump((n) => n + 1);

  const push = useCallback((entry: HistoryEntry) => {
    undoStack.current.push(entry);
    if (undoStack.current.length > MAX_DEPTH) undoStack.current.shift();
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

  const clear = useCallback(() => {
    undoStack.current = [];
    redoStack.current = [];
    refresh();
  }, []);

  return {
    push,
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
