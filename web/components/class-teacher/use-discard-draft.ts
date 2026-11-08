"use client";

import { useState } from "react";
import { toast } from "sonner";
import { problemOf, type ChangeProblem, type ChangeView } from "@/lib/class-teacher";
import { useClassTeacherActions } from "@/lib/class-teacher-queries";
import { useClassTeacherText } from "./use-class-teacher-text";

/**
 * Throws a draft away, held to the revision the writer read: a draft somebody
 * else changed since is a 409 (CLASS_TEACHER_REV), which is said beside the
 * draft and leaves it where it is, the week having been read again.
 */
export function useDiscardDraft(classId: string) {
  const { t } = useClassTeacherText();
  const { discard } = useClassTeacherActions(classId);
  const [problems, setProblems] = useState<Record<string, ChangeProblem>>({});

  const run = async (draft: ChangeView): Promise<boolean> => {
    if (discard.isPending) return false;
    setProblems(({ [draft.id]: _cleared, ...rest }) => rest);
    try {
      await discard.mutateAsync({ id: draft.id, rev: draft.rev });
      toast.success(t("drafts.discarded"));
      return true;
    } catch (error) {
      setProblems((current) => ({ ...current, [draft.id]: problemOf(error) }));
      return false;
    }
  };

  return {
    run,
    /** The id of the draft being discarded now, if any. */
    pendingId: discard.isPending ? (discard.variables?.id ?? null) : null,
    problems,
    clear: (id: string) => setProblems(({ [id]: _cleared, ...rest }) => rest),
  };
}
