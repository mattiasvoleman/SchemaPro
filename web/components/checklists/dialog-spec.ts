import type { ConsentAsked, ConsentKind } from "@/lib/checklists";

/**
 * Which dialog is open and what it needs: one slot per tab (use-dialogs.tsx),
 * since the dialogs are fetched on the first click and not with the page.
 */
export type DialogSpec =
  /** Void a tick. `label` names it ("Ada Berg, 3 okt. 2026"). */
  | { kind: "void"; proofId: string; label: string }
  /** One pupil's card: every tick, voided ones too, and the consents. */
  | { kind: "card"; studentId: string; name: string }
  /** Write an answer down for the pupils. */
  | { kind: "entry"; listId: string; entryKind: ConsentKind; studentIds: string[]; onDone: (written: number) => void }
  /** Ask the guardians through Kvittens; `studentIds` null asks every pupil with no answer, `count` of them. */
  | { kind: "ask"; listId: string; studentIds: string[] | null; count: number; onDone: (asked: ConsentAsked) => void }
  /** End the list. */
  | { kind: "close"; listId: string; title: string; onDone: () => void };
