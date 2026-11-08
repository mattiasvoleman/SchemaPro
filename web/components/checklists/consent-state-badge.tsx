import { Ban, CircleCheck, CircleHelp, Hourglass, Undo2, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CONSENT_STATE_VARIANT } from "@/lib/status-variants";
import type { ConsentState } from "@/lib/checklists";

/*
 * Each state has its own icon as well as its words: the colour is never the
 * only carrier (a no and a consent taken back are both destructive, and the
 * words and the shapes tell them apart).
 */
const ICON: Record<ConsentState, LucideIcon> = {
  GRANTED: CircleCheck,
  DECLINED: Ban,
  WITHDRAWN: Undo2,
  ASKED: Hourglass,
  MISSING: CircleHelp,
};

/** A pupil's consent as a badge: an icon and the state in words. `label` is the words (from the messages). */
export function ConsentStateBadge({ state, label }: { state: ConsentState; label: string }) {
  const Icon = ICON[state];
  return (
    <Badge variant={CONSENT_STATE_VARIANT[state]} data-state={state} className="gap-1 whitespace-nowrap">
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {label}
    </Badge>
  );
}
